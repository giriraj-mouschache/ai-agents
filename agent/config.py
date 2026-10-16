from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import yaml

DEFAULTS: dict[str, Any] = {
    "llm": {
        # Tried in order; providers without an API key in the environment are skipped.
        "providers": ["gemini", "groq", "openrouter"],
        # Optional per-provider model override, e.g. {"gemini": "gemini-2.5-flash"}
        "models": {},
        "max_retries": 2,
        "min_interval_seconds": 2.0,
        "timeout_seconds": 90,
    },
    "search": {
        "engine": "auto",  # auto = Tavily if TAVILY_API_KEY is set, else DuckDuckGo
        "results_per_query": 8,
        "region": "wt-wt",
        "timelimit": "w",  # d=day, w=week, m=month, y=year
    },
    "research": {
        "max_rounds": 2,  # round 1 = your queries, round 2 = follow-ups the LLM suggests
        "max_pages_per_topic": 8,
        "batch_size": 4,
        "page_char_limit": 2500,
        "fetch_timeout_seconds": 15,
        "min_score": 6,
        "max_items_per_topic": 6,
    },
    "email": {
        "subject_prefix": "Research digest",
        "send_when_empty": False,
        "tldr": True,
    },
    "state": {
        "path": "state/seen.json",
        "keep_days": 90,
    },
    "site": {
        "data_dir": "site/data",
        # Shown on the dashboard. Keep in sync with the cron line in .github/workflows/research-agent.yml.
        "schedule_label": "Daily at 8:00 AM IST",
        "schedule_ist": "08:00",
        "keep_runs": 90,
    },
    "topics": [],
}


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


def load_config(path: str | Path) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}
    cfg = _merge(DEFAULTS, raw)

    topics = cfg.get("topics") or []
    if not topics:
        raise ValueError("config.yaml has no topics; add at least one under 'topics:'")
    for i, topic in enumerate(topics):
        if not isinstance(topic, dict) or not topic.get("name"):
            raise ValueError(f"topics[{i}] needs a 'name'")
        queries = topic.get("queries")
        if not isinstance(queries, list) or not queries:
            raise ValueError(f"topic '{topic['name']}' needs a non-empty 'queries' list")
        topic.setdefault("goal", topic["name"])
    return cfg
