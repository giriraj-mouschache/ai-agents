"""Entry point: python -m agent.main [--dry-run] [--topic NAME] [--test-email]"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .config import load_config
from .emailer import Digest, make_subject, render_html, render_text, send_email
from .llm import LLMClient
from .research import TopicResult, make_tldr, run_topic
from .store import SeenStore

log = logging.getLogger("agent")

IST = timezone(timedelta(hours=5, minutes=30))


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
    parser.add_argument("--dry-run", action="store_true", help="Write out/digest.html instead of emailing; state is not saved")
    parser.add_argument("--test-email", action="store_true", help="Send a short test email and exit")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    _load_dotenv()

    if args.test_email:
        digest = Digest(date=datetime.now(IST).strftime("%Y-%m-%d"), tldr=["Test email from your research agent. SMTP works."])
        send_email("Research agent - test email", render_html(digest), render_text(digest))
        log.info("Test email sent")
        return 0

    cfg = load_config(args.config)
    llm = LLMClient(cfg)
    if not llm.available:
        log.error("No LLM key found. Set at least one of GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY.")
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

    digest = Digest(date=today, sections=results, errors=errors)
    if cfg["email"]["tldr"] and digest.item_count:
        digest.tldr = make_tldr(llm, results, today)

    if args.dry_run:
        out = Path("out")
        out.mkdir(exist_ok=True)
        (out / "digest.html").write_text(render_html(digest), encoding="utf-8")
        (out / "digest.txt").write_text(render_text(digest), encoding="utf-8")
        log.info("Dry run: wrote out/digest.html (%d items, %d errors)", digest.item_count, len(errors))
        return 1 if errors and not results else 0

    if digest.item_count or errors or cfg["email"]["send_when_empty"]:
        send_email(make_subject(cfg["email"]["subject_prefix"], digest), render_html(digest), render_text(digest))
        log.info("Digest emailed (%d items)", digest.item_count)
    else:
        log.info("Nothing new; no email sent")

    # Only remember URLs after the email went out, so a failed send is retried next run.
    for r in results:
        for url, title in r.to_mark:
            store.add(url, title)
    store.save()

    return 1 if errors and not results else 0


if __name__ == "__main__":
    sys.exit(main())
