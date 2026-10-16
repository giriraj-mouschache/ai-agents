"""Plain-language rules: when a result mentions certain words, notify, rank higher, or hide it."""
from __future__ import annotations


def apply_rules(topic_name: str, items: list, rules: list[dict]) -> list:
    """Return the items that survive 'mute' rules, with 'boost' (+2 score) and 'notify' applied in place."""
    if not rules:
        return items
    kept = []
    for item in items:
        text = f"{item.title} {item.summary} {item.url}".lower()
        muted = False
        for rule in rules:
            if rule["topic"] and rule["topic"].lower() != topic_name.lower():
                continue
            if not any(word.lower() in text for word in rule["match"]):
                continue
            if rule["action"] == "mute":
                muted = True
                break
            if rule["action"] == "boost" and item.score is not None:
                item.score = min(10.0, item.score + 2)
            elif rule["action"] == "notify":
                item.notify = True
                item.rule = rule["name"]
        if not muted:
            kept.append(item)
    return kept
