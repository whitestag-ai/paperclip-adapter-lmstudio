/**
 * Infer a terminal issue status from the LLM's final text message.
 *
 * Local MLX models occasionally finish a heartbeat without calling
 * `paperclip_update_issue` — but they almost always state completion in
 * plain text ("Task WHI-427 abgeschlossen", "marked as done", "Triage
 * abgeschlossen"). The adapter post-run guard reads that text and, when it
 * is unambiguous, auto-closes the issue as `done` instead of the safer-but-
 * spammier `blocked`.
 *
 * Conservative bar:
 *   - The message must contain a recognized completion phrase, AND
 *   - The message must mention at least one issue identifier (e.g. `WHI-427`).
 *
 * Returns `"done"` when both signals are present, `null` otherwise.
 */

const ISSUE_IDENTIFIER = /\b[A-Z]{2,8}-\d+\b/;

const COMPLETION_PHRASES: readonly RegExp[] = [
  /\babgeschlossen\b/i,
  /\bmarked as done\b/i,
];

export function inferTerminalStatusFromFinalMessage(message: string): "done" | null {
  if (!message) return null;
  if (!ISSUE_IDENTIFIER.test(message)) return null;
  const hasPhrase = COMPLETION_PHRASES.some((rx) => rx.test(message));
  if (!hasPhrase) return null;
  return "done";
}
