"""Remembers which URLs were already reported so you never get the same finding twice."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_TRACKING = re.compile(r"^(utm_|fbclid$|gclid$|mc_|ref$|ref_|igshid$)", re.I)


def normalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not _TRACKING.match(k)]
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, urlencode(query), ""))


def _key(url: str) -> str:
    return hashlib.sha1(normalize_url(url).encode("utf-8")).hexdigest()[:16]


class SeenStore:
    def __init__(self, path: str | Path, keep_days: int = 90):
        self.path = Path(path)
        self.keep_days = keep_days
        self.seen: dict[str, dict] = {}
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                self.seen = dict(data.get("seen", {}))
            except (json.JSONDecodeError, OSError, AttributeError, TypeError):
                self.seen = {}

    def has(self, url: str) -> bool:
        return _key(url) in self.seen

    def add(self, url: str, title: str = "") -> None:
        self.seen[_key(url)] = {
            "url": normalize_url(url),
            "title": title[:120],
            "first_seen": datetime.now(timezone.utc).date().isoformat(),
        }

    def save(self) -> None:
        cutoff = datetime.now(timezone.utc).date() - timedelta(days=self.keep_days)
        kept = {}
        for key, entry in self.seen.items():
            try:
                first_seen = date.fromisoformat(entry.get("first_seen", ""))
            except ValueError:
                first_seen = datetime.now(timezone.utc).date()
            if first_seen >= cutoff:
                kept[key] = entry
        self.seen = kept
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "seen": dict(sorted(kept.items()))}
        self.path.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
