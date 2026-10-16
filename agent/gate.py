"""Decides whether the workflow should run the agent. Cheap (stdlib only) so idle ticks cost almost nothing.

Usage: python -m agent.gate --data data   (writes run=true|false to $GITHUB_OUTPUT)
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from .schedule import due_slot, parse_ts
from .settings import load_settings


def last_run_at(data_dir: Path) -> datetime | None:
    try:
        index = json.loads((data_dir / "site" / "index.json").read_text(encoding="utf-8"))
        runs = index.get("runs") or []
        return parse_ts(runs[0].get("ran_at")) if runs else None
    except (OSError, json.JSONDecodeError, AttributeError, IndexError):
        return None


def decide(event: str, force: bool, dry_run: bool, test_email: bool, data_dir: Path, now: datetime, check: bool = False) -> tuple[bool, str]:
    if event == "workflow_dispatch" and (force or dry_run or test_email or check):
        return True, "started by hand"
    settings = load_settings(data_dir / "settings.json")
    if settings["paused"]:
        return False, "agent is paused"
    slot = due_slot(now, settings, last_run_at(data_dir))
    if slot is None:
        return False, "not due"
    return True, f"due for the {slot.isoformat(timespec='minutes')} slot"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="data")
    args = parser.parse_args()
    truthy = lambda v: str(v or "").strip().lower() == "true"  # noqa: E731
    run, why = decide(
        os.environ.get("GITHUB_EVENT_NAME", ""),
        truthy(os.environ.get("INPUT_FORCE")),
        truthy(os.environ.get("INPUT_DRY_RUN")),
        bool(os.environ.get("INPUT_TEST_EMAIL_TO", "").strip()),
        Path(args.data),
        datetime.now(timezone.utc),
        truthy(os.environ.get("INPUT_CHECK")),
    )
    print(f"gate: run={run} ({why})")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"run={'true' if run else 'false'}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
