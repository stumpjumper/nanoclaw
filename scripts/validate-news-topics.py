#!/usr/bin/env python3
"""
Validates groups/telegram_news/grok-topics.json

Usage:
    python3 scripts/validate-news-topics.py

Checks:
- Valid JSON
- Each topic has required fields: keywords, defaultTimeframe, query
- keywords is a non-empty list of strings
- No duplicate keywords across topics
- query contains {timeframe} placeholder
- Optional fields (query_cheap, query_expensive) also contain {timeframe} if present
"""

import json
import sys
from pathlib import Path

TOPICS_FILE = Path(__file__).parent.parent / "groups" / "telegram_news" / "grok-topics.json"

def error(msg):
    print(f"  ❌ {msg}")
    return False

def ok(msg):
    print(f"  ✅ {msg}")
    return True

def main():
    print(f"Validating {TOPICS_FILE}\n")

    # Check file exists
    if not TOPICS_FILE.exists():
        print(f"❌ File not found: {TOPICS_FILE}")
        sys.exit(1)

    # Check valid JSON
    try:
        with open(TOPICS_FILE) as f:
            topics = json.load(f)
        print("✅ Valid JSON\n")
    except json.JSONDecodeError as e:
        print(f"❌ Invalid JSON: {e}")
        sys.exit(1)

    # Check top-level is a list
    if not isinstance(topics, list):
        print("❌ Top-level must be a JSON array")
        sys.exit(1)

    if len(topics) == 0:
        print("❌ No topics found")
        sys.exit(1)

    all_keywords = []
    all_passed = True

    for i, topic in enumerate(topics):
        print(f"Topic {i+1}:")
        passed = True

        # Required fields
        for field in ["keywords", "defaultTimeframe", "query"]:
            if field not in topic:
                passed = error(f"Missing required field: '{field}'")

        if not passed:
            all_passed = False
            print()
            continue

        # keywords must be a non-empty list of strings
        kws = topic["keywords"]
        if not isinstance(kws, list) or len(kws) == 0:
            passed = error("'keywords' must be a non-empty list")
        elif not all(isinstance(k, str) for k in kws):
            passed = error("All keywords must be strings")
        else:
            ok(f"keywords: {kws}")

            # Check for duplicates against previous topics
            for kw in kws:
                if kw.lower() in [k.lower() for k in all_keywords]:
                    passed = error(f"Duplicate keyword: '{kw}'")
                else:
                    all_keywords.append(kw)

        # defaultTimeframe must be a non-empty string
        tf = topic["defaultTimeframe"]
        if not isinstance(tf, str) or not tf.strip():
            passed = error("'defaultTimeframe' must be a non-empty string")
        else:
            ok(f"defaultTimeframe: {tf}")

        # query must contain {timeframe}
        for field in ["query", "query_cheap", "query_expensive"]:
            if field not in topic:
                continue
            val = topic[field]
            if not isinstance(val, str) or not val.strip():
                passed = error(f"'{field}' must be a non-empty string")
            elif "{timeframe}" not in val:
                passed = error(f"'{field}' must contain {{timeframe}} placeholder")
            else:
                preview = val[:60].replace("\n", " ") + ("..." if len(val) > 60 else "")
                ok(f"{field}: \"{preview}\"")

        if passed:
            print(f"  — Topic {i+1} OK")
        else:
            all_passed = False
        print()

    if all_passed:
        print(f"✅ All {len(topics)} topics valid.")
        print()
        print("⚠️  Remember to update keywords-response.md if you added or changed any topics!")
        print(f"   {TOPICS_FILE.parent / 'keywords-response.md'}")
        sys.exit(0)
    else:
        print("❌ Validation failed — fix the errors above.")
        sys.exit(1)

if __name__ == "__main__":
    main()
