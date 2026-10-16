"""When is the agent due? Mirrored in netlify/lib/shared.mjs; both are checked against tests/schedule_cases.json."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

CATCHUP_HOURS = 6  # a slot missed by GitHub/Netlify delays is still run for this long


def parse_ts(value) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def latest_slot(now: datetime, schedule: dict, catchup_hours: int = CATCHUP_HOURS) -> datetime | None:
    """Most recent scheduled time at or before `now` and within the catch-up window (UTC), else None."""
    tz = ZoneInfo(schedule["timezone"])
    local_now = now.astimezone(tz)
    best = None
    for back in range(0, 3):
        day = local_now.date() - timedelta(days=back)
        if day.weekday() not in schedule["days"]:
            continue
        for t in schedule["times"]:
            h, m = int(t[:2]), int(t[3:])
            slot = datetime(day.year, day.month, day.day, h, m, tzinfo=tz).astimezone(timezone.utc)
            if slot <= now and now - slot <= timedelta(hours=catchup_hours) and (best is None or slot > best):
                best = slot
    return best


def due_slot(now: datetime, settings: dict, last_run_at: datetime | None) -> datetime | None:
    """The slot that still needs a run, or None (paused, nothing scheduled recently, or already ran)."""
    if settings["paused"]:
        return None
    slot = latest_slot(now, settings["schedule"])
    if slot is None:
        return None
    if last_run_at is not None and last_run_at >= slot:
        return None
    return slot
