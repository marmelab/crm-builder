// Pick the state a finished turn settles on. Pure (no IO) so it can be unit
// tested in isolation — kept out of turn.js to avoid dragging that module's
// spawn/progress-bar import graph into the test.
//
//   - user pressed STOP            → 'cancelled'
//   - rate limit hit               → 'rate_limited' (resumable, with countdown)
//   - turn failed otherwise        → 'error'        (resumable, no countdown)
//   - last message ends with '?'   → 'waiting'      (Claude asked a question)
//   - otherwise                    → 'completed'
//
// `turnFailed` (see `turnFailedFrom`) means CLAUDE itself errored — NOT that a
// hook or tool merely exited non-zero. A clean exit that produced no assistant
// text is also not a failure and completes silently. `asksQuestion` is already
// gated on `!turnErrored` by the caller, so order only matters between the
// error branches and 'waiting'.
export function decideNextState({ wasStopped, rateLimit, turnFailed, asksQuestion }) {
  if (wasStopped) return 'cancelled';
  if (rateLimit) return 'rate_limited';
  if (turnFailed) return 'error';
  if (asksQuestion) return 'waiting';
  return 'completed';
}

// stderr signatures of a genuine Claude API / connectivity failure — an expired
// session/auth or an unreachable service. Kept separate so `friendlyError` can
// phrase each case while the failure decision below reuses the same patterns
// (no drift between "what we show" and "what counts as a failure").
const AUTH_ERROR_RE = /invalid[_ ]api[_ ]key|authentication|unauthori[sz]ed|401/i;
const NETWORK_ERROR_RE = /network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i;

export function isAuthErrorStderr(stderr = '') {
  return AUTH_ERROR_RE.test(stderr);
}
export function isNetworkErrorStderr(stderr = '') {
  return NETWORK_ERROR_RE.test(stderr);
}
export function isApiErrorStderr(stderr = '') {
  return isAuthErrorStderr(stderr) || isNetworkErrorStderr(stderr);
}

// Does a finished turn count as FAILED (→ the resumable 'error' state)? Pure so
// it can be unit tested. The rule is deliberately NARROW: a hook or tool that
// merely exited non-zero while Claude ran to completion is NEVER a failure.
//
// In the PTY model there is no process exit code to inspect — the orchestrator
// runs inside a long-lived PTY screen buffer, not a one-shot child whose exit
// status we observe. `sawResult` is the sole discriminator: the CLI prints a
// terminal `result` event once Claude's loop finishes. If we saw it, Claude
// completed — a blocking hook (exit 2, whose stderr the model already saw) or a
// crashed tool are just noise, and the turn only fails if Claude itself reported
// an error (`resultError`).
//
// A turn fails when:
//   - resultError — the CLI's own terminal `result.is_error`, set when the API
//     errored after retries (tool failures surface as `tool_result.is_error` and
//     leave the final result `success`, so they don't trip this).
//   - OR no `result` ever arrived (!sawResult) — Claude died mid-flight (crash,
//     hang, kill) before completing its loop. This must stay a resumable 'error'
//     so the crash-recovery resume path can rebuild state; settling it on
//     'completed' would strand an interrupted run.
//
// `stderr` no longer participates in the decision — once we keyed off `sawResult`
// alone, a no-result death is ALWAYS a failure whatever the buffer says, and a
// seen-result turn is never a failure. `stderr` is kept only so callers (and
// `friendlyError`) can phrase the auth/network case; it has no say in the
// boolean verdict.
export function turnFailedFrom({ resultError, sawResult } = {}) {
  return Boolean(resultError) || !sawResult;
}

// Full turn-failure decision for the PTY flow. A result that arrived via the
// silence fallback (no Stop-hook sentinel) and produced no text is a failure:
// the orchestrator died or hung without completing. `turnFailedFrom` keeps the
// legacy signature for existing callers/tests and is used as the base rule.
export function classifyTurn({ resultError, sawResult, resultReason, receivedText }) {
  return turnFailedFrom({ resultError, sawResult })
    || (resultReason === 'silence' && !receivedText);
}
