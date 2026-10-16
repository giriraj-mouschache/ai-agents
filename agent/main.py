"""Entry point: python -m agent.main [--dry-run] [--topic NAME] [--test-email]"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from .config import load_config
from .emailer import Digest, make_subject, render_html, render_text, send_email
from .history import IST, record_run
from .llm import LLMClient
from .research import Item, TopicResult, make_tldr, run_topic
from . import scout, weekly
from .alerts import build_alerts, write_alerts
from .settings import apply_settings, load_settings
from .store import SeenStore

log = logging.getLogger("agent")

EMAIL_RE = re.compile(r"^[^@\s,;<>\"']+@[^@\s,;<>\"']+\.[^@\s,;<>\"']+$")


def _send_demo(args) -> int:
    """Send a sample digest (plus an LLM health check) to verify Gmail and the LLM key end to end."""
    env = dict(os.environ)
    to = (args.to or "").strip()
    if to:
        if not EMAIL_RE.match(to):
            log.error("--to is not a valid email address")
            return 2
        env["MAIL_TO"] = to

    cfg = load_config(args.config)
    llm = LLMClient(cfg)
    if llm.available:
        try:
            llm.chat("You are a connectivity check.", "Reply with the single word OK.", json_mode=False, max_tokens=64)
            check = f"LLM check passed: the API answered ({', '.join(b.name for b in llm.backends)} configured)."
        except Exception as exc:  # report any failure in the email instead of crashing
            check = f"LLM check FAILED: {str(exc)[:160]}"
    else:
        check = "LLM check skipped: no LLM API key found."

    sample = [
        Item("Demo", "Sample finding: how an item looks in your digest", "https://example.com/sample-1",
             "This is placeholder text. Real digests contain 2-3 sentence summaries of pages the agent read.",
             "Real digests explain why each item matters for the topic goal you set.", 9),
        Item("Demo", "Sample finding: items below your min_score are left out", "https://example.com/sample-2",
             "Only items the LLM scores at or above min_score make it into the email.", "", 7),
    ]
    digest = Digest(
        date=datetime.now(IST).strftime("%Y-%m-%d"),
        tldr=["Demo email from your research agent: Gmail SMTP works.", check],
        sections=[TopicResult("Sample topic (demo, not real results)", sample)],
    )
    send_email("Research agent - demo email", render_html(digest), render_text(digest), env=env)
    log.info("Demo email sent. %s", check)
    return 0


def _load_dotenv(path: str = ".env") -> None:
    """Minimal .env loader for local runs (does not override real environment variables)."""
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scheduled web-research agent")
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--topic", action="append", help="Only run topics with this name (repeatable)")
    parser.add_argument("--data-dir", help="Folder holding settings.json, state/ and site/ (the 'data' branch checkout)")
    parser.add_argument("--dry-run", action="store_true", help="Write out/digest.html instead of emailing; state is not saved")
    parser.add_argument("--test-email", action="store_true", help="Send a sample demo email (with an LLM health check) and exit")
    parser.add_argument("--to", help="Recipient for --test-email (defaults to MAIL_TO or GMAIL_USER)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    _load_dotenv()

    if args.test_email:
        return _send_demo(args)

    cfg = load_config(args.config)
    mail_env = dict(os.environ)
    settings = None
    if args.data_dir:
        data = Path(args.data_dir)
        settings = load_settings(data / "settings.json")
        apply_settings(cfg, settings)
        cfg["state"]["path"] = str(data / "state" / "seen.json")
        cfg["site"]["data_dir"] = str(data / "site")
        if settings["email"]["to"]:
            mail_env["MAIL_TO"] = settings["email"]["to"]
    kind = os.environ.get("GITHUB_EVENT_NAME", "local")
    repo = os.environ.get("GITHUB_REPOSITORY", "")

    def record_failure(error: str) -> None:
        if args.dry_run:
            return
        try:
            record_run(cfg["site"]["data_dir"], cfg, Digest(date=datetime.now(IST).strftime("%Y-%m-%d")),
                       status="failed", emailed=False, llm_name=None, kind=kind, repo=repo, error=error)
        except OSError:
            log.exception("Could not write dashboard data")

    llm = LLMClient(cfg)
    if not llm.available:
        log.error("No LLM key found. Set at least one of GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY.")
        record_failure("NoLLMKey")
        return 2

    topics = cfg["topics"]
    if args.topic:
        wanted = {t.lower() for t in args.topic}
        topics = [t for t in topics if t["name"].lower() in wanted]
        if not topics:
            log.error("No topic matches %s", args.topic)
            return 2

    today = datetime.now(IST).strftime("%Y-%m-%d")
    store = SeenStore(cfg["state"]["path"], int(cfg["state"]["keep_days"]))

    results: list[TopicResult] = []
    errors: list[str] = []
    for topic in topics:
        try:
            results.append(run_topic(topic, cfg, llm, store, today))
        except Exception as exc:  # one bad topic must not sink the whole run
            log.exception("Topic '%s' failed", topic["name"])
            errors.append(f"{topic['name']}: {type(exc).__name__}: {str(exc)[:200]}")

    new_ideas: list[dict] = []
    if args.data_dir and settings and not args.dry_run and not args.topic:
        try:
            new_ideas = scout.run_scout(cfg, llm, Path(args.data_dir), settings, datetime.now(timezone.utc), today)
        except Exception:  # the scout is a bonus; it must never break the digest
            log.exception("Trend scout crashed")

    if any(r.llm_failed for r in results):
        why = "; ".join(dict.fromkeys(llm.failures))[:400] or "no details"
        errors.append(f"The AI step failed, so these results are unranked and unsummarised ({why}). Check the AI keys in GitHub secrets.")
    digest = Digest(date=today, sections=results, errors=errors, ideas=new_ideas)
    if cfg["email"]["tldr"] and digest.item_count:
        digest.tldr = make_tldr(llm, results, today)

    if args.dry_run:
        out = Path("out")
        out.mkdir(exist_ok=True)
        (out / "digest.html").write_text(render_html(digest), encoding="utf-8")
        (out / "digest.txt").write_text(render_text(digest), encoding="utf-8")
        log.info("Dry run: wrote out/digest.html (%d items, %d errors)", digest.item_count, len(errors))
        return 1 if errors and not results else 0

    emailed = False
    send_error: Exception | None = None
    if digest.item_count or errors or cfg["email"]["send_when_empty"]:
        try:
            send_email(make_subject(cfg["email"]["subject_prefix"], digest), render_html(digest), render_text(digest), env=mail_env)
            emailed = True
            log.info("Digest emailed (%d items)", digest.item_count)
        except Exception as exc:
            send_error = exc
            log.error("Sending the digest failed: %s", type(exc).__name__)
    else:
        log.info("Nothing new; no email sent")

    # Record the run for the dashboard, failures included, so a bad or missed day is visible there.
    status = "failed" if send_error else ("partial" if errors else "ok")
    entry = None
    try:
        entry = record_run(
            cfg["site"]["data_dir"],
            cfg,
            digest,
            status=status,
            emailed=emailed,
            llm_name=llm.last_backend,
            kind=kind,
            repo=repo,
            error=type(send_error).__name__ if send_error else "",
        )
    except OSError:
        log.exception("Could not write dashboard data")

    if send_error:
        raise send_error

    if args.data_dir and entry and status != "failed":
        try:
            write_alerts(Path(args.data_dir), entry["id"], build_alerts(digest, cfg["notify"], new_ideas))
        except OSError:
            log.exception("Could not write alerts")

    # Only remember URLs after the email went out, so a failed send is retried next run.
    for r in results:
        for url, title in r.to_mark:
            store.add(url, title)
    store.save()

    if args.data_dir and not errors and weekly.due_today(settings, Path(args.data_dir), datetime.now(timezone.utc)):
        _send_weekly(settings, Path(args.data_dir), mail_env)

    return 1 if errors and not results else 0


def _send_weekly(settings: dict, data: Path, env: dict) -> None:
    """Best effort: a failed weekly roundup must never fail the daily run."""
    now = datetime.now(timezone.utc)
    try:
        digest = weekly.build(data, now)
        if digest is None:
            log.info("Weekly roundup: nothing to include yet")
            return
        send_email(f"Weekly roundup - {digest.date} - {digest.item_count} top items", render_html(digest), render_text(digest), env=env)
        weekly.mark_sent(settings, data, now)
        log.info("Weekly roundup emailed (%d items)", digest.item_count)
    except Exception as exc:
        log.warning("Weekly roundup failed: %s", type(exc).__name__)


if __name__ == "__main__":
    sys.exit(main())
