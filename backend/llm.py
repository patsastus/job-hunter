"""The one place that talks to the LLM provider, so scoring and profile generation share settings and errors."""
from dataclasses import dataclass

import requests
from sqlalchemy.orm import Session

import models

DEFAULT_MODEL = "gemini-3.5-flash-lite"


class LlmUnavailable(Exception):
    """Scoring/generation can't run (no key, unsupported provider). The message is shown to the user."""


@dataclass
class LlmSettings:
    provider: str
    api_key: str
    model: str


def get_settings(db: Session) -> LlmSettings:
    def value(key: str) -> str | None:
        row = db.query(models.SystemSetting).filter(models.SystemSetting.key == key).first()
        return row.value if row else None

    return LlmSettings(
        provider=value("llm_provider") or "gemini",
        api_key=value("api_key") or "",
        model=value("gemini_model") or DEFAULT_MODEL,
    )


def generate(cfg: LlmSettings, prompt: str, json_mode: bool, timeout: int) -> str:
    if not cfg.api_key:
        raise LlmUnavailable(f"API Key missing for {cfg.provider}.")
    if cfg.provider != "gemini":
        raise LlmUnavailable(f"Provider '{cfg.provider}' is not yet fully implemented in the backend.")

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{cfg.model}:generateContent"
    payload: dict = {"contents": [{"parts": [{"text": prompt}]}]}
    if json_mode:
        payload["generationConfig"] = {"response_mime_type": "application/json"}
    res = requests.post(url, json=payload, headers={"x-goog-api-key": cfg.api_key}, timeout=timeout)
    res.raise_for_status()
    return res.json()["candidates"][0]["content"]["parts"][0]["text"]
