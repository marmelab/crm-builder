const historyRecentBtn = document.getElementById('history-recent-btn');
const historyRecentPopup = document.getElementById('history-recent-popup');
const historyRecentList = document.getElementById('history-recent-list');
const historyRecentEmpty = document.getElementById('history-recent-empty');

export function initRecentPopup({ renderHistoryItem }) {
  function closeRecentPopup() {
    historyRecentPopup.hidden = true;
  }

  async function openRecentPopup() {
    // Anchor the popup vertically next to the trigger button.
    const rect = historyRecentBtn.getBoundingClientRect();
    historyRecentPopup.style.top = `${rect.top}px`;
    try {
      const res = await fetch('/api/sessions');
      const list = await res.json();
      historyRecentList.innerHTML = '';
      const top5 = list.slice(0, 5);
      if (top5.length === 0) {
        historyRecentEmpty.hidden = false;
      } else {
        historyRecentEmpty.hidden = true;
        top5.forEach((d) => {
          const item = renderHistoryItem(d);
          item.addEventListener('click', closeRecentPopup);
          historyRecentList.appendChild(item);
        });
      }
      historyRecentPopup.hidden = false;
    } catch (err) {
      console.error('Failed to load recent sessions:', err);
    }
  }

  historyRecentBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (historyRecentPopup.hidden) openRecentPopup();
    else closeRecentPopup();
  });

  document.addEventListener('click', (e) => {
    if (historyRecentPopup.hidden) return;
    if (historyRecentPopup.contains(e.target)) return;
    if (historyRecentBtn.contains(e.target)) return;
    closeRecentPopup();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !historyRecentPopup.hidden) closeRecentPopup();
  });

  // `top` is computed from the trigger button's bounding rect at open time, so a
  // viewport resize would leave the popup floating — close it instead of trying
  // to re-anchor live.
  window.addEventListener('resize', () => {
    if (!historyRecentPopup.hidden) closeRecentPopup();
  });

  return { closeRecentPopup };
}
