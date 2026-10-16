"""Setup check: tests Gmail login, each AI key and web search, and writes site/check.json for the dashboard.

Never sends mail and never prints secret values.  Usage: python -m agent.check --data-dir data
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import smtplib
import ssl
from datetime import datetime, timezone
from pathlib import Path

from .config import load_config
from .llm import PROVIDERS, LLMClient, LLMError
from .search import search
from .settings import apply_settings, load_settings

log = logging.getLogger("check")


def _gmail(env) -> dict:
    user = (env.get("GMAIL_USER") or "").strip()
    pw = (env.get("GMAIL_APP_PASSWORD") or "").replace(" ", "").strip()
    if not user or not pw:
        return {"id": "gmail", "label": "Gmail sending", "ok": False, "detail": "GMAIL_USER or GMAIL_APP_PASSWORD is missing in GitHub secrets."}
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=30) as s:
            s.login(user, pw)
        return {"id": "gmail", "label": "Gmail sending", "ok": True, "detail": f"Logged in as {user}."}
    except smtplib.SMTPAuthenticationError:
        return {"id": "gmail", "label": "Gmail sending", "ok": False,
                "detail": f"Gmail refused the login for {user}. Create a fresh App Password for that exact account and update GMAIL_APP_PASSWORD."}
    except (OSError, smtplib.SMTPException) as exc:
        return {"id": "gmail", "label": "Gmail sending", "ok": False, "detail": f"Could not reach Gmail ({type(exc).__name__})."}


def _llm(name: str, cfg: dict, env) -> dict:
    label = "AI: " + {"openrouter": "OpenRouter"}.get(name, name.capitalize())
    key_env = PROVIDERS[name]["key_env"]
    if not (env.get(key_env) or "").strip():
        return {"id": f"llm-{name}", "label": label, "ok": None, "detail": f"No key set ({key_env}). Optional if another AI works."}
    one = {**cfg, "llm": {**cfg["llm"], "providers": [name], "min_interval_seconds": 0, "max_retries": 0}}
    client = LLMClient(one, env)
    try:
        client.chat("You are a connectivity check.", "Reply with the single word OK.", json_mode=False, max_tokens=64)
        model = client.backends[0].model
        return {"id": f"llm-{name}", "label": label, "ok": True, "detail": f"Working (model {model})."}
    except LLMError as exc:
        return {"id": f"llm-{name}", "label": label, "ok": False, "detail": str(exc)[:220]}


def _search(cfg: dict, env) -> dict:
    res = search("new AI model release", {**cfg["search"], "results_per_query": 3}, {"timelimit": "m"}, env)
    engine = "Tavily" if (env.get("TAVILY_API_KEY") or "").strip() else "DuckDuckGo"
    if res:
        return {"id": "search", "label": "Web search", "ok": True, "detail": f"Working via {engine} ({len(res)} results)."}
    return {"id": "search", "label": "Web search", "ok": False,
            "detail": f"{engine} returned nothing. DuckDuckGo can block shared servers; add a free TAVILY_API_KEY for steadier results."}


def run_checks(cfg: dict, env) -> list[dict]:
    checks = [_gmail(env)]
    checks += [_llm(n, cfg, env) for n in PROVIDERS]
    working = [c for c in checks if c["id"].startswith("llm-") and c["ok"]]
    if not working:
        checks.append({"id": "llm-any", "label": "At least one AI works", "ok": False, "detail": "No AI provider is working, so digests would be unranked. Fix a key above."})
    checks.append(_search(cfg, env))
    return checks


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--data-dir", default="data")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    data = Path(args.data_dir)
    cfg = apply_settings(load_config(args.config), load_settings(data / "settings.json"))
    checks = run_checks(cfg, os.environ)
    out = data / "site" / "check.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"ran_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "checks": checks}, indent=1) + "\n", encoding="utf-8")
    for c in checks:
        log.info("%s: %s - %s", c["label"], {True: "OK", False: "PROBLEM", None: "not set"}[c["ok"]], c["detail"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
