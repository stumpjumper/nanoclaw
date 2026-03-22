#!/usr/bin/env python3
"""
Fetch a YouTube video transcript.
Usage: python3 youtube-transcript.py <youtube_url_or_video_id>
Outputs clean transcript text to stdout, error message to stderr.
Exit code 0 on success, 1 on failure.
"""

import sys
import re

def extract_video_id(url_or_id):
    """Extract video ID from a YouTube URL or return the ID directly."""
    patterns = [
        r'(?:v=|/v/|youtu\.be/|/embed/|/shorts/)([A-Za-z0-9_-]{11})',
        r'^([A-Za-z0-9_-]{11})$',
    ]
    for pattern in patterns:
        match = re.search(pattern, url_or_id)
        if match:
            return match.group(1)
    return None

def main():
    if len(sys.argv) < 2:
        print("Usage: youtube-transcript.py <youtube_url_or_video_id>", file=sys.stderr)
        sys.exit(1)

    arg = sys.argv[1]
    video_id = extract_video_id(arg)

    if not video_id:
        print(f"Could not extract video ID from: {arg}", file=sys.stderr)
        sys.exit(1)

    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api._errors import NoTranscriptFound, TranscriptsDisabled
    except ImportError:
        print("youtube-transcript-api not installed. Run: pip3 install youtube-transcript-api", file=sys.stderr)
        sys.exit(1)

    api = YouTubeTranscriptApi()

    try:
        transcript_list = api.list(video_id)

        # Prefer manual English, then auto-generated English, then anything translated
        transcript = None
        try:
            transcript = transcript_list.find_manually_created_transcript(['en', 'en-US', 'en-GB'])
        except NoTranscriptFound:
            pass

        if transcript is None:
            try:
                transcript = transcript_list.find_generated_transcript(['en', 'en-US', 'en-GB'])
            except NoTranscriptFound:
                pass

        if transcript is None:
            transcript = next(iter(transcript_list))
            if not transcript.language_code.startswith('en'):
                transcript = transcript.translate('en')

        entries = transcript.fetch()

        text_parts = []
        for entry in entries:
            text = entry.get('text', '').strip() if isinstance(entry, dict) else str(entry.text).strip()
            if text:
                text_parts.append(text)

        print(' '.join(text_parts))

    except TranscriptsDisabled:
        print(f"Transcripts are disabled for video {video_id}", file=sys.stderr)
        sys.exit(1)
    except NoTranscriptFound:
        print(f"No transcript found for video {video_id}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error fetching transcript for {video_id}: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
