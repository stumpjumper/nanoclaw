#!/bin/bash
# Monthly agent-image rebuild.
#
# This install builds its agent image locally rather than pulling the hardened
# prebuilt one (container/Dockerfile bakes in python3, yt-dlp, ffmpeg and the
# Gmail MCP server, which the pulled image does not carry). A local build only
# picks up patched Chromium / Node / OS packages when it actually runs, so this
# runs it on a schedule instead of whenever someone remembers.
#
# Nothing here restarts the service: the image is read at container spawn, so
# each group picks up the new image on its next wake.
#
# Invoked by the com.nanoclaw-v2-<slug>.rebuild LaunchAgent.
set -uo pipefail

# launchd starts jobs with a minimal PATH that has neither Docker nor Homebrew
# on it, so `docker` resolves to nothing and the Docker check below reports a
# false "not running". Put the real locations back before anything runs.
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/Library/pnpm:/usr/bin:/bin:/usr/sbin:/sbin"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

LOG="$PROJECT_ROOT/logs/container-rebuild.log"
mkdir -p "$(dirname "$LOG")"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }

log "=== monthly rebuild starting ==="

# Docker Desktop runs as this same user but may not be up (login session, or a
# reboot the agent hasn't caught up with). Without it, docker build fails with a
# noisy socket error; a clear skip is more useful than a stack trace.
if ! docker info >/dev/null 2>&1; then
  log "SKIP: Docker is not running — will retry next month"
  exit 0
fi

# container/build.sh runs a bare `docker build` with no --pull, so an unchanged
# base tag is served from cache and the rebuild would refresh nothing — the one
# thing this job exists to do. Pull the base ourselves first; if its digest
# moved, every layer above it (Chromium and the other apt packages included)
# rebuilds against the new one. Read FROM out of the Dockerfile so an upstream
# Node bump doesn't leave us refreshing a base we no longer use.
BASE="$(awk '/^FROM /{print $2; exit}' container/Dockerfile)"
BEFORE="$(docker image inspect --format '{{index .RepoDigests 0}}' "$BASE" 2>/dev/null || echo none)"
log "pulling base image $BASE"
docker pull "$BASE" >> "$LOG" 2>&1 || log "WARN: base pull failed — building against the cached base"
AFTER="$(docker image inspect --format '{{index .RepoDigests 0}}' "$BASE" 2>/dev/null || echo none)"
if [ "$BEFORE" = "$AFTER" ]; then
  log "base unchanged ($AFTER)"
else
  log "base updated: $BEFORE -> $AFTER"
fi

if ./container/build.sh >> "$LOG" 2>&1; then
  log "rebuild OK — new spawns will use the refreshed image"
  # Reclaim the layers the rebuild orphaned. Images only; volumes and the
  # session DBs are never touched.
  docker image prune -f >> "$LOG" 2>&1 || true
  log "=== monthly rebuild finished ==="
  exit 0
fi

log "FAILED: ./container/build.sh returned non-zero — see output above"
log "=== monthly rebuild finished (with errors) ==="
exit 1
