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
        "model": "gemini-3.8-flash",
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
    discovered: bool = False  # True once we asked the provider which models this key can use


_SKIP_MODEL = re.compile(r"embed|tts|whisper|guard|safeguard|image|imagen|audio|live|transcri|moderat|veo|rerank|robotics|vision", re.I)
_GROQ_PREFERENCE = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "llama-3.1-8b-instant", "openai/gpt-oss-20b"]


def pick_model(provider: str, model_ids: list[str]) -> str | None:
    """Choose a chat model from the ids a provider says this key can use (free-tier names change often)."""
    ids = [m.removeprefix("models/") for m in model_ids if isinstance(m, str) and not _SKIP_MODEL.search(m)]
    if provider == "gemini":
        def version(m: str):
            hit = re.fullmatch(r"gemini-(\d+(?:\.\d+)?)-flash(-lite)?", m)
            return (float(hit.group(1)), hit.group(2) is None) if hit else None
        versioned = sorted((v, m) for m in ids if (v := version(m)) is not None)
        if versioned:
            return versioned[-1][1]
        flash = sorted(m for m in ids if m.startswith("gemini-") and "flash" in m)
        return flash[-1] if flash else next((m for m in sorted(ids) if m.startswith("gemma")), None)
    if provider == "groq":
        for wanted in _GROQ_PREFERENCE:
            if wanted in ids:
                return wanted
        return next((m for m in sorted(ids) if re.search(r"llama|gpt-oss|qwen", m)), None)
    free = [m for m in ids if m.endswith(":free")]
    for needle in ("llama-3.3-70b", "gpt-oss-120b", "instruct"):
        hit = next((m for m in sorted(free) if needle in m), None)
        if hit:
            return hit
    return free[0] if free else None


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
        self.failures: list[str] = []  # short provider errors, shown in the digest when the AI step fails
        self.last_backend: str | None = None  # name of the provider that answered most recently
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
        max_tokens: int = 4096,  # headroom: "thinking" models spend part of this budget before answering
    ) -> str:
        last: Exception | None = None
        for backend in self.backends:
            try:
                text = self._call(backend, system, user, json_mode, temperature, max_tokens)
                self.last_backend = backend.name
                return text
            except LLMError as exc:
                log.warning("LLM backend %s failed: %s", backend.name, exc)
                self.failures.append(f"{backend.name}: {str(exc)[:160]}")
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

    def _discover(self, backend: Backend) -> str | None:
        try:
            resp = requests.get(f"{backend.base_url}/models", headers={"Authorization": f"Bearer {backend.api_key}"}, timeout=self.timeout)
            if resp.status_code != 200:
                return None
            ids = [m.get("id", "") for m in resp.json().get("data", []) if isinstance(m, dict)]
        except (requests.RequestException, ValueError, AttributeError):
            return None
        return pick_model(backend.name, ids)

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

        last_problem = ""
        for attempt in range(self.max_retries + 2):
            self._throttle()
            wait = min(60.0, 3.0 * (2**attempt))
            try:
                resp = requests.post(url, headers=headers, json=payload, timeout=self.timeout)
            except requests.RequestException as exc:
                last_problem = f"network error ({type(exc).__name__})"
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
                if resp.status_code == 404 and not backend.discovered:
                    # Most likely a retired model name: ask the provider what this key can use, then retry once.
                    backend.discovered = True
                    chosen = self._discover(backend)
                    if chosen and chosen != backend.model:
                        log.warning("%s: model %s unavailable, switching to %s", backend.name, backend.model, chosen)
                        backend.model = chosen
                        payload["model"] = chosen
                        continue
                if resp.status_code in (429, 500, 502, 503, 504):
                    retry_after = resp.headers.get("Retry-After", "")
                    if retry_after.isdigit():
                        wait = min(60.0, float(retry_after))
                    last_problem = "rate limit reached (HTTP 429), try again later" if resp.status_code == 429 else f"service error (HTTP {resp.status_code})"
                    log.info("%s returned HTTP %s; retrying in %.0fs", backend.name, resp.status_code, wait)
                else:
                    raise LLMError(f"HTTP {resp.status_code}: {resp.text[:200]}")
            if attempt < self.max_retries + 1:
                time.sleep(wait)
        raise LLMError(f"{backend.name}: {last_problem or 'retries exhausted'}")
