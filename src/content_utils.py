"""Helpers for normalizing LLM content to plain text."""

from __future__ import annotations


def normalize_content_to_text(content: object) -> str:
    """Collapse rich content parts (Responses API) into plain text."""
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict):
                parts.append(str(part.get("text") or part.get("content") or ""))
            elif isinstance(part, str):
                parts.append(part)
        return " ".join(p for p in parts if p).strip()
    if isinstance(content, dict):
        return str(content.get("text") or content.get("content") or "").strip()
    return str(content or "").strip()
