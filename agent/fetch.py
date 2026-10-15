"""Fetch a web page and extract its readable text.

Search results are untrusted input, so this refuses non-HTTP(S) URLs and anything that
resolves to a private, loopback or link-local address (including after redirects).
"""
from __future__ import annotations

import ipaddress
import logging
import socket
from urllib.parse import urljoin, urlparse

import requests
import trafilatura

log = logging.getLogger(__name__)

MAX_BYTES = 2_000_000
MAX_REDIRECTS = 4
USER_AGENT = "Mozilla/5.0 (compatible; ResearchAgent/1.0)"


def is_public_http_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
        host = parsed.hostname
        if parsed.scheme not in ("http", "https") or not host:
            return False
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except (ValueError, socket.gaierror, UnicodeError):
        return False
    for info in infos:
        try:
            if not ipaddress.ip_address(info[4][0]).is_global:
                return False
        except ValueError:
            return False
    return True


def fetch_text(url: str, max_chars: int, timeout: float = 15) -> str:
    """Return up to max_chars of main-content text, or '' if anything goes wrong."""
    current = url
    try:
        with requests.Session() as session:
            session.headers.update({"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"})
            for _ in range(MAX_REDIRECTS + 1):
                if not is_public_http_url(current):
                    return ""
                resp = session.get(current, timeout=timeout, stream=True, allow_redirects=False)
                if resp.status_code in (301, 302, 303, 307, 308):
                    location = resp.headers.get("Location")
                    resp.close()
                    if not location:
                        return ""
                    current = urljoin(current, location)
                    continue
                if resp.status_code != 200:
                    resp.close()
                    return ""
                ctype = resp.headers.get("Content-Type", "").lower()
                if not any(t in ctype for t in ("html", "xml", "text")):
                    resp.close()
                    return ""
                raw = b""
                for chunk in resp.iter_content(65536):
                    raw += chunk
                    if len(raw) > MAX_BYTES:
                        break
                encoding = resp.encoding or "utf-8"
                resp.close()
                html = raw.decode(encoding, errors="replace")
                text = trafilatura.extract(html, include_comments=False, include_tables=False) or ""
                return text[:max_chars]
    except (requests.RequestException, ValueError, LookupError) as exc:
        log.info("Could not fetch %s (%s)", url, type(exc).__name__)
    return ""
