import { renderStatsPanel } from './index.js';

const STATS_REFRESH_MIN_INTERVAL_MS = 2000;

export function initStatsRefresh({ getSessionId, isStatsMode, panel }) {
  let refreshing = false;
  let pendingTimer = null;
  let lastRefreshAt = 0;

  async function refresh() {
    if (!isStatsMode()) return;
    const sessionId = getSessionId();
    if (!sessionId) return;
    if (refreshing) return;
    refreshing = true;
    lastRefreshAt = Date.now();
    try {
      const res = await fetch(`/api/stats?sessionId=${encodeURIComponent(sessionId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (isStatsMode()) renderStatsPanel(panel, data);
    } catch (_err) {
      // Silent on background refresh — keep the previously-rendered panel visible.
    } finally {
      refreshing = false;
    }
  }

  function schedule() {
    if (!isStatsMode()) return;
    if (pendingTimer) return;
    const since = Date.now() - lastRefreshAt;
    const delay = Math.max(0, STATS_REFRESH_MIN_INTERVAL_MS - since);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      refresh();
    }, delay);
  }

  function markRefreshed() {
    lastRefreshAt = Date.now();
  }

  function clearPending() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  return { refresh, schedule, markRefreshed, clearPending };
}
