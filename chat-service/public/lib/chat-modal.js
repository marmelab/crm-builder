const TEMPLATE = `
  <style>
    :host {
      position: fixed; inset: 0; z-index: 1000;
      display: flex; align-items: center; justify-content: center;
    }
    :host([hidden]) { display: none; }
    .backdrop {
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, .55);
      backdrop-filter: blur(4px);
      animation: fade .15s ease-out;
    }
    .panel {
      position: relative;
      width: min(420px, calc(100vw - 32px));
      background: linear-gradient(160deg, #2c2c2e 0%, #1c1c1e 100%);
      border: 1px solid #3a3a3c;
      border-radius: 16px;
      padding: 28px 24px 20px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, .6);
      text-align: center;
      animation: pop .18s ease-out;
    }
    .icon {
      width: 48px; height: 48px; margin: 0 auto 14px;
      border-radius: 50%;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; color: #fff;
      box-shadow: 0 6px 20px rgba(59, 130, 246, .35);
    }
    .title { font-size: 17px; font-weight: 600; color: #f2f2f7; margin: 0 0 8px; }
    .body  { font-size: 13px; line-height: 1.5; color: #8e8e93; margin: 0 0 22px; }
    .actions { display: flex; gap: 10px; justify-content: center; }
    .btn {
      flex: 1; max-width: 160px;
      padding: 10px 18px; border-radius: 10px;
      font-size: 14px; font-weight: 600;
      border: none; cursor: pointer;
      transition: transform .1s, filter .15s, background .15s;
    }
    .btn:active { transform: scale(.97); }
    .btn.cancel  { background: #3a3a3c; color: #f2f2f7; }
    .btn.cancel:hover { background: #48484a; }
    .btn.confirm {
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: #fff;
      box-shadow: 0 4px 14px rgba(59, 130, 246, .35);
    }
    .btn.confirm:hover { filter: brightness(1.1); }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes pop  {
      from { opacity: 0; transform: translateY(8px) scale(.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
  </style>
  <div class="backdrop" part="backdrop"></div>
  <div class="panel" part="panel">
    <div class="icon">✦</div>
    <h2 class="title"><slot name="title">Set up my CRM from scratch?</slot></h2>
    <p class="body"><slot name="body">We'll start an interview to understand your business and build a complete plan.</slot></p>
    <div class="actions">
      <button type="button" class="btn cancel"><slot name="cancel">Cancel</slot></button>
      <button type="button" class="btn confirm"><slot name="confirm">Let's go</slot></button>
    </div>
  </div>
`;

export class ChatModal extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = TEMPLATE;
    this._backdrop   = root.querySelector('.backdrop');
    this._cancelBtn  = root.querySelector('.btn.cancel');
    this._confirmBtn = root.querySelector('.btn.confirm');
  }

  connectedCallback() {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'dialog');
    if (!this.hasAttribute('aria-modal')) this.setAttribute('aria-modal', 'true');
    if (!this.hasAttribute('hidden')) this.hidden = true;
  }

  open() {
    return new Promise((resolve) => {
      const close = (result) => {
        this.hidden = true;
        this._confirmBtn.removeEventListener('click', onConfirm);
        this._cancelBtn.removeEventListener('click', onCancel);
        this._backdrop.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      };
      const onConfirm = () => close(true);
      const onCancel  = () => close(false);
      const onKey = (e) => {
        if (e.key === 'Escape') onCancel();
        // Enter confirms only when focus is outside the modal buttons; if a
        // button is focused, the browser's native click activation handles it
        // (so Enter while tabbed to Cancel cancels, not confirms). Focus lives
        // inside the shadow root, so we read shadowRoot.activeElement.
        if (e.key === 'Enter') {
          const active = this.shadowRoot.activeElement;
          if (active !== this._cancelBtn && active !== this._confirmBtn) onConfirm();
        }
      };
      this._confirmBtn.addEventListener('click', onConfirm);
      this._cancelBtn.addEventListener('click', onCancel);
      this._backdrop.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
      this.hidden = false;
      this._confirmBtn.focus();
    });
  }
}

customElements.define('chat-modal', ChatModal);

let singleton = null;

export function openConfirmModal() {
  if (!singleton) {
    singleton = document.createElement('chat-modal');
    document.body.appendChild(singleton);
  }
  return singleton.open();
}
