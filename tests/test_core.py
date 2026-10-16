from __future__ import annotations

import json
import smtplib
from datetime import date, timedelta

import pytest

from agent.config import DEFAULTS, _merge
from agent.emailer import Digest, make_subject, render_html, send_email
from agent.fetch import is_public_http_url
from agent.llm import LLMError, extract_json
from agent.research import Item, TopicResult, run_topic
from agent.search import Result
from agent.store import SeenStore, normalize_url


def make_cfg(**research):
    cfg = _merge(DEFAULTS, {"research": research})
    return cfg


class FakeLLM:
    """Scores every candidate by a fixed rule and suggests one follow-up query in round 1."""

    def __init__(self, scores=None, fail=False):
        self.scores = scores or {}
        self.fail = fail
        self.calls = 0

    def json(self, system, user, **kwargs):
        self.calls += 1
        if self.fail:
            raise LLMError("down")
        import re

        ids = [int(i) for i in re.findall(r"<<<CANDIDATE (\d+)>>>", user)]
        items = [
            {"id": i, "score": self.scores.get(i, 8), "summary": f"summary {i}", "why_it_matters": "because"}
            for i in ids
        ]
        return {"items": items, "follow_up_queries": ["follow up query"] if self.calls == 1 else []}


def fake_search_factory(table):
    def fake_search(query, search_cfg, topic=None):
        return table.get(query, [])

    return fake_search


def fake_fetch(url, max_chars, timeout=15):
    return f"text of {url}"


def test_normalize_url_strips_tracking_and_fragment():
    assert normalize_url("HTTPS://Example.com/a/?utm_source=x&id=1#top") == "https://example.com/a?id=1"


def test_extract_json_handles_fences_and_chatter():
    assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json('Sure! {"a": 2} hope that helps') == {"a": 2}
    with pytest.raises(LLMError):
        extract_json("no json here")
    with pytest.raises(LLMError):
        extract_json("[1, 2]")


def test_store_roundtrip_and_prune(tmp_path):
    path = tmp_path / "seen.json"
    store = SeenStore(path, keep_days=90)
    store.add("https://a.com/x?utm_source=n", "A")
    store.save()
    again = SeenStore(path, keep_days=90)
    assert again.has("https://a.com/x")

    data = json.loads(path.read_text())
    key = next(iter(data["seen"]))
    data["seen"][key]["first_seen"] = (date.today() - timedelta(days=200)).isoformat()
    path.write_text(json.dumps(data))
    old = SeenStore(path, keep_days=90)
    old.save()
    assert not SeenStore(path, keep_days=90).has("https://a.com/x")


def test_run_topic_filters_dedupes_and_follows_up(tmp_path):
    store = SeenStore(tmp_path / "s.json")
    store.add("https://seen.com/old")
    table = {
        "q1": [Result("Good", "https://a.com/1", "s"), Result("Seen", "https://seen.com/old", "s")],
        "follow up query": [Result("Followed", "https://b.com/2", "s")],
    }
    topic = {"name": "T", "goal": "g", "queries": ["q1"]}
    llm = FakeLLM(scores={1: 9, 2: 3})  # candidate 2 (the follow-up page) is low quality
    res = run_topic(
        topic,
        make_cfg(batch_size=4),
        llm,
        store,
        "2026-10-15",
        search_fn=fake_search_factory(table),
        fetch_fn=fake_fetch,
    )
    assert [i.url for i in res.items] == ["https://a.com/1"]
    assert res.analyzed == 2
    marked = {u for u, _ in res.to_mark}
    assert marked == {"https://a.com/1", "https://b.com/2"}  # low scorer is remembered too, seen one skipped


def test_run_topic_falls_back_to_unranked_when_llm_down(tmp_path):
    store = SeenStore(tmp_path / "s.json")
    table = {"q1": [Result("Raw", "https://a.com/1", "snippet")]}
    res = run_topic(
        {"name": "T", "goal": "g", "queries": ["q1"]},
        make_cfg(),
        FakeLLM(fail=True),
        store,
        "2026-10-15",
        search_fn=fake_search_factory(table),
        fetch_fn=fake_fetch,
    )
    assert len(res.items) == 1 and res.items[0].score is None


def test_render_html_escapes_and_blocks_bad_links():
    item = Item("T", "<script>alert(1)</script>", "javascript:alert(1)", "<b>x</b>", "why", 7)
    digest = Digest(date="2026-10-15", sections=[TopicResult("T", [item])], errors=["<i>boom</i>"])
    out = render_html(digest)
    assert "<script>" not in out and "<b>x</b>" not in out and "<i>boom</i>" not in out
    assert 'href="#"' in out and "javascript:" not in out.split('href="')[1][:12]


def test_make_subject_strips_newlines():
    d = Digest(date="2026-10-15")
    assert "\n" not in make_subject("Hi\r\nBcc: evil@x.com", d)


def test_send_email_uses_app_password_without_spaces(monkeypatch):
    seen = {}

    class FakeSMTP:
        def __init__(self, host, port, context=None, timeout=None):
            seen["host"], seen["port"] = host, port

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def login(self, user, password):
            seen["login"] = (user, password)

        def send_message(self, msg):
            seen["to"] = msg["To"]

    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTP)
    send_email("s", "<p>h</p>", "t", env={"GMAIL_USER": "me@gmail.com", "GMAIL_APP_PASSWORD": "abcd efgh ijkl mnop"})
    assert seen["host"] == "smtp.gmail.com" and seen["port"] == 465
    assert seen["login"] == ("me@gmail.com", "abcdefghijklmnop")
    assert seen["to"] == "me@gmail.com"

    with pytest.raises(RuntimeError):
        send_email("s", "h", "t", env={})


def test_record_run_writes_digest_and_prunes(tmp_path):
    from datetime import datetime, timezone

    from agent.history import record_run

    cfg = _merge(
        DEFAULTS,
        {"topics": [{"name": "T", "goal": "g\n  more", "queries": ["q"]}], "site": {"keep_runs": 2}},
    )
    item = Item("T", "Title", "https://a.com/x", "sum", "why", 8)
    digest = Digest(date="2026-10-16", sections=[TopicResult("T", [item])], errors=[])
    for day in (14, 15, 16):
        record_run(
            tmp_path,
            cfg,
            digest,
            status="ok",
            emailed=True,
            llm_name="gemini",
            kind="schedule",
            repo="o/r",
            now=datetime(2026, 10, day, 2, 33, tzinfo=timezone.utc),
        )
    index = json.loads((tmp_path / "index.json").read_text())
    assert [r["date"] for r in index["runs"]] == ["2026-10-16", "2026-10-15"]  # newest first, pruned to 2
    assert index["repo"] == "o/r" and index["topics"][0]["goal"] == "g more"
    assert not (tmp_path / "digests" / "20261014T023300Z.json").exists()
    saved = json.loads((tmp_path / index["runs"][0]["file"]).read_text())
    assert saved["sections"][0]["items"][0]["domain"] == "a.com" and saved["llm"] == "gemini"


@pytest.mark.parametrize(
    "url",
    ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "ftp://example.com/x", "http://10.0.0.5/"],
)
def test_fetch_blocks_non_public_urls(url):
    assert not is_public_http_url(url)
