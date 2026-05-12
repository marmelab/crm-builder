export function el(tag, props, ...children) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === 'className') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'dataset' && typeof v === 'object') for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = dv;
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return e;
}

export function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export function formatDuration(ms) {
  if (ms <= 0) return '—';
  const totalS = ms / 1000;
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = Math.floor(totalS % 60);
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  if (s === 0) return '<1s';
  return `${s}s`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Build a monospace, right-aligned text block for the 4-way token breakdown
// (input / cache-creation / output / cache-read) plus an optional cost line.
// Native `title=` tooltips render in proportional sans-serif so columns never
// line up — callers should drop this text into a `.tk-tip` element (monospace
// + `white-space: pre`) defined in chat.css.
export function tokenBreakdownText(breakdown, opts = {}) {
  const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
  const totalLabel = opts.totalLabel || 'total';
  const showCost = typeof opts.costUsd === 'number';
  const costPrecision = opts.costPrecision ?? 4;
  const rows = [
    ['input',          breakdown?.input       || 0],
    ['cache-creation', breakdown?.cacheCreate || 0],
    ['output',         breakdown?.output      || 0],
    ['cache-read',     breakdown?.cacheRead   || 0],
  ];
  const total =
    (breakdown?.input       || 0) +
    (breakdown?.cacheCreate || 0) +
    (breakdown?.output      || 0) +
    (breakdown?.cacheRead   || 0);
  const costStr = showCost ? `$${opts.costUsd.toFixed(costPrecision)}` : '';
  const labelW = Math.max(
    totalLabel.length,
    showCost ? 'cost'.length : 0,
    ...rows.map(([l]) => l.length),
  );
  const valueW = Math.max(
    fmtN(total).length,
    showCost ? costStr.length : 0,
    ...rows.map(([, v]) => fmtN(v).length),
  );
  const sep = '─'.repeat(labelW + 2 + valueW);
  const lines = rows.map(
    ([l, v]) => `${l.padEnd(labelW)}  ${fmtN(v).padStart(valueW)}`,
  );
  lines.push(sep);
  lines.push(`${totalLabel.padEnd(labelW)}  ${fmtN(total).padStart(valueW)}`);
  if (showCost) {
    lines.push('');
    lines.push(`${'cost'.padEnd(labelW)}  ${costStr.padStart(valueW)}`);
  }
  return lines.join('\n');
}

// Wrap a label element with a CSS-styled hover tooltip carrying the token
// breakdown. The returned `<span class="tk-host">` displays `labelEl` and
// reveals a `.tk-tip` child on hover. CSS in chat.css does the heavy lifting.
export function withBreakdownTooltip(labelText, breakdown, opts = {}) {
  const host = el('span', { className: 'tk-host' }, labelText);
  if (!breakdown) return host;
  const tip = el('span', { className: 'tk-tip' });
  tip.textContent = tokenBreakdownText(breakdown, opts);
  host.appendChild(tip);
  return host;
}

export function formatRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days} d ago`;
  return d.toLocaleDateString();
}
