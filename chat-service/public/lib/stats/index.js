import { renderSummarySection } from './summary.js';
import { renderWavesSection } from './waves.js';
import { renderChronologySection } from './chronology.js';
import { renderSkillsHooksRulesSection } from './skills-hooks.js';
import { renderErrorsRetriesSection } from './errors.js';

export function renderStatsPanel(panel, data) {
  // Waves section may be null when the session has no tickets (SIMPLE flow,
  // failed plan, ...). replaceChildren rejects null entries — filter them out.
  const sections = [
    renderSummarySection(data),
    renderWavesSection(data),
    renderChronologySection(data),
    renderSkillsHooksRulesSection(data),
    renderErrorsRetriesSection(data),
  ].filter(Boolean);
  panel.replaceChildren(...sections);
}

export { initStatsRefresh } from './refresh.js';
