"""Builds site/alerts.json: the push notifications the dashboard server should send for one run."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


def _safe_url(url: str) -> str:
    return url if urlparse(url).scheme in ("http", "https") else "/"


def build_alerts(digest, notify: dict, new_ideas: list[dict]) -> list[dict]:
    items = []
    if notify.get("alerts"):
        picks = [i for s in digest.sections for i in s.items
                 if i.score is not None and (i.notify or i.score >= notify.get("min_score", 9))]
        picks.sort(key=lambda i: -i.score)
        for n, it in enumerate(picks[:3]):
            lead = f"Matches your rule: {it.rule}" if it.notify and it.rule else f"{it.score:g}/10 in {it.topic}"
            items.append({"kind": "alert", "tag": f"alert-{n}", "title": it.title[:90],
                          "body": f"{lead}. {it.summary}"[:160], "url": _safe_url(it.url)})
    if notify.get("digest") and digest.item_count:
        items.append({"kind": "digest", "tag": "digest", "title": "Your digest is ready",
                      "body": f"{digest.item_count} new items across {sum(1 for s in digest.sections if s.items)} topics.", "url": "/"})
    if notify.get("ideas") and new_ideas:
        names = ", ".join(i["name"] for i in new_ideas)
        items.append({"kind": "ideas", "tag": "ideas", "title": "New topic idea" if len(new_ideas) == 1 else f"{len(new_ideas)} new topic ideas",
                      "body": names[:140], "url": "/?tab=ideas"})
    return items


def write_alerts(data_dir: Path, batch: str, items: list[dict]) -> None:
    path = Path(data_dir) / "site" / "alerts.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"batch": batch, "created": datetime.now(timezone.utc).isoformat(timespec="seconds"), "items": items}
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)
