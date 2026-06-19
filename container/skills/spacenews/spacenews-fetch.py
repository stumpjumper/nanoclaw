#!/usr/bin/env python3
"""
spacenews-fetch.py — Fetch new articles from RSS feeds.

Reads a sources config, compares against a state file, and prints a JSON
array of new items to stdout. Updates the state file in place (unless --dry-run).
Article content fetching is handled by the watchlist service when the URL is added.

Usage:
  python3 spacenews-fetch.py \\
    --sources /workspace/agent/spacenews-sources.json \\
    --state /workspace/agent/spacenews-state.json \\
    [--dry-run]
"""

import argparse
import json
import sys
import urllib.request
import urllib.error
from xml.etree import ElementTree as ET
from datetime import datetime, timezone, timedelta

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}
FETCH_TIMEOUT = 20
STATE_RETENTION_DAYS = 90


# ── RSS parser ──────────────────────────────────────────────────────────────

def fetch_rss(url: str) -> list[dict]:
    """Return list of {title, url, pub_date} from an RSS/Atom feed."""
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            raw = resp.read()
    except urllib.error.URLError as e:
        print(f"[spacenews] RSS fetch failed for {url}: {e}", file=sys.stderr)
        return []

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        print(f"[spacenews] RSS parse error for {url}: {e}", file=sys.stderr)
        return []

    ns = {
        'atom': 'http://www.w3.org/2005/Atom',
        'media': 'http://search.yahoo.com/mrss/',
    }

    items = []

    # RSS 2.0
    for item in root.findall('.//item'):
        title_el = item.find('title')
        link_el = item.find('link')
        pub_el = item.find('pubDate')
        if title_el is None or link_el is None:
            continue
        title = (title_el.text or '').strip()
        link = (link_el.text or '').strip()
        pub_date = (pub_el.text or '').strip() if pub_el is not None else ''
        if title and link:
            items.append({'title': title, 'url': link, 'pub_date': pub_date})

    # Atom (fallback)
    if not items:
        for entry in root.findall('atom:entry', ns):
            title_el = entry.find('atom:title', ns)
            link_el = entry.find('atom:link', ns)
            pub_el = entry.find('atom:published', ns) or entry.find('atom:updated', ns)
            if title_el is None or link_el is None:
                continue
            title = (title_el.text or '').strip()
            link = link_el.get('href', '').strip()
            pub_date = (pub_el.text or '').strip() if pub_el is not None else ''
            if title and link:
                items.append({'title': title, 'url': link, 'pub_date': pub_date})

    return items


# ── State management ────────────────────────────────────────────────────────

def load_state(path: str) -> dict:
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {'seen': {}}


def save_state(path: str, state: dict) -> None:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=STATE_RETENTION_DAYS)).isoformat()
    state['seen'] = {url: ts for url, ts in state['seen'].items() if ts >= cutoff}
    with open(path, 'w') as f:
        json.dump(state, f, indent=2)


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--sources', required=True, help='Path to spacenews-sources.json')
    p.add_argument('--state', required=True, help='Path to spacenews-state.json')
    p.add_argument('--dry-run', action='store_true', help='Print results without updating state')
    args = p.parse_args()

    with open(args.sources) as f:
        config = json.load(f)

    state = load_state(args.state)
    now_iso = datetime.now(timezone.utc).isoformat()

    new_articles: list[dict] = []

    for feed in config.get('feeds', []):
        feed_name = feed.get('name', 'Unknown')
        rss_url = feed.get('rss', '')
        emoji = feed.get('emoji', '📰')

        print(f"[spacenews] Checking feed: {feed_name} ({rss_url})", file=sys.stderr)
        items = fetch_rss(rss_url)
        print(f"[spacenews] Found {len(items)} items in feed", file=sys.stderr)

        for item in items:
            url = item['url']
            if url in state['seen']:
                continue

            print(f"[spacenews] New article: {item['title']}", file=sys.stderr)

            new_articles.append({
                'title': item['title'],
                'url': url,
                'pub_date': item['pub_date'],
                'feed_name': feed_name,
                'emoji': emoji,
            })

            state['seen'][url] = now_iso

    print(json.dumps(new_articles, ensure_ascii=False))

    if not args.dry_run:
        save_state(args.state, state)
    else:
        print(f"[spacenews] Dry run — state not updated. Would mark {len(new_articles)} articles as seen.", file=sys.stderr)


if __name__ == '__main__':
    main()
