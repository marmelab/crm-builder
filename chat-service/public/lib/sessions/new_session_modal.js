const modal = document.getElementById('chat-modal');
const modalBackdrop = document.getElementById('chat-modal-backdrop');
const modalCancel = document.getElementById('chat-modal-cancel');
const modalConfirm = document.getElementById('chat-modal-confirm');

export function openConfirmModal() {
  return new Promise((resolve) => {
    const close = (result) => {
      modal.hidden = true;
      modalConfirm.removeEventListener('click', onConfirm);
      modalCancel.removeEventListener('click', onCancel);
      modalBackdrop.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onConfirm = () => close(true);
    const onCancel  = () => close(false);
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
      // Enter confirms only when focus is outside the modal buttons; if a
      // button is focused, the browser's native click activation handles it
      // (so Enter while tabbed to Cancel cancels, not confirms).
      if (e.key === 'Enter' && document.activeElement !== modalCancel && document.activeElement !== modalConfirm) {
        onConfirm();
      }
    };
    modalConfirm.addEventListener('click', onConfirm);
    modalCancel.addEventListener('click', onCancel);
    modalBackdrop.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    modal.hidden = false;
    modalConfirm.focus();
  });
}

