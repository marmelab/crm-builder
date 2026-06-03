import { createInterface } from 'node:readline';
import { cp, copyFile, mkdir, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LOG_DIR, claudeProjectDir, claudeSessionDir } from './config.js';
import { broadcast, sendStats } from './ws-bus.js';
import { runtimes, transitionState, noteRateLimit } from './runtime.js';
import { spawnClaude, extractText, extractToolUses, friendlyError } from './claude-spawn.js';
import { endsWithQuestion } from './session-store.js';
import { decideNextState, turnFailedFrom } from './turn-state.js';
import { startSubagentTailer, stopSubagentTailer } from './subagent-tail.js';
import {
  emptyBreakdown, addBreakdown, breakdownFromModelUsage, costFromBreakdown,
} from '../stats/io.js';
import { updateProgressBar, predictedFlowExpected, flowExpectedForTickets } from './progress-bar.ts';
import {
  sessionHasMergedTickets, scheduleDocumentatorRun, clearDocumentatorTimer,
} from './documentator-spawn.js';
import { countSessionTickets } from './session-store.js';

const AGENT_DISPATCH_TOOLS = new Set(['Agent', 'Task']);

function emitDispatchPromptEvent(runtime, tool) {
  const target = tool.input.name || tool.input.subagent_type;
  broadcast(runtime, {
    type: 'debug',
    tool: 'agent_output',
    input: { agent: `→ ${target}`, text: tool.input.prompt },
    agent: 'orchestrator',
  });
}

