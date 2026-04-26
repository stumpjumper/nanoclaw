#!/usr/bin/env python3
"""
Search YouTube for recent videos using the YouTube Data API v3.

Two modes:
  --query QUERY     Keyword search via /search (3 API calls)
  --playlist-id ID  Playlist fetch via /playlistItems (3 API calls)

Both modes: /videos (duration + stats + description) → /channels (subscribers).
Applies quality filters before returning results.

Reads YOUTUBE_API_KEY from environment. Bypasses the OneCLI HTTPS proxy so
Google's googleapis.com OAuth handling doesn't interfere with API key injection.
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
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--query', help='Keyword search query')
    mode.add_argument('--playlist-id', help='YouTube playlist ID (fetches items instead of searching)')
    p.add_argument('--max-results', type=int, default=10,
                   help='Results to fetch before filtering (max 50 for playlist mode)')
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
                   help='API-level duration filter (search mode only): short (<4m), medium (4-20m), long (>20m)')
    args = p.parse_args()

    cutoff = datetime.now(timezone.utc) - timedelta(hours=args.hours_back)

    # ── Step 1: Collect video IDs and basic metadata ──────────────────────────

    video_ids = []
    snippets = {}   # video_id → {title, channelId, channelTitle, publishedAt}

    if args.query:
        # Search mode
        try:
            search_params = {
                'key': api_key,
                'q': args.query,
                'type': 'video',
                'order': 'date',
                'publishedAfter': cutoff.strftime('%Y-%m-%dT%H:%M:%SZ'),
                'maxResults': args.max_results,
                'part': 'snippet',
            }
            if args.video_duration != 'any':
                search_params['videoDuration'] = args.video_duration
            search = api_get('https://youtube.googleapis.com/youtube/v3/search', search_params)
        except Exception as e:
            print(f"Search API error: {e}", file=sys.stderr)
            sys.exit(1)

        for item in search.get('items', []):
            vid_id = item['id']['videoId']
            video_ids.append(vid_id)
            snippets[vid_id] = item['snippet']

    else:
        # Playlist mode
        try:
            playlist = api_get('https://www.googleapis.com/youtube/v3/playlistItems', {
                'key': api_key,
                'playlistId': args.playlist_id,
                'part': 'snippet,contentDetails',
                'maxResults': min(args.max_results, 50),
            })
        except Exception as e:
            print(f"PlaylistItems API error: {e}", file=sys.stderr)
            sys.exit(1)

        for item in playlist.get('items', []):
            vid_id = item['snippet']['resourceId']['videoId']
            # videoPublishedAt is the actual upload date; publishedAt is when added to playlist
            published_str = (item['contentDetails'].get('videoPublishedAt')
                             or item['snippet'].get('publishedAt', ''))
            try:
                published_dt = datetime.fromisoformat(published_str.replace('Z', '+00:00'))
            except Exception:
                published_dt = datetime.now(timezone.utc)

            if published_dt < cutoff:
                continue  # playlist is newest-first, but check all in case of re-ordering

            video_ids.append(vid_id)
            snippets[vid_id] = {
                'title': item['snippet'].get('title', ''),
                'channelId': item['snippet'].get('videoOwnerChannelId', ''),
                'channelTitle': item['snippet'].get('videoOwnerChannelTitle', ''),
                'publishedAt': published_str,
            }

    if not video_ids:
        print('[]')
        return

    channel_ids = list({s['channelId'] for s in snippets.values() if s.get('channelId')})

    # ── Step 2: Video details — duration + stats + description (1 quota unit) ─

    try:
        vids = api_get('https://youtube.googleapis.com/youtube/v3/videos', {
            'key': api_key,
            'id': ','.join(video_ids),
            'part': 'contentDetails,statistics,snippet',
        })
    except Exception as e:
        print(f"Videos API error: {e}", file=sys.stderr)
        sys.exit(1)

    vid_map = {}
    for v in vids.get('items', []):
        stats = v.get('statistics', {})
        desc = v.get('snippet', {}).get('description', '')
        vid_map[v['id']] = {
            'duration_seconds': parse_iso_duration(v['contentDetails'].get('duration')),
            'view_count': int(stats.get('viewCount', 0) or 0),
            'like_count': int(stats.get('likeCount', 0) or 0),
            'description': desc[:600],
        }

    # ── Step 3: Channel subscriber counts (1 quota unit) ─────────────────────

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

    # ── Filter and build results ──────────────────────────────────────────────

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

        if args.min_duration > 0 and duration < args.min_duration:
            continue
        if args.min_views > 0 and views < args.min_views:
            continue
        if args.min_like_ratio > 0 and views >= 100:
            if likes / views < args.min_like_ratio:
                continue
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
            'description': vd.get('description', ''),
        })

    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
