import { renderSummarySection } from './summary.js';
import { renderChronologySection } from './chronology.js';
import { renderTopOpsSection } from './top-ops.js';
import { renderSkillsHooksRulesSection } from './skills-hooks.js';
import { renderErrorsRetriesSection } from './errors.js';

export function renderStatsPanel(panel, data) {
  panel.replaceChildren(
    renderSummarySection(data),
    renderChronologySection(data),
    renderTopOpsSection(data),
    renderSkillsHooksRulesSection(data),
    renderErrorsRetriesSection(data),
  );
}
