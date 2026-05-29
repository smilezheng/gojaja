/**
 * Standard "what to do next" hint, appended to the plain-text output
 * of action commands so an agent's per-turn loop doesn't stall after
 * a successful side-effect.
 *
 * The risk this guards: an agent runs `worklog` / `report` /
 * `task status` / `rfc comment` / etc., sees the command succeed, and
 * concludes the turn is done — exiting silently. The framework needs
 * the agent to either keep working OR park on `gojaja wait` so the
 * next event can wake it. Without one of those, the role goes dark
 * and the team stops driving forward; on a single-machine setup
 * (where there is no external scheduler) the only recourse is for
 * the human to nudge the role manually, which defeats the point.
 *
 * The hint is not authoritative protocol — the handbook + runtime
 * body still teach the loop — but it is a last-mile reminder right
 * at the moment the agent is most likely to forget (immediately
 * after a successful side-effect command's confirmation line).
 *
 * Skipped:
 *  - in `--json` mode (output must stay a single parseable object);
 *  - when the actor is `"SYSTEM"` or absent (a human running the CLI
 *    has no per-turn loop to keep alive).
 */
export function nextLoopHint(opts: {
  json: boolean;
  actor: string | null | undefined;
}): string {
  if (opts.json) return "";
  if (!opts.actor || opts.actor === "SYSTEM") return "";
  return (
    `\nNext: continue this turn with another action, or run ` +
    "`gojaja plan` (see new events) / `gojaja wait` (park until " +
    "attention). Ending without one stalls the role.\n"
  );
}

/**
 * Specialised hint for `claim`: the immediate next step is to read
 * the manifest, not to start a new action — that is what `plan` is
 * for. Same skip rules as `nextLoopHint`.
 */
export function claimHint(opts: { json: boolean }): string {
  if (opts.json) return "";
  return "\nNext: run `gojaja plan` to read your manifest.\n";
}
