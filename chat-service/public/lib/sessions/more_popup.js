const historyMoreBtn = document.getElementById('history-more-btn');
const historyMorePopup = document.getElementById('history-more-popup');

// "More actions" overflow menu for the sidebar footer. Same anchored-popover
// idiom as recent_popup.js (close on outside-click / Escape / resize), but the
// content is static markup that already lives in the popover — so there's no
// fetch, opening just positions and unhides.
export function initMorePopup() {
  if (!historyMoreBtn || !historyMorePopup) return { closeMorePopup() {} };

  function closeMorePopup() {
    if (historyMorePopup.hidden) return;
    historyMorePopup.hidden = true;
    historyMoreBtn.setAttribute('aria-expanded', 'false');
  }

  function openMorePopup() {
    // The trigger sits at the bottom of the sidebar, so anchor the popup's
    // bottom edge to the trigger's bottom and let it grow upward.
    const rect = historyMoreBtn.getBoundingClientRect();
    historyMorePopup.style.bottom = `${window.innerHeight - rect.bottom}px`;
    historyMorePopup.hidden = false;
    historyMoreBtn.setAttribute('aria-expanded', 'true');
  }

  historyMoreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (historyMorePopup.hidden) openMorePopup();
    else closeMorePopup();
  });

  document.addEventListener('click', (e) => {
    if (historyMorePopup.hidden) return;
    if (historyMorePopup.contains(e.target)) return;
    if (historyMoreBtn.contains(e.target)) return;
    closeMorePopup();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !historyMorePopup.hidden) closeMorePopup();
  });

  // `bottom` is computed from the trigger's rect at open time, so a viewport
  // resize would leave the popup misplaced — close it instead of re-anchoring.
  window.addEventListener('resize', () => {
    if (!historyMorePopup.hidden) closeMorePopup();
  });

  return { closeMorePopup };
}
