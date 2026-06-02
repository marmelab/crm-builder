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
// `sawResult` is the key discriminator. The CLI emits a terminal `result` event
// once Claude's loop finishes. If we saw it, Claude completed — a blocking hook
// (exit 2, whose stderr the model already saw), a crashed tool, or a non-zero
// exit from killing a zombie subagent after the result are all just noise, and
// the turn only fails if Claude itself reported an error (`resultError`).
//
// A turn fails when:
//   - resultError — the CLI's own terminal `result.is_error`, set when the API
//     errored after retries (tool failures surface as `tool_result.is_error` and
//     leave the final result `success`, so they don't trip this).
//   - OR the CLI died WITHOUT emitting a `result` (!sawResult) and either an
//     auth/connectivity signature is on stderr (an API error killed it before
//     the result, so resultError alone would miss it) or it exited non-zero /
//     threw (exitCode null) — it died mid-flight (crash, OOM, kill). This must
//     stay a resumable 'error' so the crash-recovery resume path can rebuild
//     state; settling it on 'completed' would strand an interrupted run.
//
// Once a `result` WAS seen, the turn never fails on stderr or exit code: a
// benign 'network'/'authentication'/'401' substring anywhere in the spawn's
// accumulated stderr (CLI retry logging, forwarded tool/hook output), or a
// non-zero exit from a post-result zombie kill, is just noise and must not flip
// a clean completion to 'error'. The stderr check is therefore gated on
// !sawResult — exactly the case its signatures describe.
export function turnFailedFrom({ resultError, stderr, sawResult, exitCode } = {}) {
  if (resultError) return true;
  if (sawResult) return false;
  return isApiErrorStderr(stderr || '') || exitCode !== 0;
}
