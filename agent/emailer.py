"""Render the digest (HTML + plain text) and send it through Gmail SMTP."""
from __future__ import annotations

import html
import os
import smtplib
import ssl
from dataclasses import dataclass, field
from email.message import EmailMessage
from typing import Mapping

from .research import Item, TopicResult

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465


@dataclass
class Digest:
    date: str
    tldr: list[str] = field(default_factory=list)
    sections: list[TopicResult] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    ideas: list[dict] = field(default_factory=list)  # new topic ideas from the trend scout

    @property
    def item_count(self) -> int:
        return sum(len(s.items) for s in self.sections)


def _e(text: str) -> str:
    return html.escape(text or "", quote=True)


def _href(url: str) -> str:
    """Only allow http(s) links; anything else (javascript:, data:, ...) becomes a dead link."""
    return _e(url) if url.lower().startswith(("http://", "https://")) else "#"


def _score_label(item: Item) -> str:
    return "unranked" if item.score is None else f"{item.score:g}/10"


def render_html(d: Digest) -> str:
    parts = [
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;'
        'margin:0 auto;padding:16px;color:#1f2328;line-height:1.5">',
        f'<h2 style="margin:0 0 4px">Research digest</h2><div style="color:#656d76;margin-bottom:16px">{_e(d.date)} &middot; {d.item_count} new item(s)</div>',
    ]
    if d.tldr:
        parts.append('<div style="background:#f6f8fa;border-radius:8px;padding:12px 16px;margin-bottom:20px">')
        parts.append('<strong>TL;DR</strong><ul style="margin:6px 0 0;padding-left:20px">')
        parts.extend(f"<li>{_e(b)}</li>" for b in d.tldr)
        parts.append("</ul></div>")
    for section in d.sections:
        if not section.items:
            continue
        parts.append(f'<h3 style="margin:24px 0 8px;border-bottom:1px solid #d0d7de;padding-bottom:4px">{_e(section.name)}</h3>')
        for item in section.items:
            parts.append('<div style="margin:0 0 16px">')
            parts.append(
                f'<a href="{_href(item.url)}" rel="noopener noreferrer" style="font-weight:600;color:#0969da;text-decoration:none">{_e(item.title)}</a>'
            )
            parts.append(f'<div style="color:#656d76;font-size:12px">{_e(item.domain)} &middot; {_e(_score_label(item))}</div>')
            if item.summary:
                parts.append(f'<div style="margin-top:4px">{_e(item.summary)}</div>')
            if item.why:
                parts.append(f'<div style="margin-top:4px;color:#3d444d"><em>Why it matters:</em> {_e(item.why)}</div>')
            parts.append("</div>")
    if d.ideas:
        parts.append('<h3 style="margin:24px 0 8px;border-bottom:1px solid #d0d7de;padding-bottom:4px">Trend radar: topic ideas</h3>')
        parts.append('<div style="color:#656d76;font-size:13px;margin-bottom:8px">Open your dashboard, Ideas tab, to add any of these to your plan.</div>')
        for idea in d.ideas:
            parts.append(f'<div style="margin:0 0 12px"><strong>{_e(idea["name"])}</strong><div>{_e(idea["why"])}</div></div>')
    if d.errors:
        parts.append('<h3 style="margin:24px 0 8px;color:#cf222e">Problems during this run</h3><ul>')
        parts.extend(f"<li>{_e(err)}</li>" for err in d.errors)
        parts.append("</ul>")
    parts.append("</div>")
    return "".join(parts)


def render_text(d: Digest) -> str:
    lines = [f"Research digest - {d.date} - {d.item_count} new item(s)", ""]
    if d.tldr:
        lines.append("TL;DR")
        lines.extend(f"  * {b}" for b in d.tldr)
        lines.append("")
    for section in d.sections:
        if not section.items:
            continue
        lines.append(f"== {section.name} ==")
        for item in section.items:
            lines.append(f"{item.title} ({_score_label(item)})")
            lines.append(item.url)
            if item.summary:
                lines.append(item.summary)
            if item.why:
                lines.append(f"Why it matters: {item.why}")
            lines.append("")
    if d.ideas:
        lines.append("Trend radar: topic ideas (add them from the Ideas tab of your dashboard)")
        for idea in d.ideas:
            lines.append(f"  * {idea['name']}: {idea['why']}")
        lines.append("")
    if d.errors:
        lines.append("Problems during this run:")
        lines.extend(f"  - {err}" for err in d.errors)
    return "\n".join(lines).strip() + "\n"


def make_subject(prefix: str, d: Digest) -> str:
    subject = f"{prefix} - {d.date} - {d.item_count} new"
    return " ".join(subject.split())  # collapses newlines, preventing header injection


def send_email(subject: str, html_body: str, text_body: str, env: Mapping[str, str] | None = None) -> None:
    env = os.environ if env is None else env
    user = (env.get("GMAIL_USER") or "").strip()
    password = (env.get("GMAIL_APP_PASSWORD") or "").replace(" ", "").strip()
    to = (env.get("MAIL_TO") or "").strip() or user
    if not user or not password:
        raise RuntimeError("GMAIL_USER and GMAIL_APP_PASSWORD must be set")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = user
    msg["To"] = to
    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context, timeout=30) as server:
        server.login(user, password)
        server.send_message(msg)
