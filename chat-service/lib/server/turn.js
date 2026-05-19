import { createInterface } from 'node:readline';
import { cp, copyFile, mkdir, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LOG_DIR, CLAUDE_HOME, CWD } from './config.js';
import { broadcast, sendStats } from './ws-bus.js';
import { runtimes, transitionState } from './runtime.js';
import { snapshotTickets, sendProgress } from './ticket-progress.js';
import { spawnClaude, extractText, extractToolUses, friendlyError } from './claude-spawn.js';
import { endsWithQuestion } from './session-store.js';
import {
  emptyBreakdown, addBreakdown, breakdownFromModelUsage, costFromBreakdown,
} from '../stats/io.js';

export async function processMessage(runtime, prompt) {
  if (!runtime) return;

  // Snapshot existing tickets so this turn's counter only reflects work
  // initiated by *this* prompt — prior-turn tickets stay baselined out.
  // Reset the client-side counter immediately, before the working bubble
  // mounts, so it doesn't briefly flash the previous turn's value.
  runtime.turnTicketBaseline = await snapshotTickets(`${LOG_DIR}/${runtime.session.id}`);
  broadcast(runtime, { type: 'progress', total: 0, done: 0 });

  // Claude (re)starts → session is active again.
  transitionState(runtime, 'in_progress');
  broadcast(runtime, { type: 'status', working: true });
  const toolMap = new Map();
  const pendingTicketWrites = new Set();
  let receivedText = false;
  let rateLimit = null;
  let resultError = false;
  let lastAssistantText = '';
  let exitCode = null;
  try {
    const proc = spawnClaude(prompt, runtime.claudeSessionId, `${LOG_DIR}/${runtime.session.id}`, {
      rollbackInProgress: !!runtime.session?.meta?.rollbackInProgress,
    });
    runtime.currentProc = proc; // expose for the stop handler
    let stderrBuf = '';
    // Prevent unhandled 'error' from crashing the process (e.g. claude binary missing).
    const spawnError = new Promise((resolve) => proc.once('error', resolve));
    proc.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      console.error('[claude]', d.toString().trim());
    });

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.session_id) {
          runtime.claudeSessionId = event.session_id;
          runtime.session?.setClaudeSessionId(event.session_id).catch(() => {});
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

        for (const tool of extractToolUses(event)) {
          toolMap.set(tool.id, tool);
        }

        if (event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'blocked') {
          rateLimit = event.rate_limit_info;
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
            sendStats(runtime);
          }
        }

        if (event.type === 'result') {
          if (event.is_error) resultError = true;
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
          // Reset active agents when turn ends (safety — sub-agents should all be done)
          runtime.stats.activeAgents = 0;
          runtime.stats.activeAgentIds.clear();
          sendStats(runtime);
          // The merger updates ticket status to "merged" near the end of a turn —
          // refresh the progress counter after `result`. Fire-and-forget; an
          // out-of-order arrival is harmless (latest read wins on the client).
          sendProgress(runtime).catch(() => {});
        }

        // Planner Write/Edit on TASK-*.json: stage the tool_use_id when we
        // see the assistant emit the call, then fire sendProgress once the
        // matching tool_result lands (the file isn't on disk before that).
        if (event.type === 'assistant') {
          for (const tool of extractToolUses(event)) {
            const fp = tool.input?.file_path;
            if ((tool.name === 'Write' || tool.name === 'Edit') && fp && /\/TASK-[^/]+\.json$/.test(fp)) {
              pendingTicketWrites.add(tool.id);
            }
          }
        }
        if (event.type === 'user' && pendingTicketWrites.size > 0) {
          const blocks = event.message?.content || [];
          let resolved = false;
          for (const b of blocks) {
            if (b?.type === 'tool_result' && pendingTicketWrites.delete(b.tool_use_id)) {
              resolved = true;
            }
          }
          if (resolved) sendProgress(runtime).catch(() => {});
        }
      } catch {}
    }
    exitCode = await Promise.race([
      new Promise((resolve) => proc.on('close', resolve)),
      spawnError.then((err) => {
        stderrBuf += `\n${err?.message || err}`;
        return -1;
      }),
    ]);
    if (runtime.stopping) {
      const stopText = '⏹ Session stopped.';
      broadcast(runtime, { type: 'message', role: 'assistant', content: stopText, ts: new Date().toISOString() });
      await runtime.session?.recordMessage('assistant', stopText).catch(() => {});
    } else if (exitCode !== 0 || !receivedText || resultError || rateLimit) {
      const errText = friendlyError({ exitCode, stderr: stderrBuf, rateLimit, resultError });
      broadcast(runtime, { type: 'message', role: 'assistant', content: errText, ts: new Date().toISOString() });
      // Await: the finally block below writes meta.json right after; a
      // fire-and-forget here would race with that write and corrupt the file.
      await runtime.session?.recordMessage('assistant', errText).catch(() => {});
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      const errText = "Something went wrong. Want to try again?";
      broadcast(runtime, { type: 'message', role: 'assistant', content: errText, ts: new Date().toISOString() });
      await runtime.session?.recordMessage('assistant', errText).catch(() => {});
    }
  } finally {
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
    if (!wasStopped && runtime.queue.length > 0) {
      const next = runtime.queue.shift();
      processMessage(runtime, next);
    } else {
      if (wasStopped) runtime.queue = [];
      runtime.busy = false;
      // Pick the next state:
      //   - user pressed STOP → 'cancelled'
      //   - turn errored (non-zero exit, rate limit, result error, no text) → 'completed'
      //   - last assistant message ends with '?' → 'waiting' (Claude asked a
      //     question and expects a reply before continuing)
      //   - otherwise → 'completed'
      const turnErrored = exitCode !== 0 || !receivedText || resultError || rateLimit;
      const asksQuestion = !wasStopped && !turnErrored && endsWithQuestion(lastAssistantText);
      const nextState = wasStopped ? 'cancelled' : asksQuestion ? 'waiting' : 'completed';
      await transitionState(runtime, nextState);
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
  const slug = CWD.replace(/\//g, '-');
  const projectDir = join(CLAUDE_HOME, '.claude', 'projects', slug);
  const srcDir = join(projectDir, claudeSessionId);
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
