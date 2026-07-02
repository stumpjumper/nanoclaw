/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * `inReplyTo` — the id of the first inbound message in the batch the agent
 * is currently processing. MCP tools like `send_message` and `send_file`
 * read this and stamp it onto the outbound row so the host's a2a
 * return-path routing can correlate replies back to the originating
 * session.
 *
 * This is module-level state on purpose: the agent-runner is single-process
 * and processes one batch at a time. Poll-loop calls `setCurrentInReplyTo`
 * before invoking the provider and `clearCurrentInReplyTo` after the batch
 * completes (or errors out).
 */
let currentInReplyTo: string | null = null;

export function setCurrentInReplyTo(id: string | null): void {
  currentInReplyTo = id;
}

export function clearCurrentInReplyTo(): void {
  currentInReplyTo = null;
}

export function getCurrentInReplyTo(): string | null {
  return currentInReplyTo;
}

/**
 * Tracks whether `send_message`/`send_file` already delivered content
 * during the turn currently in flight. Poll-loop's end-of-turn fallback
 * (auto-delivering unwrapped bare text) reads and clears this via
 * `consumeToolSentThisTurn()` once per 'result' event, so it never leaks
 * into the next turn.
 *
 * Exists because a turn ending in bare, unwrapped text that restates
 * content already sent via a tool call was being auto-delivered a second
 * time (the "double message" bug) — the fallback had no way to know a
 * send already happened this turn.
 */
let toolSentThisTurn = false;

export function markToolSentThisTurn(): void {
  toolSentThisTurn = true;
}

export function consumeToolSentThisTurn(): boolean {
  const sent = toolSentThisTurn;
  toolSentThisTurn = false;
  return sent;
}

