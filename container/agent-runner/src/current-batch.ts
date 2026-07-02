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
 * Bodies of content already delivered via `send_message`/`send_file` during
 * the turn currently in flight. Poll-loop's end-of-turn text (both bare
 * scratchpad and wrapped `<message>` blocks) is checked against this list —
 * via `consumeToolSentBodiesThisTurn()`, once per 'result' event — so it
 * never leaks into the next turn.
 *
 * Exists because a turn that calls the tool and then *also* repeats the
 * same content in its final output (bare, or wrapped in its own
 * `<message>` block) was being delivered a second time — the "double
 * message" bug. Tracking exact bodies (not just "a tool fired") lets the
 * dedup be precise: only content that's a verbatim repeat gets dropped,
 * so a turn that legitimately sends a brief tool-based ack and then a
 * genuinely different final message is untouched.
 */
let toolSentBodiesThisTurn: string[] = [];

export function recordToolSentBody(text: string): void {
  toolSentBodiesThisTurn.push(text.trim());
}

export function consumeToolSentBodiesThisTurn(): string[] {
  const bodies = toolSentBodiesThisTurn;
  toolSentBodiesThisTurn = [];
  return bodies;
}

