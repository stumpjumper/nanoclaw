#!/usr/bin/env python3
"""
Search YouTube for recent videos using the YouTube Data API v3.
Three-step: /search → /videos (duration + stats) → /channels (subscribers).
Applies quality filters before returning results.

Reads YOUTUBE_API_KEY from environment. Bypasses the OneCLI HTTPS proxy so
Google's googleapis.com OAuth handling doesn't interfere with API key injection.

Usage: python3 youtube-search.py --query QUERY [options]
Outputs a JSON array of passing videos to stdout.
"""

import sys
import os
import json
import re
import argparse
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

# Bypass the OneCLI HTTPS proxy — it treats all *.googleapis.com as OAuth
# domains. YouTube Data API only needs an API key, not OAuth.
_direct_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def parse_iso_duration(s):
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', s or '')
    if not m:
        return 0
    return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)


def api_get(url, params):
    full = url + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(full, headers={'User-Agent': 'Mozilla/5.0'})
    with _direct_opener.open(req, timeout=15) as r:
        return json.loads(r.read())


def main():
    api_key = os.environ.get('YOUTUBE_API_KEY')
    if not api_key:
        print("YOUTUBE_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    p = argparse.ArgumentParser()
    p.add_argument('--query', required=True)
    p.add_argument('--max-results', type=int, default=10,
                   help='Results to fetch from search (before filtering)')
    p.add_argument('--hours-back', type=int, default=48)
    p.add_argument('--min-duration', type=int, default=0,
                   help='Minimum video duration in seconds')
    p.add_argument('--min-views', type=int, default=0)
    p.add_argument('--min-like-ratio', type=float, default=0.0,
                   help='Minimum likes/views ratio (e.g. 0.02 = 2%%)')
    p.add_argument('--min-subscribers', type=int, default=0,
                   help='Minimum channel subscriber count; channels with hidden counts are excluded')
    p.add_argument('--video-duration', default='any',
                   choices=['any', 'short', 'medium', 'long'],
                   help='API-level duration filter: short (<4m), medium (4-20m), long (>20m)')
    args = p.parse_args()

    published_after = (
        datetime.now(timezone.utc) - timedelta(hours=args.hours_back)
    ).strftime('%Y-%m-%dT%H:%M:%SZ')

    # Step 1 — Search
    try:
        search_params = {
            'key': api_key,
            'q': args.query,
            'type': 'video',
            'order': 'date',
            'publishedAfter': published_after,
            'maxResults': args.max_results,
            'part': 'snippet',
        }
        if args.video_duration != 'any':
            search_params['videoDuration'] = args.video_duration
        search = api_get('https://youtube.googleapis.com/youtube/v3/search', search_params)
    except Exception as e:
        print(f"Search API error: {e}", file=sys.stderr)
        sys.exit(1)

    items = search.get('items', [])
    if not items:
        print('[]')
        return

    video_ids = [i['id']['videoId'] for i in items]
    channel_ids = list({i['snippet']['channelId'] for i in items})
    snippets = {i['id']['videoId']: i['snippet'] for i in items}

    # Step 2 — Video details: duration + view/like counts (one call, 1 quota unit)
    try:
        vids = api_get('https://youtube.googleapis.com/youtube/v3/videos', {
            'key': api_key,
            'id': ','.join(video_ids),
            'part': 'contentDetails,statistics',
        })
    except Exception as e:
        print(f"Videos API error: {e}", file=sys.stderr)
        sys.exit(1)

    vid_map = {}
    for v in vids.get('items', []):
        stats = v.get('statistics', {})
        vid_map[v['id']] = {
            'duration_seconds': parse_iso_duration(v['contentDetails'].get('duration')),
            'view_count': int(stats.get('viewCount', 0) or 0),
            'like_count': int(stats.get('likeCount', 0) or 0),
        }

    # Step 3 — Channel subscriber counts (one batch call, 1 quota unit)
    chan_map = {}
    try:
        chans = api_get('https://youtube.googleapis.com/youtube/v3/channels', {
            'key': api_key,
            'id': ','.join(channel_ids),
            'part': 'statistics',
        })
        for c in chans.get('items', []):
            stats = c.get('statistics', {})
            chan_map[c['id']] = {
                'subscriber_count': int(stats.get('subscriberCount', 0) or 0),
                'hidden': bool(stats.get('hiddenSubscriberCount', False)),
            }
    except Exception as e:
        print(f"Channels API error (non-fatal): {e}", file=sys.stderr)

    results = []
    for video_id in video_ids:
        snippet = snippets.get(video_id, {})
        vd = vid_map.get(video_id, {})
        channel_id = snippet.get('channelId', '')
        cd = chan_map.get(channel_id, {})

        duration = vd.get('duration_seconds', 0)
        views = vd.get('view_count', 0)
        likes = vd.get('like_count', 0)
        subs = cd.get('subscriber_count', 0)
        hidden_subs = cd.get('hidden', False)

        # Duration filter
        if args.min_duration > 0 and duration < args.min_duration:
            continue
        # View count filter
        if args.min_views > 0 and views < args.min_views:
            continue
        # Like ratio filter (only applied when there are enough views to be meaningful)
        if args.min_like_ratio > 0 and views >= 100:
            if likes / views < args.min_like_ratio:
                continue
        # Subscriber filter — hidden counts treated as failing
        if args.min_subscribers > 0:
            if hidden_subs or subs < args.min_subscribers:
                continue

        results.append({
            'video_id': video_id,
            'title': snippet.get('title', ''),
            'url': f"https://www.youtube.com/watch?v={video_id}",
            'channel_name': snippet.get('channelTitle', ''),
            'channel_id': channel_id,
            'published': snippet.get('publishedAt', ''),
            'duration_seconds': duration,
            'view_count': views,
            'like_count': likes,
            'subscriber_count': subs,
        })

    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
