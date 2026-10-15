"""Web search: Tavily when a key is set (cleaner results), otherwise DuckDuckGo (no key)."""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Mapping

import requests

log = logging.getLogger(__name__)

_TAVILY_RANGE = {"d": "day", "w": "week", "m": "month", "y": "year"}


@dataclass
class Result:
    title: str
    url: str
    snippet: str = ""


def _tavily(query: str, n: int, timelimit: str, mode: str, key: str) -> list[Result]:
    body: dict = {
        "query": query,
        "max_results": n,
        "search_depth": "basic",
        "topic": "news" if mode == "news" else "general",
    }
    if timelimit in _TAVILY_RANGE:
        body["time_range"] = _TAVILY_RANGE[timelimit]
    resp = requests.post(
        "https://api.tavily.com/search",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=body,
        timeout=30,
    )
    resp.raise_for_status()
    out = []
    for row in resp.json().get("results", []):
        url = row.get("url") or ""
        if url:
            out.append(Result(row.get("title") or url, url, row.get("content") or ""))
    return out


def _ddg(query: str, n: int, region: str, timelimit: str, mode: str) -> list[Result]:
    try:
        from ddgs import DDGS
    except ImportError:  # older package name
        from duckduckgo_search import DDGS  # type: ignore

    with DDGS() as client:
        if mode == "news":
            rows = client.news(query, region=region, timelimit=timelimit or None, max_results=n)
        else:
            rows = client.text(query, region=region, timelimit=timelimit or None, max_results=n)
    out = []
    for row in rows or []:
        url = row.get("href") or row.get("url") or ""
        if url:
            out.append(Result(row.get("title") or url, url, row.get("body") or ""))
    return out


def search(
    query: str,
    search_cfg: dict,
    topic: dict | None = None,
    env: Mapping[str, str] | None = None,
) -> list[Result]:
    """Return results for one query. Never raises; returns [] when every engine fails."""
    env = os.environ if env is None else env
    topic = topic or {}
    n = int(search_cfg["results_per_query"])
    timelimit = topic.get("timelimit", search_cfg["timelimit"])
    mode = topic.get("mode", "text")
    engine = search_cfg["engine"]
    tavily_key = (env.get("TAVILY_API_KEY") or "").strip()

    if tavily_key and engine in ("auto", "tavily"):
        try:
            results = _tavily(query, n, timelimit, mode, tavily_key)
            if results:
                return results
        except (requests.RequestException, ValueError) as exc:
            log.warning("Tavily search failed (%s); falling back to DuckDuckGo", type(exc).__name__)

    try:
        return _ddg(query, n, search_cfg["region"], timelimit, mode)
    except Exception as exc:  # ddgs raises its own exception types (rate limits, etc.)
        log.warning("DuckDuckGo search failed for %r: %s", query, type(exc).__name__)
        return []
