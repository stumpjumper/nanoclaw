#!/usr/bin/env python3
"""
Fetch YouTube channel RSS and return structured video metadata as JSON.
Usage: python3 youtube-rss-check.py <rss_url>
Outputs a JSON array (most recent first) to stdout.
Exit code 0 on success, 1 on error.
"""

import sys
import json
import re
import urllib.request
import xml.etree.ElementTree as ET


NS = {
    'atom': 'http://www.w3.org/2005/Atom',
    'yt': 'http://www.youtube.com/xml/schemas/2015',
    'media': 'http://search.yahoo.com/mrss/',
}


def extract_video_id(url):
    m = re.search(r'(?:v=|/shorts/)([A-Za-z0-9_-]{11})', url)
    return m.group(1) if m else None


def detect_short(title, url):
    if '#shorts' in title.lower():
        return True
    if '/shorts/' in url:
        return True
    return False


def main():
    if len(sys.argv) < 2:
        print("Usage: youtube-rss-check.py <rss_url>", file=sys.stderr)
        sys.exit(1)

    rss_url = sys.argv[1]

    try:
        req = urllib.request.Request(rss_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            xml_data = resp.read()
    except Exception as e:
        print(f"Failed to fetch RSS: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        root = ET.fromstring(xml_data)
    except ET.ParseError as e:
        print(f"Failed to parse RSS XML: {e}", file=sys.stderr)
        sys.exit(1)

    entries = []
    for entry in root.findall('atom:entry', NS):
        title_el = entry.find('atom:title', NS)
        link_el = entry.find('atom:link', NS)
        published_el = entry.find('atom:published', NS)
        video_id_el = entry.find('yt:videoId', NS)

        title = title_el.text if title_el is not None else ''
        url = link_el.get('href') if link_el is not None else ''
        published = published_el.text if published_el is not None else ''
        video_id = video_id_el.text if video_id_el is not None else extract_video_id(url)

        entries.append({
            'title': title,
            'url': url,
            'video_id': video_id,
            'published': published,
            'is_short': detect_short(title, url),
        })

    print(json.dumps(entries, indent=2))


if __name__ == '__main__':
    main()
