"""Saves every real run as JSON under site/data so the dashboard can show history."""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))
SCHEMA_VERSION = 1


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _topics_snapshot(cfg: dict) -> list[dict]:
    return [
        {
            "name": str(t["name"]),
            "goal": " ".join(str(t.get("goal", "")).split()),
            "queries": [str(q) for q in t["queries"]],
        }
        for t in cfg["topics"]
    ]


def refresh_index(data_dir: str | Path, cfg: dict, repo: str = "") -> dict:
    """Rewrite the static parts of index.json (topics, schedule, repo) and keep the runs list."""
    data_dir = Path(data_dir)
    index_path = data_dir / "index.json"
    index = _read_json(index_path)
    site = cfg["site"]
    index.update(
        {
            "version": SCHEMA_VERSION,
            "repo": repo or index.get("repo", ""),
            "schedule": {"label": site["schedule_label"], "time_ist": site["schedule_ist"]},
            "topics": _topics_snapshot(cfg),
        }
    )
    index.setdefault("runs", [])
    _write_json(index_path, index)
    return index


def record_run(
    data_dir: str | Path,
    cfg: dict,
    digest,
    *,
    status: str,
    emailed: bool,
    llm_name: str | None,
    kind: str,
    repo: str = "",
    error: str = "",
    now: datetime | None = None,
) -> dict:
    """Write this run's digest file and add it to index.json (newest first, pruned to keep_runs)."""
    now = now or datetime.now(timezone.utc)
    data_dir = Path(data_dir)
    run_id = now.strftime("%Y%m%dT%H%M%SZ")
    ran_at = now.isoformat(timespec="seconds")
    date_ist = now.astimezone(IST).strftime("%Y-%m-%d")

    sections = []
    for section in digest.sections:
        if not section.items:
            continue
        sections.append(
            {
                "name": section.name,
                "items": [
                    {
                        "title": i.title,
                        "url": i.url,
                        "domain": i.domain,
                        "summary": i.summary,
                        "why": i.why,
                        "score": i.score,
                    }
                    for i in section.items
                ],
            }
        )

    rel = f"digests/{run_id}.json"
    _write_json(
        data_dir / rel,
        {
            "version": SCHEMA_VERSION,
            "id": run_id,
            "ran_at": ran_at,
            "date": date_ist,
            "kind": kind,
            "status": status,
            "emailed": emailed,
            "llm": llm_name or "",
            "tldr": digest.tldr,
            "sections": sections,
            "errors": digest.errors,
            "error": error,
        },
    )

    index = refresh_index(data_dir, cfg, repo)
    entry = {
        "id": run_id,
        "ran_at": ran_at,
        "date": date_ist,
        "kind": kind,
        "status": status,
        "emailed": emailed,
        "items": digest.item_count,
        "errors": len(digest.errors) + (1 if error else 0),
        "llm": llm_name or "",
        "file": rel,
    }
    runs = [r for r in index["runs"] if isinstance(r, dict) and r.get("id") != run_id]
    runs.append(entry)
    runs.sort(key=lambda r: r.get("ran_at", ""), reverse=True)

    keep = int(cfg["site"]["keep_runs"])
    for old in runs[keep:]:
        old_file = str(old.get("file", ""))
        if old_file.startswith("digests/") and ".." not in old_file:
            try:
                (data_dir / old_file).unlink()
            except OSError:
                pass
    index["runs"] = runs[:keep]
    index["updated"] = index["runs"][0]["ran_at"]  # newest run, even if an older one was just recorded
    _write_json(data_dir / "index.json", index)
    return entry
