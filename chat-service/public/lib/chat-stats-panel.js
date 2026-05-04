const TEMPLATE = `
  <style>
    :host {
      position: fixed; top: 0; bottom: 0;
      left: calc(var(--sidebar-width) + var(--widget-width));
      width: calc(100vw - var(--sidebar-width) - var(--widget-width));
      z-index: 200;
      background: #1c1c1e; border-left: 1px solid #3a3a3c;
      box-shadow: -4px 0 30px rgba(0, 0, 0, .5);
      display: flex; flex-direction: column;
      overflow: hidden;
      transition: left .2s, width .2s, transform .25s ease, opacity .2s;
    }
    /* Override the UA default \`display: none\` for [hidden] so the panel can
       transition. Slides off to the right and fades out instead. */
    :host([hidden]) {
      display: flex;
      transform: translateX(100%);
      opacity: 0;
      pointer-events: none;
    }
    header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px; border-bottom: 1px solid #2c2c2e;
      font-weight: 600; color: #f2f2f7; font-size: 13px;
      flex-shrink: 0;
    }
    .close {
      background: none; border: none; color: #8e8e93;
      cursor: pointer; font-size: 16px; padding: 2px 6px; border-radius: 6px;
      transition: background .15s, color .15s;
    }
    .close:hover { background: #2c2c2e; color: #fff; }
    .body {
      flex: 1; overflow-y: auto; padding: 16px;
      font-size: 13px; color: #f2f2f7;
    }
    .body::-webkit-scrollbar { width: 4px; }
    .body::-webkit-scrollbar-thumb { background: #3a3a3c; border-radius: 2px; }

    .stats-loading { padding: 24px; text-align: center; color: #8e8e93; }
    .stats-error {
      padding: 16px; color: #f87171;
      background: rgba(248, 113, 113, .08); border-radius: 10px;
    }
    .stats-error button {
      margin-top: 8px; margin-right: 8px;
      background: #2c2c2e; border: 1px solid #3a3a3c; color: #f2f2f7;
      padding: 6px 12px; border-radius: 8px; cursor: pointer;
    }

    .stats-section { margin-bottom: 20px; }
    .stats-kpi-line {
      display: flex; flex-wrap: wrap; gap: 12px;
      align-items: center;
      font-size: 12px; color: #d1d5db;
      padding: 10px 12px; background: #2c2c2e; border-radius: 10px;
      font-variant-numeric: tabular-nums;
    }
    .stats-kpi-line .kpi-spacer { margin-left: auto; }
    .stats-kpi-line .kpi-warn { color: #f59e0b; }

    .stats-team-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .stats-team-pill {
      border: 1px solid; padding: 4px 10px; border-radius: 999px;
      font-size: 11px; font-weight: 500;
    }

    .stats-breakdown {
      display: flex; margin-top: 12px; height: 22px;
      border-radius: 6px; overflow: hidden; background: #2c2c2e;
    }
    .stats-breakdown-seg {
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; color: #1c1c1e; font-weight: 600;
      background: #3b82f6; border-right: 1px solid #1c1c1e;
      white-space: nowrap; overflow: hidden;
    }
    .stats-breakdown-seg:nth-child(2n) { background: #8b5cf6; }
    .stats-breakdown-seg:nth-child(3n) { background: #f97316; }
    .stats-breakdown-seg:nth-child(4n) { background: #10b981; }
    .stats-breakdown-seg:nth-child(5n) { background: #f59e0b; }

    .stats-section-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; color: #d1d5db; }

    .phase-row { margin-bottom: 4px; border-radius: 8px; background: #2c2c2e; }
    .phase-row summary {
      list-style: none; padding: 8px 10px;
      display: grid; grid-template-columns: auto auto auto 1fr auto auto auto auto;
      gap: 8px; align-items: center; font-size: 12px; cursor: pointer;
    }
    .phase-row summary::before { content: '▸'; font-size: 9px; opacity: .5; }
    .phase-row[open] summary::before { content: '▾'; }
    .phase-time { font-variant-numeric: tabular-nums; color: #8e8e93; font-size: 11px; }
    .phase-icon { font-size: 13px; }
    .phase-name { font-weight: 600; color: #f2f2f7; }
    .phase-desc { color: #8e8e93; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .phase-stats { color: #8e8e93; font-size: 11px; font-variant-numeric: tabular-nums; }
    .phase-warn { color: #f59e0b; font-size: 11px; }
    .phase-team { border: 1px solid; padding: 1px 6px; border-radius: 10px; font-size: 10px; font-weight: 600; }
    .phase-team.muted { color: #636366; border-color: #3a3a3c; }

    .phase-children { padding: 6px 10px 10px 30px; border-top: 1px solid #3a3a3c; }
    .phase-empty { padding: 6px 10px 10px 30px; color: #636366; font-size: 11px; font-style: italic; }
    .child-row {
      display: grid; grid-template-columns: auto auto auto 1fr auto;
      gap: 8px; font-size: 11px; padding: 3px 0; align-items: center;
    }
    .child-time { color: #636366; font-variant-numeric: tabular-nums; }
    .child-label { color: #f2f2f7; font-weight: 500; }
    .child-detail { color: #8e8e93; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .child-dur { color: #636366; font-variant-numeric: tabular-nums; }
    .child-hook .child-label { color: #a78bfa; }
    .child-skill .child-label { color: #34d399; }
    .child-stream_gap { opacity: 0.65; font-style: italic; }
    .child-stream_gap .child-label { color: #8e8e93; }

    .stats-sub { margin-bottom: 16px; }
    .stats-sub h4 {
      font-size: 11px; font-weight: 600; color: #8e8e93;
      margin-bottom: 6px; text-transform: uppercase; letter-spacing: .04em;
    }
    .sub-row {
      display: grid; grid-template-columns: 1fr auto auto;
      gap: 10px; padding: 4px 0; font-size: 11px; align-items: center;
      border-bottom: 1px solid #2c2c2e;
    }
    .sub-main { color: #f2f2f7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub-count { color: #8e8e93; font-variant-numeric: tabular-nums; font-size: 10px; }
    .sub-meta { color: #636366; font-size: 10px; font-variant-numeric: tabular-nums; }
    .sub-ok { color: #34d399; }
    .sub-fail { color: #f87171; }
    .sub-skip { color: #8e8e93; }
    .sub-blocking { color: #a78bfa; font-style: italic; }
    .sub-empty { color: #636366; font-style: italic; font-size: 11px; padding: 4px 0; }
    .stats-note { font-size: 10px; color: #636366; font-style: italic; margin-top: 8px; }

    .err-row { margin-bottom: 4px; border-radius: 8px; background: #2c2c2e; }
    .err-row summary {
      list-style: none; padding: 6px 10px;
      display: grid; grid-template-columns: auto auto 1fr auto auto;
      gap: 8px; align-items: center; font-size: 12px; cursor: pointer;
    }
    .err-row summary::before { content: '▸'; font-size: 9px; opacity: .5; }
    .err-row[open] summary::before { content: '▾'; }
    .err-time { color: #636366; font-variant-numeric: tabular-nums; font-size: 11px; }
    .err-summary { color: #f2f2f7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .err-meta { color: #8e8e93; font-size: 10px; }
    .err-meta.muted { color: #636366; }
    .err-error .err-icon { color: #f87171; }
    .err-retry .err-icon { color: #f59e0b; }
    .err-payload {
      padding: 8px 12px; margin: 0;
      background: #1c1c1e; font-size: 10px; color: #8e8e93;
      overflow-x: auto; max-height: 240px; overflow-y: auto;
      border-top: 1px solid #3a3a3c;
    }
  </style>
  <header>
    <span><slot name="title">Session statistics</slot></span>
    <button class="close" title="Close stats" aria-label="Close stats">✕</button>
  </header>
  <div class="body" part="body"></div>
`;

export class ChatStatsPanel extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = TEMPLATE;
    this._body = root.querySelector('.body');
    root.querySelector('.close').addEventListener('click', () => this.close());
  }

  connectedCallback() {
    if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', 'Session statistics');
  }

  /** The scrollable content area where consumers render the stats body. */
  get body() {
    return this._body;
  }

  show() {
    this.hidden = false;
  }

  close() {
    this.hidden = true;
    this.dispatchEvent(new CustomEvent('close'));
  }
}

customElements.define('chat-stats-panel', ChatStatsPanel);
