"""Tiny client for free-tier, OpenAI-compatible chat APIs (Gemini, Groq, OpenRouter).

Defaults below are starting points. Free-tier model names change often, so override
them in config.yaml (llm.models) if a provider returns "model not found".
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Mapping

import requests

log = logging.getLogger(__name__)

PROVIDERS: dict[str, dict[str, str]] = {
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model": "gemini-2.5-flash",
        "key_env": "GEMINI_API_KEY",
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "model": "llama-3.3-70b-versatile",
        "key_env": "GROQ_API_KEY",
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "model": "meta-llama/llama-3.3-70b-instruct:free",
        "key_env": "OPENROUTER_API_KEY",
    },
}


class LLMError(RuntimeError):
    pass


@dataclass
class Backend:
    name: str
    base_url: str
    model: str
    api_key: str


def extract_json(text: str) -> dict:
    """Parse a JSON object from model output, tolerating code fences and chatter."""
    t = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if fence:
        t = fence.group(1).strip()
    try:
        data = json.loads(t)
    except json.JSONDecodeError:
        start, end = t.find("{"), t.rfind("}")
        if start == -1 or end <= start:
            raise LLMError("Model did not return JSON")
        try:
            data = json.loads(t[start : end + 1])
        except json.JSONDecodeError as exc:
            raise LLMError("Model returned malformed JSON") from exc
    if not isinstance(data, dict):
        raise LLMError("Model returned JSON that is not an object")
    return data


class LLMClient:
    def __init__(self, cfg: dict, env: Mapping[str, str] | None = None):
        env = os.environ if env is None else env
        llm_cfg = cfg["llm"]
        self.max_retries = int(llm_cfg["max_retries"])
        self.min_interval = float(llm_cfg["min_interval_seconds"])
        self.timeout = float(llm_cfg["timeout_seconds"])
        self._last_call = 0.0
        self.backends: list[Backend] = []
        for name in llm_cfg["providers"]:
            spec = PROVIDERS.get(name)
            if spec is None:
                log.warning("Unknown LLM provider '%s' in config; skipping", name)
                continue
            key = (env.get(spec["key_env"]) or "").strip()
            if not key:
                continue
            model = (llm_cfg.get("models") or {}).get(name) or spec["model"]
            self.backends.append(Backend(name, spec["base_url"], model, key))

    @property
    def available(self) -> bool:
        return bool(self.backends)

    def _throttle(self) -> None:
        wait = self.min_interval - (time.monotonic() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()

    def chat(
        self,
        system: str,
        user: str,
        json_mode: bool = True,
        temperature: float = 0.2,
        max_tokens: int = 2048,
    ) -> str:
        last: Exception | None = None
        for backend in self.backends:
            try:
                return self._call(backend, system, user, json_mode, temperature, max_tokens)
            except LLMError as exc:
                log.warning("LLM backend %s failed: %s", backend.name, exc)
                last = exc
        raise LLMError(f"All LLM backends failed: {last}")

    def json(self, system: str, user: str, **kwargs) -> dict:
        """Chat and parse a JSON object, asking once more if the first reply is malformed."""
        last: Exception | None = None
        for attempt in range(2):
            prompt = user if attempt == 0 else user + "\n\nReturn ONLY a valid JSON object, nothing else."
            text = self.chat(system, prompt, json_mode=True, **kwargs)
            try:
                return extract_json(text)
            except LLMError as exc:
                last = exc
        raise LLMError(str(last))

    def _call(
        self,
        backend: Backend,
        system: str,
        user: str,
        json_mode: bool,
        temperature: float,
        max_tokens: int,
    ) -> str:
        url = f"{backend.base_url}/chat/completions"
        payload: dict = {
            "model": backend.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        headers = {
            "Authorization": f"Bearer {backend.api_key}",
            "Content-Type": "application/json",
        }

        for attempt in range(self.max_retries + 2):
            self._throttle()
            wait = min(60.0, 3.0 * (2**attempt))
            try:
                resp = requests.post(url, headers=headers, json=payload, timeout=self.timeout)
            except requests.RequestException as exc:
                log.info("%s network error (%s); retrying", backend.name, type(exc).__name__)
            else:
                if resp.status_code == 200:
                    try:
                        return resp.json()["choices"][0]["message"]["content"] or ""
                    except (KeyError, IndexError, ValueError, TypeError) as exc:
                        raise LLMError("Unexpected response shape") from exc
                if resp.status_code == 400 and "response_format" in payload:
                    # Some free models reject JSON mode; retry without it.
                    payload.pop("response_format")
                    continue
                if resp.status_code in (429, 500, 502, 503, 504):
                    retry_after = resp.headers.get("Retry-After", "")
                    if retry_after.isdigit():
                        wait = min(60.0, float(retry_after))
                    log.info("%s returned HTTP %s; retrying in %.0fs", backend.name, resp.status_code, wait)
                else:
                    raise LLMError(f"HTTP {resp.status_code}: {resp.text[:200]}")
            if attempt < self.max_retries + 1:
                time.sleep(wait)
        raise LLMError(f"{backend.name}: retries exhausted")
