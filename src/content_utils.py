"""Helpers for normalizing LLM content to plain text."""

from __future__ import annotations


def normalize_content_to_text(content: object) -> str:
    """Collapse rich content parts (Responses API) into plain text."""
    if isinstance(content, list):
        parts = (part.get("text", "") for part in content if isinstance(part, dict))
        return " ".join(p for p in parts if p).strip()
    return str(content or "").strip()
