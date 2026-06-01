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
// `turnFailed` is narrower than the caller's `turnErrored`: a clean exit that
// produced no assistant text is NOT a failure and should complete silently, so
// only non-zero exits / explicit result errors map to 'error'. `asksQuestion`
// is already gated on `!turnErrored` by the caller, so order only matters
// between the error branches and 'waiting'.
export function decideNextState({ wasStopped, rateLimit, turnFailed, asksQuestion }) {
  if (wasStopped) return 'cancelled';
  if (rateLimit) return 'rate_limited';
  if (turnFailed) return 'error';
  if (asksQuestion) return 'waiting';
  return 'completed';
}
