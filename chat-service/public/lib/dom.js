// Hover tooltip positioning. CSS handles show/hide (`.tk-host:hover > .tk-tip`);
// JS only repositions the visible tooltip into the viewport using `position:
// fixed`, which sidesteps any `overflow: hidden` ancestor (panel, stats bar,
// per-phase row) that would otherwise clip it. The default CSS anchor
// (top: 100%; left: 0) handles the common case where the host is in the
// upper-left of the viewport — JS kicks in only when the tip would overflow
// the right edge (most common cause of clipping reported by users) or the
// bottom edge.
function positionTip(host) {
  const tip = host.querySelector(':scope > .tk-tip');
  if (!tip) return;
  // Reset inline overrides so the natural width measurement is accurate.
  tip.style.position = '';
  tip.style.left = tip.style.right = tip.style.top = tip.style.bottom = '';
  tip.style.visibility = 'hidden';
  // Force layout while still display:none → can't measure. Temporarily flip
  // to block via inline so getBoundingClientRect returns real values.
  tip.style.display = 'block';
  const tr = tip.getBoundingClientRect();
  const hr = host.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const m = 8;
  // Prefer dropping below the host; flip above if it doesn't fit; clamp to
  // bottom of viewport as a last resort.
  let top = hr.bottom + 6;
  if (top + tr.height > vh - m) {
    const aboveTop = hr.top - tr.height - 6;
    top = aboveTop >= m ? aboveTop : Math.max(m, vh - tr.height - m);
  }
  // Horizontal: anchor at host's left edge; flip flush-right if it would
  // clip; clamp to viewport edges.
  let left = hr.left;
  if (left + tr.width > vw - m) left = vw - tr.width - m;
  if (left < m) left = m;
  tip.style.position = 'fixed';
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
  tip.style.display = '';     // hand back display control to the CSS hover rule
  tip.style.visibility = '';
}

function clearTipPosition(host) {
  const tip = host.querySelector(':scope > .tk-tip');
  if (!tip) return;
  tip.style.position = '';
  tip.style.left = tip.style.right = tip.style.top = tip.style.bottom = '';
  tip.style.display = '';
  tip.style.visibility = '';
}

if (typeof document !== 'undefined' && !document._tkTipsInit) {
  document._tkTipsInit = true;
  // Delegated handlers — one listener for the whole document covers every
  // `.tk-host` past, present and future, including tooltips rendered after
  // re-mounts (each /api/stats refresh rebuilds the panel).
  document.addEventListener('mouseover', (e) => {
    const host = e.target.closest && e.target.closest('.tk-host');
    if (!host) return;
    // Skip child traversal noise — only fire when entering from OUTSIDE host.
    if (host.contains(e.relatedTarget)) return;
    positionTip(host);
  });
  document.addEventListener('mouseout', (e) => {
    const host = e.target.closest && e.target.closest('.tk-host');
    if (!host) return;
    if (host.contains(e.relatedTarget)) return;
    clearTipPosition(host);
  });
}

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
// `tipClass` lets callers add `.tk-tip-above` when the host sits at the
// bottom of the viewport (e.g. the inline ticker).
export function withBreakdownTooltip(labelText, breakdown, opts = {}) {
  const host = el('span', { className: 'tk-host' }, labelText);
  if (!breakdown) return host;
  const tip = el('span', { className: opts.tipClass || 'tk-tip' });
  tip.textContent = tokenBreakdownText(breakdown, opts);
  host.appendChild(tip);
  return host;
}

// Strip `claude-` prefix and trailing date stamp for compact table headers
// (`claude-haiku-4-5-20251001` → `haiku-4-5`).
function shortModel(name) {
  return String(name || '?').replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function fmtN(n) { return Number(n || 0).toLocaleString('en-US'); }
function fmtUsd(n, p = 4) { return `$${Number(n || 0).toFixed(p)}`; }

// Compact token count: 12,345 → "12.3k", 1,234,567 → "1.23M". Used in the
// per-model cost table so the row fits without scrolling on narrow panels.
function fmtCompact(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2) + 'M';
  if (v >= 1_000)     return (v / 1_000).toFixed(v >= 10_000 ? 0 : 1) + 'k';
  return String(v);
}

// Build a monospace, right-aligned table mapping models → token breakdown +
// approximate per-model cost. `costTotal` is the SDK-reported authoritative
// total displayed at the bottom (the per-model figures are best-effort and
// may not sum to it exactly — pricing tables drift).
export function tokensByModelText(rows, costTotal) {
  if (!rows || rows.length === 0) return '(no per-model data yet)';
  const headers = ['model', 'input', 'cache+', 'output', 'cache-r', 'cost'];
  const data = rows.map((r) => [
    shortModel(r.model),
    fmtCompact(r.breakdown?.input),
    fmtCompact(r.breakdown?.cacheCreate),
    fmtCompact(r.breakdown?.output),
    fmtCompact(r.breakdown?.cacheRead),
    fmtUsd(r.costUsd, 4),
  ]);
  // Totals row (sum each column except model).
  const sums = [0, 0, 0, 0, 0];
  for (const r of rows) {
    sums[0] += r.breakdown?.input       || 0;
    sums[1] += r.breakdown?.cacheCreate || 0;
    sums[2] += r.breakdown?.output      || 0;
    sums[3] += r.breakdown?.cacheRead   || 0;
    sums[4] += r.costUsd                || 0;
  }
  const totalRow = ['total', fmtCompact(sums[0]), fmtCompact(sums[1]), fmtCompact(sums[2]), fmtCompact(sums[3]), fmtUsd(sums[4], 4)];
  // Column widths: max of header + all cells.
  const cols = headers.map((h, i) => {
    const cells = [h, ...data.map((row) => row[i]), totalRow[i]];
    return Math.max(...cells.map((s) => s.length));
  });
  // First column left-aligned; rest right-aligned (numbers + money).
  const fmtRow = (row) => row.map((v, i) =>
    i === 0 ? v.padEnd(cols[i]) : v.padStart(cols[i])).join('  ');
  const sep = '─'.repeat(cols.reduce((a, b) => a + b, 0) + (cols.length - 1) * 2);
  const lines = [fmtRow(headers), sep, ...data.map(fmtRow), sep, fmtRow(totalRow)];
  if (typeof costTotal === 'number' && Math.abs(costTotal - sums[4]) > 0.01) {
    lines.push('');
    const sdkLabel = 'SDK reported total';
    lines.push(`${sdkLabel.padEnd(cols[0] + 2 + cols[1] + 2 + cols[2] + 2 + cols[3] + 2 + cols[4])}  ${fmtUsd(costTotal, 4).padStart(cols[5])}`);
  }
  return lines.join('\n');
}

// Returns a `.tk-host` span carrying the cost-by-model table on hover.
export function withCostTooltip(labelText, rows, costTotal, opts = {}) {
  const host = el('span', { className: 'tk-host' }, labelText);
  const tip = el('span', { className: opts.tipClass || 'tk-tip' });
  tip.textContent = tokensByModelText(rows || [], costTotal);
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
