#!/usr/bin/env python3
"""
Search YouTube for recent videos using the YouTube Data API v3.
Usage: python3 youtube-search.py --query QUERY [--max-results N] [--hours-back N]
Reads YOUTUBE_API_KEY from environment.
Outputs a JSON array to stdout.
Exit code 0 on success, 1 on error.
"""

import sys
import os
import json
import re
import argparse
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta


def parse_iso_duration(duration):
    """Parse ISO 8601 duration string (e.g. PT4M13S) to seconds."""
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', duration or '')
    if not m:
        return 0
    return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)


def api_get(url, params):
    full_url = url + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(full_url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--query', required=True)
    parser.add_argument('--max-results', type=int, default=5)
    parser.add_argument('--hours-back', type=int, default=48)
    args = parser.parse_args()

    api_key = os.environ.get('YOUTUBE_API_KEY')
    if not api_key:
        print("YOUTUBE_API_KEY not set in environment", file=sys.stderr)
        sys.exit(1)

    published_after = (
        datetime.now(timezone.utc) - timedelta(hours=args.hours_back)
    ).strftime('%Y-%m-%dT%H:%M:%SZ')

    try:
        search_data = api_get('https://www.googleapis.com/youtube/v3/search', {
            'key': api_key,
            'q': args.query,
            'type': 'video',
            'order': 'date',
            'publishedAfter': published_after,
            'maxResults': args.max_results,
            'part': 'snippet',
        })
    except Exception as e:
        print(f"Search API error: {e}", file=sys.stderr)
        sys.exit(1)

    items = search_data.get('items', [])
    if not items:
        print('[]')
        return

    video_ids = [item['id']['videoId'] for item in items]

    try:
        videos_data = api_get('https://www.googleapis.com/youtube/v3/videos', {
            'key': api_key,
            'id': ','.join(video_ids),
            'part': 'contentDetails',
        })
    except Exception as e:
        print(f"Videos API error: {e}", file=sys.stderr)
        sys.exit(1)

    duration_map = {
        v['id']: parse_iso_duration(v['contentDetails']['duration'])
        for v in videos_data.get('items', [])
    }

    results = []
    for item in items:
        video_id = item['id']['videoId']
        snippet = item['snippet']
        title = snippet.get('title', '')
        channel = snippet.get('channelTitle', '')
        published = snippet.get('publishedAt', '')
        url = f'https://www.youtube.com/watch?v={video_id}'
        duration_seconds = duration_map.get(video_id, 0)

        results.append({
            'video_id': video_id,
            'title': title,
            'url': url,
            'channel_name': channel,
            'published': published,
            'duration_seconds': duration_seconds,
        })

    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
