"""Settings the dashboard edits (data/settings.json). Loaded tolerantly: bad values fall back to safe defaults."""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from zoneinfo import ZoneInfo

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
EMAIL_RE = re.compile(r"^[^@\s,;<>\"']+@[^@\s,;<>\"']+\.[^@\s,;<>\"']+$")
MAX_TOPICS, MAX_QUERIES, MAX_TIMES = 10, 8, 6

DEFAULT_SETTINGS: dict = {
    "version": 1,
    "paused": False,
    "schedule": {"times": ["08:00"], "days": [0, 1, 2, 3, 4, 5, 6], "timezone": "Asia/Kolkata"},
    "email": {"to": "", "send_when_empty": False},
    "weekly": {"enabled": False, "day": 6},
    "min_score": 6,
    "topics": [],
}


def _tz_ok(name: str) -> bool:
    try:
        ZoneInfo(name)
        return True
    except Exception:
        return False


MAX_RECIPIENTS = 5


def parse_recipients(value) -> list[str]:
    """Valid, unique addresses from a comma/semicolon/space separated string (at most 5)."""
    found = []
    for part in re.split(r"[,;\s]+", str(value or "")):
        if part and EMAIL_RE.match(part) and part.lower() not in [f.lower() for f in found]:
            found.append(part)
    return found[:MAX_RECIPIENTS]


def normalize(raw) -> dict:
    """Return a clean settings dict. Never raises; unusable parts fall back to defaults."""
    out = copy.deepcopy(DEFAULT_SETTINGS)
    if not isinstance(raw, dict):
        return out
    out["paused"] = raw.get("paused") is True

    sched = raw.get("schedule") if isinstance(raw.get("schedule"), dict) else {}
    times = sorted({t for t in (sched.get("times") or []) if isinstance(t, str) and TIME_RE.match(t)})[:MAX_TIMES]
    days = sorted({d for d in (sched.get("days") or []) if isinstance(d, int) and not isinstance(d, bool) and 0 <= d <= 6})
    tz = sched.get("timezone")
    if times:
        out["schedule"]["times"] = times
    if days:
        out["schedule"]["days"] = days
    if isinstance(tz, str) and _tz_ok(tz):
        out["schedule"]["timezone"] = tz

    email = raw.get("email") if isinstance(raw.get("email"), dict) else {}
    out["email"]["to"] = ", ".join(parse_recipients(email.get("to")))
    out["email"]["send_when_empty"] = email.get("send_when_empty") is True

    weekly = raw.get("weekly") if isinstance(raw.get("weekly"), dict) else {}
    out["weekly"]["enabled"] = weekly.get("enabled") is True
    wd = weekly.get("day")
    if isinstance(wd, int) and not isinstance(wd, bool) and 0 <= wd <= 6:
        out["weekly"]["day"] = wd

    ms = raw.get("min_score")
    if isinstance(ms, int) and not isinstance(ms, bool) and 1 <= ms <= 10:
        out["min_score"] = ms

    topics = []
    for t in (raw.get("topics") or [])[:MAX_TOPICS] if isinstance(raw.get("topics"), list) else []:
        if not isinstance(t, dict):
            continue
        name = " ".join(str(t.get("name") or "").split())[:80]
        queries = [" ".join(str(q).split())[:200] for q in (t.get("queries") or []) if str(q).strip()][:MAX_QUERIES]
        if not name or not queries:
            continue
        topic = {"name": name, "queries": queries, "goal": " ".join(str(t.get("goal") or name).split())[:600]}
        if t.get("timelimit") in ("d", "w", "m", "y"):
            topic["timelimit"] = t["timelimit"]
        topics.append(topic)
    out["topics"] = topics
    return out


def load_settings(path: str | Path) -> dict:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raw = {}
    return normalize(raw)


def schedule_label(schedule: dict) -> str:
    days = schedule["days"]
    if len(days) == 7:
        d = "Every day"
    elif days == [0, 1, 2, 3, 4]:
        d = "Weekdays"
    else:
        d = ", ".join(DAY_NAMES[i] for i in days)
    return f"{d} at {' and '.join(schedule['times'])} ({schedule['timezone']})"


def apply_settings(cfg: dict, settings: dict) -> dict:
    """Overlay dashboard settings on config.yaml defaults. Topics from settings win when present."""
    if settings["topics"]:
        cfg["topics"] = copy.deepcopy(settings["topics"])
    cfg["research"]["min_score"] = settings["min_score"]
    cfg["email"]["send_when_empty"] = settings["email"]["send_when_empty"]
    cfg["site"]["schedule_label"] = schedule_label(settings["schedule"])
    cfg["site"]["schedule_ist"] = settings["schedule"]["times"][0]
    return cfg
