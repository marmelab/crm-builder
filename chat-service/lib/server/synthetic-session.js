// Synthetic session helpers for UI testing without burning tokens.
//
// /fake [scenario=<name>] [speed=<n>]  — slash command, injects into current session.
// GET /api/debug/synthetic-session?scenario=...&speed=...  — creates a standalone session.
//
// Available scenarios:
//   satisfaction-ask  (default) — SIMPLE dev flow ending with the satisfaction widget

import { broadcast } from './ws-bus.js';

// ─── Scenarios ────────────────────────────────────────────────────────────────

// Each scenario has a `run(runtime, speed)` function.
// Ticket-based COMPLEX scenarios (simple3, complex4) live in the progressBar branch
// and will be merged in here alongside these.
const SCENARIOS = {
  'satisfaction-ask': {
    label: 'SIMPLE dev → satisfaction widget',
    run: runSatisfactionAsk,
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

// ─── satisfaction-ask scenario ────────────────────────────────────────────────

async function runSatisfactionAsk(runtime, speed) {
  const ms = (s) => Math.round(s * 1000 / speed);
  const at = (s, payload) => setTimeout(() => broadcast(runtime, payload), ms(s));

  at(0,   { type: 'status', working: true });
  at(0.5, { type: 'message', role: 'assistant', content: '⚙️ Application de vos modifications…' });
  at(3,   { type: 'message', role: 'assistant', content: '🔀 Fusion dans la branche principale…' });
  at(5,   { type: 'message', role: 'assistant', content: 'C\'est fait — jetez un œil dans l\'aperçu.' });
  at(5.2, {
    type: 'satisfaction_ask',
    header: 'Aperçu prêt',
    body: "Vos modifications sont visibles dans l'aperçu, mais pas encore enregistrées définitivement. Êtes-vous satisfait ?",
    yes: 'Oui, enregistrer les modifications',
    no: 'Non, je veux modifier quelque chose',
  });
  at(5.4, { type: 'status', working: false });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runFakeTurn(runtime, { scenario = 'satisfaction-ask', speed = 5 } = {}) {
  const sc = SCENARIOS[scenario];
  if (!sc) {
    throw new Error(`Unknown scenario "${scenario}". Available: ${SCENARIO_NAMES.join(', ')}`);
  }
  await sc.run(runtime, speed);
  return { scenario, speed };
}

// createSyntheticSession (standalone session with nav URL) is not needed here —
// it's provided by the progressBar branch for COMPLEX scenarios.
