"""Weekly roundup: the best items from the last 7 daily digests, no extra AI calls."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from .emailer import Digest
from .research import Item, TopicResult

STATE = "weekly.json"


def _read(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def due_today(settings: dict, data_dir: Path, now: datetime) -> bool:
    """True on the chosen weekday if the roundup was not already sent that local day."""
    w = settings["weekly"]
    if not w["enabled"]:
        return False
    local = now.astimezone(ZoneInfo(settings["schedule"]["timezone"]))
    if local.weekday() != w["day"]:
        return False
    return _read(data_dir / "state" / STATE).get("last_sent") != local.date().isoformat()


def mark_sent(settings: dict, data_dir: Path, now: datetime) -> None:
    local = now.astimezone(ZoneInfo(settings["schedule"]["timezone"]))
    path = data_dir / "state" / STATE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"last_sent": local.date().isoformat()}) + "\n", encoding="utf-8")


def build(data_dir: Path, now: datetime, limit: int = 10) -> Digest | None:
    """Top scored, de-duplicated items from the past 7 days of digests, grouped by topic."""
    site = data_dir / "site"
    index = _read(site / "index.json")
    cutoff = now - timedelta(days=7)
    best: dict[str, tuple[float, str, dict]] = {}
    for run in index.get("runs", []):
        try:
            when = datetime.fromisoformat(str(run["ran_at"]).replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        if when < cutoff or not str(run.get("file", "")).startswith("digests/"):
            continue
        digest = _read(site / run["file"])
        for section in digest.get("sections", []):
            for item in section.get("items", []):
                score = item.get("score")
                if not isinstance(score, (int, float)) or not item.get("url"):
                    continue
                if item["url"] not in best or score > best[item["url"]][0]:
                    best[item["url"]] = (float(score), section.get("name", ""), item)
    if not best:
        return None
    top = sorted(best.values(), key=lambda t: -t[0])[:limit]
    groups: dict[str, list[Item]] = {}
    for score, topic, it in top:
        groups.setdefault(topic, []).append(Item(topic, it.get("title", ""), it["url"], it.get("summary", ""), it.get("why", ""), score))
    local = now.astimezone(timezone.utc).strftime("%Y-%m-%d")
    return Digest(date=local, tldr=[f"The {len(top)} best items from your daily digests over the last 7 days."],
                  sections=[TopicResult(name, items) for name, items in groups.items()])