export async function processMessage(runtime, prompt, opts = {}) {
  if (!runtime) return;

  // The user is back — cancel any pending documentator run scheduled at the
  // tail of the previous turn. Keyed on sessionId (not runtime) so it survives
  // runtime release/recreate between turns. We'll re-arm it when this turn
  // completes.
  if (runtime.session?.id) clearDocumentatorTimer(runtime.session.id);

  // Reset per-turn agent step counters so the progress bar reflects only
  // work initiated by *this* prompt. Send the initial 0/1 (orchestrator
  // alone, not yet done) immediately so the bar mounts with the bubble.
  runtime.stats = {
    ...runtime.stats,
    agentsCompleted: 0,
    flowExpected: 0,
    dispatchedSubagentTypes: [],
    activeAgentIds: new Set(),
    activeAgents: 0,
  };
  updateProgressBar(runtime);

  // Claude (re)starts → session is active again.
  transitionState(runtime, 'in_progress');
  broadcast(runtime, { type: 'status', working: true });
  // Clear any rate-limit flagged by a previous turn (or by the subagent tailer
  // before this spawn started) so it can't leak into this turn's outcome.
  runtime.pendingRateLimit = null;
  const toolMap = new Map();
  let receivedText = false;
  let rateLimit = null;
  let resultError = false;
  let lastAssistantText = '';
  let exitCode = null;
  // Raw stream facts read again in the finally block (a separate scope), so they
  // live at function scope alongside the other outcome flags. `sawResult` = the
  // CLI emitted its terminal `result` event (Claude's loop ran to completion);
  // `stderrBuf` accumulates the spawn's stderr.
  let sawResult = false;
  let stderrBuf = '';
  try {
    // A `--resume` whose target conversation no longer exists (e.g. the container
    // was recreated, wiping ~/.claude/projects) makes claude exit instantly with
    // `error_during_execution` / "No conversation found". Drop the stale id and
    // respawn fresh once, rather than surfacing a hard error to the user.
    for (let attempt = 0; attempt < 2; attempt++) {
      receivedText = false;
      rateLimit = null;
      resultError = false;
      sawResult = false;
      toolMap.clear();
      stderrBuf = '';
      // Per-attempt, not just pre-loop: a limit the subagent tailer flagged
      // during attempt 0 must not leak into attempt 1's outcome (it would fold
      // into `rateLimit` below and wrongly settle a clean retry as rate_limited).
      runtime.pendingRateLimit = null;
      let staleResume = false;
      // freshSession (set by a recovery resume) starts a brand-new claude session
      // instead of --resume-ing the killed transcript: that transcript ends
      // believing a team is still running, and reinjecting it makes the
      // orchestrator no-op. Null the id NOW (only on attempt 0 — a staleResume
      // retry already nulled it before `continue`) so a fresh spawn that dies
      // before its own session_id event doesn't make the finally-block snapshot
      // copy the dead session's transcript/subagents into this session's dir.
      if (attempt === 0 && opts.freshSession) runtime.claudeSessionId = null;
      const proc = spawnClaude(prompt, runtime.claudeSessionId, `${LOG_DIR}/${runtime.session.id}`);
      runtime.currentProc = proc; // expose for the stop handler
      // Prevent unhandled 'error' from crashing the process (e.g. claude binary missing).
      const spawnError = new Promise((resolve) => proc.once('error', resolve));
      proc.stderr.on('data', (d) => {
        stderrBuf += d.toString();
        console.error('[claude]', d.toString().trim());
      });

      const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
      // Inactivity watchdog. The COMPLEX flow's autonomous team (devs → reviewers
      // → merger) keeps working AFTER the orchestrator emits its `result`/end_turn,
      // and that progress lands on the per-subagent transcripts (the tailer bumps
      // `lastStreamActivityMs`), NOT the orchestrator's now-idle main stream. So we
      // wait for the process to close on its own (team done) and only force-kill
      // after a long stretch of TOTAL silence — main stream AND subagents — i.e. a
      // genuine hang (e.g. a zombie holding stdout open). A flat 30 s timer after
      // `result` (added in #54) killed live COMPLEX teams mid-merge; this replaces it.
      const IDLE_KILL_MS = 180_000;
      runtime.lastStreamActivityMs = Date.now();
      const idleTimer = setInterval(() => {
        if (Date.now() - runtime.lastStreamActivityMs < IDLE_KILL_MS) return;
        console.error(`[claude] no activity for ${IDLE_KILL_MS}ms — killing spawn`);
        try { proc.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5_000);
      }, 5_000);
      for await (const line of rl) {
      runtime.lastStreamActivityMs = Date.now();
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.session_id) {
          runtime.claudeSessionId = event.session_id;
          runtime.session?.setClaudeSessionId(event.session_id).catch(() => {});
          // Main stream only carries subagent tool_uses — their text and
          // SendMessage content live in per-subagent transcripts on disk.
          startSubagentTailer(runtime).catch((e) => console.error('[subagent-tail]', e));
        }

        // Always send raw event to debug
        broadcast(runtime, { type: 'debug_raw', event });

        const text = extractText(event);
        if (text) {
          receivedText = true;
          // Suppress consecutive duplicates. The COMPLEX flow makes the
          // orchestrator yield with the same "Working on it..." line on every
          // STATE C wake-up (which can be 20+ in a 4-ticket run) — those are
          // pure noise and pollute both the UI and the persisted log. We
          // still set lastAssistantText so other code that reads it (final
          // fallback message logic below) sees the last real text.
          const isDuplicate = text.trim() === lastAssistantText.trim();
          lastAssistantText = text;
          if (!isDuplicate) {
            broadcast(runtime, { type: 'message', role: 'assistant', content: text, ts: new Date().toISOString() });
            runtime.session?.recordMessage('assistant', text).catch(() => {});
          }
        }

        let dispatchedThisEvent = false;
        for (const tool of extractToolUses(event)) {
          // stream-json can emit the same tool_use across two assistant events
          // (initial + post-stream). Use toolMap as the dedup gate so we count
          // and broadcast each dispatch exactly once.
          const alreadySeen = toolMap.has(tool.id);
          toolMap.set(tool.id, tool);
          if (alreadySeen) continue;
          // Count orchestrator Agent/Task dispatches eagerly (the tool_use
          // event lands before the runtime fires task_started), so the bar
          // shows "1/3" right away for SIMPLE instead of growing 1/2 → 2/3.
          if (AGENT_DISPATCH_TOOLS.has(tool.name) && tool.input?.subagent_type) {
            if (runtime.stats.dispatchedSubagentTypes.length === 0) {
              runtime.stats.flowExpected = predictedFlowExpected(tool.input.subagent_type);
            }
            runtime.stats.dispatchedSubagentTypes.push(tool.input.subagent_type);
            dispatchedThisEvent = true;
            // Mirror orchestrator → agent dispatches into the debug pane so
            // the prompt sits next to the agent's tailed reply. Subagent-
            // emitted dispatches (rare) are skipped to avoid double-attribution.
            if (event.parent_tool_use_id == null && tool.input?.prompt) {
              emitDispatchPromptEvent(runtime, tool);
            }
          }
        }
        if (dispatchedThisEvent) {
          updateProgressBar(runtime);
        }

        if (event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'blocked') {
          // The CLI doesn't exit on a blocked limit — it hangs indefinitely.
          // noteRateLimit kills the spawn so the readline loop drains and the
          // turn ends. (Subagent-triggered limits take the same path from the
          // subagent tailer, surfacing via runtime.pendingRateLimit below.)
          rateLimit = event.rate_limit_info;
          noteRateLimit(runtime, rateLimit);
        }

        // Track active sub-agents. Claude Code emits task_started events for
        // many things (Bash calls, MCP tool calls, subagent dispatches, ...).
        // We count two task_types: 'local_agent' (Agent without team_name —
        // planner, simple-developer) and 'in_process_teammate' (Agent dispatched
        // into a team — every COMPLEX member: developer-TASK-XXX, reviewers,
        // merger). Without 'in_process_teammate', COMPLEX runs only show
        // orchestrator+planner in the UI. Filtering both still excludes the
        // Bash/MCP task_started noise that previously drifted the counter to
        // double-digit values.
        // Match completion via task_id — task_notification reuses the started
        // event's task_id.
        if (event.type === 'system') {
          const isAgentTaskType =
            event.task_type === 'local_agent' || event.task_type === 'in_process_teammate';
          if (event.subtype === 'task_started' && isAgentTaskType && event.task_id) {
            runtime.stats.activeAgentIds.add(event.task_id);
            runtime.stats.activeAgents = runtime.stats.activeAgentIds.size;
            sendStats(runtime);
          } else if (event.subtype === 'task_notification' && event.status === 'completed' && event.task_id && runtime.stats.activeAgentIds.has(event.task_id)) {
            runtime.stats.activeAgentIds.delete(event.task_id);
            runtime.stats.activeAgents = runtime.stats.activeAgentIds.size;
            runtime.stats.agentsCompleted++;
            // When the planner completes (first agent done in a COMPLEX flow),
            // count the TASK-*.json files it produced and lock flowExpected to
            // the exact total so the bar never backtracks between waves:
            //   2 (orchestrator + planner) + N_tickets × 3 (dev+qr+tv) + 1 (merger)
            if (runtime.stats.agentsCompleted === 1
                && runtime.stats.dispatchedSubagentTypes[0] === 'planner') {
              const sessionDir = `${LOG_DIR}/${runtime.session.id}`;
              const ticketCount = await countSessionTickets(sessionDir);
              if (ticketCount > 0) {
                runtime.stats.flowExpected = flowExpectedForTickets(ticketCount);
              }
            }
            sendStats(runtime);
            updateProgressBar(runtime);
          }
        }

        if (event.type === 'result') {
          sawResult = true;
          if (event.is_error) resultError = true;
          if (event.subtype === 'error_during_execution'
            && Array.isArray(event.errors)
            && event.errors.some((e) => /no conversation found/i.test(String(e)))) {
            staleResume = true;
          }
          // tokens: derived from modelUsage which is cumulative within the spawn
          // and includes sub-agent token consumption. Replace, don't add — the
          // value is the running spawn total. (Falling back to result.usage
          // summing under-counts by 10× because it misses sub-agent messages.)
          if (event.modelUsage && Object.keys(event.modelUsage).length > 0) {
            runtime.stats.tokensBreakdownCurrentSpawn = breakdownFromModelUsage(event.modelUsage);
            // Per-model cumulative snapshot for the current spawn. Cleared on
            // commit. Cumulative-within-spawn → replace, not add.
            runtime.stats.tokensByModelCurrentSpawn = new Map();
            for (const [model, mu] of Object.entries(event.modelUsage)) {
              runtime.stats.tokensByModelCurrentSpawn.set(model, {
                breakdown: {
                  input:       mu?.inputTokens               || 0,
                  cacheCreate: mu?.cacheCreationInputTokens  || 0,
                  output:      mu?.outputTokens              || 0,
                  cacheRead:   mu?.cacheReadInputTokens      || 0,
                },
                costUsd: typeof mu?.costUSD === 'number' ? mu.costUSD : null,
              });
            }
          }
          // cost: total_cost_usd is cumulative within the current spawn — replace,
          // don't add (summing cumulative values inflates massively).
          runtime.stats.costUsdCurrentSpawn = event.total_cost_usd || 0;
          // Do NOT clear activeAgentIds here. In COMPLEX, `result` fires for each
          // subagent as it finishes (not just once at the end of the turn), so
          // clearing on every `result` wipes in-process-teammate agents before
          // their task_notification/completed arrives — agentsCompleted then never
          // increments past orchestrator+planner and the progress bar stalls at ~15%.
          // Let completions drain activeAgentIds naturally via task_notification.
          sendStats(runtime);
          // Do NOT break here. For SIMPLE the process closes right after `result`
          // so the loop ends on its own. For COMPLEX the autonomous team keeps
          // working past the lead's `result`/end_turn — breaking would abandon it
          // (and the old +30 s kill then murdered it mid-merge). We let the loop
          // run until the process actually closes (team done), guarded by the
          // inactivity watchdog above for the genuine-hang case.
        }
      } catch {}
    }
    clearInterval(idleTimer);
    // The loop only exits once the process closes on its own (work done) or the
    // inactivity watchdog above killed a genuinely hung spawn — either way `close`
    // resolves promptly, so no separate timeout is needed here.
    exitCode = await Promise.race([
      new Promise((resolve) => proc.on('close', resolve)),
      spawnError.then((err) => {
        stderrBuf += `\n${err?.message || err}`;
        return -1;
      }),
    ]);
      // Stale --resume target → forget it and respawn fresh once. The new spawn
      // re-populates runtime.claudeSessionId from its own `session_id` event.
      if (staleResume && attempt === 0 && !runtime.stopping && runtime.claudeSessionId) {
        console.error('[claude] resume target missing — respawning without --resume');
        // Attempt 0 started a tailer bound to the now-dead session's dir. Stop it
        // here (not just in the post-loop finally) so attempt 1's startSubagentTailer
        // can claim the slot and bind to the fresh session — otherwise its start
        // no-ops and the dead-dir interval keeps polling, losing all subagent
        // narration and never catching a subagent rate-limit on the retry.
        await stopSubagentTailer(runtime);
        runtime.claudeSessionId = null;
        continue;
      }
      break;
    }
    // A limit hit by a subagent lands in its transcript, not the main stream —
    // the tailer flags it on runtime.pendingRateLimit and kills the spawn. Fold
    // it in here so the turn settles on `rate_limited` like a main-stream limit.
    if (!rateLimit && runtime.pendingRateLimit) rateLimit = runtime.pendingRateLimit;
    if (runtime.stopping) {
      const stopText = '⏹ Session stopped.';
      broadcast(runtime, { type: 'message', role: 'assistant', content: stopText, ts: new Date().toISOString() });
      await runtime.session?.recordMessage('assistant', stopText).catch(() => {});
    } else if (turnFailedFrom({ resultError, stderr: stderrBuf, sawResult, exitCode }) || !receivedText || rateLimit) {
      const errText = friendlyError({ exitCode, stderr: stderrBuf, rateLimit, resultError });
      broadcast(runtime, { type: 'message', role: 'assistant', content: errText, ts: new Date().toISOString() });
      // Await: the finally block below writes meta.json right after; a
      // fire-and-forget here would race with that write and corrupt the file.
      await runtime.session?.recordMessage('assistant', errText).catch(() => {});
      if (rateLimit) {
        // resetsAt may be absent on a blocked event (or a subagent-surfaced
        // limit). Broadcast/persist null rather than skipping: the state still
        // settles on 'rate_limited' below, so without this the session would
        // strand with a badge but no Resume affordance. A null resetsAt just
        // renders the bubble with an immediately-enabled Resume button.
        const resetsAt = typeof rateLimit.resetsAt === 'number' ? rateLimit.resetsAt : null;
        broadcast(runtime, { type: 'rate_limited', resetsAt });
        await runtime.session?.setRateLimitResetsAt(resetsAt).catch(() => {});
      }
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      // An internal exception leaves exitCode null and sawResult false, so
      // turnFailedFrom classifies it as a (resumable) failure on its own — no
      // flag to set here. A user STOP throws AbortError, handled by wasStopped.
      const errText = "Something went wrong. Want to try again?";
      broadcast(runtime, { type: 'message', role: 'assistant', content: errText, ts: new Date().toISOString() });
      await runtime.session?.recordMessage('assistant', errText).catch(() => {});
    }
  } finally {
    // Awaited so the trailing scan (which catches subagent writes between the
    // last poll tick and the CLI exit) finishes before the turn settles.
    await stopSubagentTailer(runtime).catch(() => {});
    // Commit this spawn's cumulative cost and tokens into the runtime totals,
    // reset for next spawn (each new spawn starts fresh at 0).
    runtime.stats.costUsd += runtime.stats.costUsdCurrentSpawn;
    runtime.stats.costUsdCurrentSpawn = 0;
    runtime.stats.tokensBreakdown = addBreakdown(
      runtime.stats.tokensBreakdown,
      runtime.stats.tokensBreakdownCurrentSpawn,
    );
    // Refresh the legacy headline (input + cache_creation + output, excludes
    // cache_read) from the breakdown so consumers reading `tokensUsed` directly
    // still get the historical semantic.
    const bk = runtime.stats.tokensBreakdown;
    runtime.stats.tokensUsed = bk.input + bk.cacheCreate + bk.output;
    runtime.stats.tokensBreakdownCurrentSpawn = emptyBreakdown();
    // Fold the spawn's per-model snapshot into the committed totals. Prefer
    // the SDK's per-model `costUSD` (cumulative-within-spawn → just add) and
    // fall back to deriving from the local rate table when the SDK didn't
    // populate the field.
    const byModelIdx = new Map(runtime.stats.tokensByModel.map((r) => [r.model, r]));
    for (const [model, mb] of runtime.stats.tokensByModelCurrentSpawn) {
      const prev = byModelIdx.get(model);
      const mergedBreakdown = prev
        ? addBreakdown(prev.breakdown, mb.breakdown)
        : { ...mb.breakdown };
      const addCost = mb.costUsd != null ? mb.costUsd : costFromBreakdown(model, mb.breakdown);
      const mergedCost = (prev?.costUsd || 0) + addCost;
      if (prev) { prev.breakdown = mergedBreakdown; prev.costUsd = mergedCost; }
      else byModelIdx.set(model, { model, breakdown: mergedBreakdown, costUsd: mergedCost });
    }
    runtime.stats.tokensByModel = [...byModelIdx.values()].sort((a, b) => b.costUsd - a.costUsd);
    runtime.stats.tokensByModelCurrentSpawn = new Map();
    runtime.currentProc = null;
    sendStats(runtime);

    broadcast(runtime, { type: 'status', working: false });
    // If the user pressed stop, drop any queued messages (their intent was
    // "stop everything"), clear the flag, and don't auto-process the queue.
    const wasStopped = !!runtime.stopping;
    runtime.stopping = false;
    // Don't drain the queue when the limit just hit — every queued message
    // would re-spawn claude, hit the same window, and re-broadcast another
    // rate_limited event before ever reaching the 'rate_limited' state.
    // Drop the queue (symmetric with STOP) so the session settles on the
    // rate-limited bubble and the user decides what to do.
    if (!wasStopped && !rateLimit && runtime.queue.length > 0) {
      const next = runtime.queue.shift();
      // The head of the queue is now running, not waiting — tabs need this to
      // drop the ⏳ badge / × button on the bubble whose data-queue-id matches.
      broadcast(runtime, { type: 'queue_updated', queuedIds: runtime.queue.map((q) => q.id) });
      processMessage(runtime, next.content);
    } else {
      if (wasStopped || rateLimit) runtime.queue = [];
      runtime.busy = false;
      // Only a genuine Claude failure is a resumable 'error' (see turnFailedFrom):
      // an API error, or a process that died before Claude finished. A hook or
      // tool that merely exited non-zero while Claude ran to completion is NOT a
      // failure — the session settles on 'completed' so the next message
      // continues instead of stalling on a Resume button. A clean exit with no
      // assistant text also completes silently; a rate limit settles on its own.
      const turnFailed = turnFailedFrom({ resultError, stderr: stderrBuf, sawResult, exitCode });
      const turnErrored = turnFailed || !receivedText || !!rateLimit;
      const asksQuestion = !wasStopped && !turnErrored && endsWithQuestion(lastAssistantText);
      const nextState = decideNextState({ wasStopped, rateLimit: !!rateLimit, turnFailed, asksQuestion });
      await transitionState(runtime, nextState);
      // Schedule the documentator (Mode 2) once the turn lands on 'completed'
      // and at least one ticket has been merged in this session. Debounced so
      // a follow-up user message within DOCUMENTATOR_DEBOUNCE_MS cancels it
      // (processMessage clears the timer at the top of the next turn). Timer
      // state is keyed on sessionId in documentator-spawn.js so it survives
      // runtime release between turns.
      if (nextState === 'completed' && !turnErrored) {
        const sessionId = runtime.session?.id;
        const sessionDir = sessionId ? `${LOG_DIR}/${sessionId}` : null;
        if (sessionDir && await sessionHasMergedTickets(sessionDir)) {
          scheduleDocumentatorRun(sessionId, runtimes);
        }
      }
      // If no client is currently viewing this session, release the runtime
      // now that the turn is done. A later reconnect will re-open it.
      if (runtime.clients.size === 0) {
        runtime.session?.close();
        runtimes.delete(runtime.session.id);
      }
    }

    snapshotClaudeSession(runtime.claudeSessionId, runtime.session?.id).catch(() => {});
  }
}

async function snapshotClaudeSession(claudeSessionId, sessionId) {
  if (!claudeSessionId || !sessionId) return;
  const projectDir = claudeProjectDir();
  const srcDir = claudeSessionDir(claudeSessionId);
  const destDir = join(LOG_DIR, sessionId, 'claude');

  await mkdir(destDir, { recursive: true });
  await copyFile(join(projectDir, `${claudeSessionId}.jsonl`), join(destDir, 'transcript.jsonl'))
    .then(() => chmod(join(destDir, 'transcript.jsonl'), 0o644))
    .catch(() => {});
  for (const subdir of ['subagents', 'tool-results']) {
    const src = join(srcDir, subdir);
    const dst = join(destDir, subdir);
    await cp(src, dst, { recursive: true })
      .then(() => chmodDir(dst, 0o644, 0o755))
      .catch(() => {});
  }
}

async function chmodDir(dir, fileMode, dirMode) {
  await chmod(dir, dirMode).catch(() => {});
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await chmodDir(full, fileMode, dirMode);
    else await chmod(full, fileMode).catch(() => {});
  }
}
