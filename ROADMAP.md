# Roadmap

Product direction and open work for this fork. Machine-local chores live in `TODO.md`
(git-ignored); incident history and root-cause narrative live in the agent memory tree
at `~/.claude/projects/-Users-nano-projects-nanoclaw/memory/`.

Last reviewed: 2026-08-16.

---

## Upstream contribution queue

All PRs target `nanocoai/nanoclaw` and are branched from clean `upstream/main` — never
from this fork's `main`, which carries installation-specific divergence.

Before opening anything new, re-read `CONTRIBUTING.md`. The binding constraint: source
changes are limited to **bug fixes, security fixes, simplifications, and code reduction**.
Features and capabilities are declined and belong in skills — PR #1754 (a Python-dependency
feature PR) was closed with no discussion, which is the precedent to expect.

| # | What | Opened | Status |
|---|---|---|---|
| [#3280](https://github.com/nanocoai/nanoclaw/pull/3280) | `ncl groups config update` can set a nullable scalar but never clear it (`--model ""` stored the empty string, which reached the runtime) | 2026-08-16 | Open. Bug fix + 3 regression tests verified to fail without it. Best odds of the set. |
| [#3216](https://github.com/nanocoai/nanoclaw/pull/3216) | Document that `install_packages` covers apt and npm only | 2026-08-16 | Open. Docs only. |
| [#3217](https://github.com/nanocoai/nanoclaw/issues/3217) | Issue: no pip channel in `install_packages`, which blocks hardened-image adoption for Python-dependent installs | 2026-08-16 | Open. Filed as an issue, not a PR, because the fix is a capability. Offers three directions; we implement whichever maintainers pick. |
| [#2956](https://github.com/nanocoai/nanoclaw/pull/2956) | Suppress duplicate delivery when final output repeats tool-sent content | 2026-07-04 | Open, unreviewed. |
| [#2910](https://github.com/nanocoai/nanoclaw/pull/2910) | Forbid repeating `send_message` content in the final `<message>` block | 2026-07-02 | Open. A contributor confirmed they reproduce the same duplicate. Complements #2956. |
| [#2036](https://github.com/nanocoai/nanoclaw/pull/2036) | Per-group container env vars, DB-managed via `ncl groups config set-env` | 2026-04-26 | Open, mergeable. Refreshed 2026-07-04 to the DB-backed shape. |
| [#2011](https://github.com/nanocoai/nanoclaw/pull/2011) | Fail closed on an invalid `engage_pattern` regex | 2026-04-25 | Open, no reviews. Upstream's code carries a deliberate "fail open" comment predating the PR — this is a policy disagreement awaiting a maintainer opinion, not a stale patch. |

Not yet opened:

- **Agent-runner compile cache + `claw` auth fix.** Cherry-pick onto a clean branch: store
  the source hash at build time so the entrypoint skips recompiling; create `/app/dist-cache`
  owned by `node` so `claw` works without a host mount; pass secrets to `scripts/claw` as
  `-e` env vars rather than a JSON payload. Include only these commits, no fork customizations.

## Scheduled revisits

- **Per-group model choice** — revisit every few months and whenever a new tier ships.
  Four groups run `opus`, four run the Sonnet default (see `CLAUDE.md` and
  `memory/project_infrastructure.md` for the table). Check: has a new tier appeared
  (`fable` currently sits above `opus`)? Do the Claude Code aliases still resolve
  (`/pnpm/claude --help` in the agent image)? Has the judgment/mechanical split changed?
  Are Pro usage limits biting — the symptom is a scheduled run failing, not a bill.
- **Hardened agent image** — declined 2026-08-16 and recorded in
  `memory/project_hardened_image_declined.md`. Revisit only if upstream adds a pip channel
  to `install_packages` (see #3217) or we publish our own hardened+customized image.

## Group tuning

- **YouTube — verbose off when stable.** `verbose: true` in `youtube-channels.json`; flip to
  `false` once RSS checks have been reliable for a stretch. RSS was confirmed healthy
  2026-08-16 after the skill-symlink fix, so this is close.
- **YouTube — search thresholds.** Tune `min_views` / `min_like_ratio` / `min_subscribers`
  per search in `youtube-searches.json` based on signal-to-noise. Joe Justice deliberately
  runs lower (`min_subscribers` 3K) to catch indie shows.
- **YouTube — slop filtering on Opus.** Moved to `opus` on 2026-08-16 specifically to improve
  AI-slop and clickbait detection. Watch Andy's reports; this is the one model change with a
  testable outcome.
- **News — dual prompts per topic.** Add optional `query_cheap` / `query_expensive` to
  `grok-topics.json`, falling back to `query`.
- **Gmail — triage tuning.** The notify/review/trash split may still need adjustment; the
  reply feedback loop (agent → email send) is documented but untested end to end.
- **Gmail — `Notifier Trigger` filter.** Currently overused (fires on Darla, self-sent, Sandia
  forwards). Once narrowed to vtext-important senders, re-enable it as a Notify signal.

## Ideas

- **Signal channel** — no upstream skill exists; may need a fork.
- **Local install update notification** — a launchd daily job that checks whether this install
  is behind `origin/main` and sends a Telegram message via the bot API directly (simple curl,
  no NanoClaw dependency).
- **Email cleanup campaign** — help process thousands of old emails; NanoClaw currently
  ignores anything older than its start time.
- **News scheduled briefings** — a morning digest alongside the on-demand queries.
- **Share the YouTube group pattern** — once the RSS/playlist/search/slop-filter setup is
  dialed in, package it as a community reference. It is self-contained enough to be a good
  example.
- **Hermes Agent side-by-side** — evaluating Hermes Agent (NousResearch) alongside NanoClaw.
  Briefing at `~/projects/hermes-briefing.md`; YouTube deep-dive done, remaining groups next.
- **Containerized Claude Code** — a learning project: a second Claude Code instance in Docker
  with its own bot token, to compare the Anthropic-native model against NanoClaw's
  orchestration. Open question is whether the OAuth token holds up long-term in a container.
