import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrichSubagentChildren } from '../lib/stats/subagents.js';

// Write one subagent transcript (agent-<base>.jsonl + .meta.json) and stamp its
// mtime so the matcher's ordering is deterministic.
async function writeAgent(dir, base, agentType, events, mtimeSec) {
  const jsonl = join(dir, `agent-${base}.jsonl`);
  await writeFile(jsonl, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(join(dir, `agent-${base}.meta.json`), JSON.stringify({ agentType }));
  await utimes(jsonl, mtimeSec, mtimeSec);
}

function assistantWithTool(msgId, toolName, ts) {
  return {
    type: 'assistant', uuid: `a-${msgId}`, timestamp: ts,
    message: {
      id: msgId, model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: 'tool_use', id: `tu-${msgId}`, name: toolName, input: {} }],
    },
  };
}

function makePhase(agentName, startTs) {
  return {
    kind: 'agent', taskType: 'in_process_teammate', agentName, agentType: agentName,
    phaseId: agentName, startTs, endTs: null, children: [],
  };
}

const toolsOf = (phase) => phase.children.filter((c) => c.kind === 'tool_use').map((c) => c.tool);

test('enrichSubagentChildren: a context-compacted agent keeps its real transcript and merges the continuation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subagents-'));
  try {
    // Real activation (first event type:"user" = dispatch prompt), LATER mtime,
    // larger — holds the bulk of the work (a Bash tool_use).
    await writeAgent(dir, 'real', 'developer-TASK-005', [
      { type: 'user', uuid: 'u-real', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'ROLE: developer\nTASK_ID: TASK-005 ' + 'x'.repeat(500) } },
      assistantWithTool('m-real', 'Bash', '2026-01-01T00:00:01Z'),
    ], 2000);
    // Compaction continuation (first event type:"system"), EARLIER mtime, tiny —
    // the old matcher picked this by min-mtime and dropped the real transcript,
    // leaving the agent empty in the stats UI.
    await writeAgent(dir, 'stub', 'developer-TASK-005', [
      { type: 'system', uuid: 'u-stub', subtype: 'compact_boundary', timestamp: '2026-01-01T00:01:00Z', message: { content: 'compaction summary' } },
      assistantWithTool('m-stub', 'Read', '2026-01-01T00:01:01Z'),
    ], 1000);

    const phase = makePhase('developer-TASK-005', '2026-01-01T00:00:00Z');
    await enrichSubagentChildren([phase], dir, new Map(), []);

    const tools = toolsOf(phase);
    assert.ok(tools.includes('Bash'), 'real transcript tool_use must be attributed (regression: was dropped)');
    assert.ok(tools.includes('Read'), 'compaction-continuation tool_use must be merged into the same phase');
    assert.ok(phase.opsCount >= 2, `expected both tool_uses counted, got opsCount=${phase.opsCount}`);
    assert.ok(phase.tokensTotal > 0, 'tokens must be accumulated, not zero');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('enrichSubagentChildren: a normal (non-compacted) agent is unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subagents-'));
  try {
    await writeAgent(dir, 'only', 'developer-TASK-001', [
      { type: 'user', uuid: 'u-only', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'ROLE: developer\nTASK_ID: TASK-001' } },
      assistantWithTool('m-only', 'Edit', '2026-01-01T00:00:01Z'),
    ], 1000);

    const phase = makePhase('developer-TASK-001', '2026-01-01T00:00:00Z');
    await enrichSubagentChildren([phase], dir, new Map(), []);

    assert.deepEqual(toolsOf(phase), ['Edit']);
    assert.equal(phase.opsCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
