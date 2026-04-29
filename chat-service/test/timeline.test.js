import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------- Minimal DOM stub ----------
// Only what `dom.js#el()` and `timeline.js` actually touch. Kept inline to
// avoid a jsdom dependency (project deliberately ships ~zero dev deps).

class FakeTextNode {
  constructor(data) { this.data = String(data); this.parentNode = null; }
  get textContent() { return this.data; }
}

function makeClassList(el) {
  return {
    add(...classes) {
      const set = new Set(el.className.split(/\s+/).filter(Boolean));
      for (const c of classes) set.add(c);
      el.className = [...set].join(' ');
    },
    remove(...classes) {
      const set = new Set(el.className.split(/\s+/).filter(Boolean));
      for (const c of classes) set.delete(c);
      el.className = [...set].join(' ');
    },
    contains(c) {
      return el.className.split(/\s+/).includes(c);
    },
  };
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.title = '';
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.dataset = {};
    this.onclick = null;
    this._innerHTML = '';
    this._attributes = {};
    this._listeners = {};
    this.classList = makeClassList(this);
  }
  appendChild(child) {
    if (child) {
      child.parentNode = this;
      this.children.push(child);
    }
    return child;
  }
  setAttribute(k, v) { this._attributes[k] = String(v); }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this._attributes, k)
      ? this._attributes[k]
      : null;
  }
  addEventListener(event, fn) { (this._listeners[event] ||= []).push(fn); }
  dispatchEvent(event) {
    for (const fn of (this._listeners[event.type] || [])) fn(event);
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = String(v);
    if (v === '') this.children.length = 0;
  }
  get textContent() {
    let out = '';
    for (const c of this.children) out += c.textContent;
    return out;
  }
}

globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (data) => new FakeTextNode(data),
};

function findAll(node, predicate) {
  const out = [];
  (function walk(n) {
    if (n instanceof FakeElement && predicate(n)) out.push(n);
    if (n.children) for (const c of n.children) walk(c);
  })(node);
  return out;
}
const findByClass = (node, cls) => findAll(node, (n) => n.classList.contains(cls));
const findOneByClass = (node, cls) => findByClass(node, cls)[0];

// ---------- fetch mock ----------
let fetchHandler = null;
let fetchCalls = [];
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options });
  if (!fetchHandler) throw new Error(`Unmocked fetch: ${url}`);
  return fetchHandler(url, options);
};

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

// ---------- Module under test ----------
// Imported AFTER globals are installed. ES module imports are hoisted, but
// timeline.js / dom.js don't touch `document` at module scope — only inside
// functions. So this lazy-call shape is fine.
const { initTimeline } = await import('../public/lib/sessions/timeline.js');

// ---------- Test harness ----------
function setup({ sessionId = null, list = [] } = {}) {
  fetchHandler = (url) => {
    if (url === '/api/sessions') return jsonResponse(list);
    if (/^\/api\/sessions\/.+\/touch$/.test(url)) return jsonResponse({ ok: true });
    throw new Error(`Unexpected URL: ${url}`);
  };
  fetchCalls = [];

  const timelinePanel = new FakeElement('div'); timelinePanel.hidden = true;
  const timelineList = new FakeElement('ul');
  const timelineEmpty = new FakeElement('div'); timelineEmpty.hidden = true;
  const timelineBtn = new FakeElement('button');
  const timelineClose = new FakeElement('button');

  const switchCalls = [];
  const api = initTimeline({
    timelinePanel,
    timelineList,
    timelineEmpty,
    timelineBtn,
    timelineClose,
    getSessionId: () => sessionId,
    switchSession: (id) => switchCalls.push(id),
  });

  return {
    api,
    timelinePanel,
    timelineList,
    timelineEmpty,
    timelineBtn,
    timelineClose,
    switchCalls,
  };
}

beforeEach(() => {
  fetchHandler = null;
  fetchCalls = [];
});

// ---------- Tests ----------

test('open() with empty list shows empty state and reveals panel', async () => {
  const ctx = setup({ list: [] });
  await ctx.api.open();
  assert.equal(ctx.timelinePanel.hidden, false);
  assert.equal(ctx.timelineEmpty.hidden, false);
  assert.equal(ctx.timelineList.children.length, 0);
});

test('open() renders one li per session and hides empty state', async () => {
  const list = [
    { id: 's1', title: 'First', state: 'completed', messageCount: 3, lastMessageAt: '2026-04-28T10:00:00.000Z' },
    { id: 's2', title: 'Second', state: 'in_progress', messageCount: 1, createdAt: '2026-04-28T11:00:00.000Z' },
  ];
  const ctx = setup({ list });
  await ctx.api.open();
  assert.equal(ctx.timelineEmpty.hidden, true);
  assert.equal(ctx.timelinePanel.hidden, false);
  assert.equal(ctx.timelineList.children.length, 2);
  for (const li of ctx.timelineList.children) {
    assert.ok(li.classList.contains('timeline-item'));
  }
});

test('open() renders summary, state label, and pluralized count', async () => {
  const ctx = setup({
    list: [
      { id: 's1', summary: 'Renamed Dernière activité label to plural form', state: 'completed', messageCount: 5, lastMessageAt: '2026-04-28T10:00:00.000Z' },
      { id: 's2', summary: '', state: 'cancelled', messageCount: 1, lastMessageAt: '2026-04-28T11:00:00.000Z' },
    ],
  });
  await ctx.api.open();
  const [li1, li2] = ctx.timelineList.children;

  assert.equal(findOneByClass(li1, 'timeline-title').textContent, 'Renamed Dernière activité label to plural form');
  const state1 = findOneByClass(li1, 'timeline-state');
  assert.equal(state1.textContent, 'Completed');
  assert.ok(state1.classList.contains('state-completed'));
  assert.equal(findOneByClass(li1, 'timeline-count').textContent, '5 messages');

  // Empty summary falls back to "(no summary yet)"
  assert.equal(findOneByClass(li2, 'timeline-title').textContent, '(no summary yet)');
  // messageCount === 1 → singular
  assert.equal(findOneByClass(li2, 'timeline-count').textContent, '1 message');
  assert.ok(findOneByClass(li2, 'timeline-state').classList.contains('state-cancelled'));
});

test('open() prefers summary over title, and falls back to title when summary is empty', async () => {
  const ctx = setup({
    list: [
      // No summary → fall back to the meta title.
      { id: 's1', title: 'Auto-generated meta title', summary: '', state: 'in_progress', messageCount: 1 },
      // Summary present → it wins over the meta title.
      { id: 's2', title: 'Auto-generated meta title', summary: 'Real summary from changelog', state: 'completed', messageCount: 2 },
    ],
  });
  await ctx.api.open();
  const [li1, li2] = ctx.timelineList.children;
  assert.equal(findOneByClass(li1, 'timeline-title').textContent, 'Auto-generated meta title');
  assert.equal(findOneByClass(li2, 'timeline-title').textContent, 'Real summary from changelog');
});

test('Rollback button is disabled when state is not completed', async () => {
  const ctx = setup({
    list: [
      { id: 's1', summary: 'done', state: 'completed', messageCount: 1 },
      { id: 's2', summary: '', state: 'in_progress', messageCount: 1 },
      { id: 's3', summary: '', state: 'cancelled', messageCount: 1 },
      { id: 's4', summary: '', state: 'waiting', messageCount: 1 },
    ],
  });
  await ctx.api.open();
  const [li1, li2, li3, li4] = ctx.timelineList.children;
  assert.equal(findOneByClass(li1, 'timeline-rollback').disabled, false, 'completed → enabled');
  assert.equal(findOneByClass(li2, 'timeline-rollback').disabled, true, 'in_progress → disabled');
  assert.equal(findOneByClass(li3, 'timeline-rollback').disabled, true, 'cancelled → disabled');
  assert.equal(findOneByClass(li4, 'timeline-rollback').disabled, true, 'waiting → disabled');
});

test('open() falls back to raw state when STATE_LABELS has no entry', async () => {
  const ctx = setup({
    list: [{ id: 's1', title: 't', state: 'frobnicated', messageCount: 2 }],
  });
  await ctx.api.open();
  const state = findOneByClass(ctx.timelineList, 'timeline-state');
  assert.equal(state.textContent, 'frobnicated');
});

test('open() defaults missing state to in_progress', async () => {
  const ctx = setup({
    list: [{ id: 's1', title: 't', messageCount: 1 }],
  });
  await ctx.api.open();
  const state = findOneByClass(ctx.timelineList, 'timeline-state');
  assert.ok(state.classList.contains('state-in_progress'));
  assert.equal(state.textContent, 'In progress');
});

test('active class is applied only on the current session item', async () => {
  const ctx = setup({
    sessionId: 's2',
    list: [
      { id: 's1', title: 'a', state: 'completed', messageCount: 1 },
      { id: 's2', title: 'b', state: 'completed', messageCount: 1 },
      { id: 's3', title: 'c', state: 'completed', messageCount: 1 },
    ],
  });
  await ctx.api.open();
  const [li1, li2, li3] = ctx.timelineList.children;
  assert.equal(li1.classList.contains('active'), false);
  assert.equal(li2.classList.contains('active'), true);
  assert.equal(li3.classList.contains('active'), false);
});

test('open() sets the date title attribute to the ISO timestamp', async () => {
  const iso = '2026-04-28T10:00:00.000Z';
  const ctx = setup({
    list: [{ id: 's1', title: 't', state: 'completed', messageCount: 1, lastMessageAt: iso }],
  });
  await ctx.api.open();
  const date = findOneByClass(ctx.timelineList, 'timeline-date');
  // `el()` writes to the `title` property (real DOM would reflect to the
  // attribute via HTML reflection — our stub doesn't bother).
  assert.equal(date.title, iso);
});

test('open() swallows fetch errors and leaves panel hidden', async () => {
  const ctx = setup();
  // Override the handler installed by setup() with one that throws.
  fetchHandler = () => { throw new Error('boom'); };
  const origConsoleError = console.error;
  console.error = () => {};
  try {
    await ctx.api.open();
  } finally {
    console.error = origConsoleError;
  }
  assert.equal(ctx.timelinePanel.hidden, true, 'panel should not be revealed when fetch throws');
});

test('View button on a different session switches and closes the panel', async () => {
  const ctx = setup({
    sessionId: 's1',
    list: [
      { id: 's1', title: 'a', state: 'completed', messageCount: 1 },
      { id: 's2', title: 'b', state: 'completed', messageCount: 1 },
    ],
  });
  await ctx.api.open();
  assert.equal(ctx.timelinePanel.hidden, false);
  const li2 = ctx.timelineList.children[1];
  const viewBtn = findOneByClass(li2, 'timeline-view');
  let stopped = false;
  viewBtn.onclick({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
  assert.deepEqual(ctx.switchCalls, ['s2']);
  assert.equal(ctx.timelinePanel.hidden, true);
});

test('View button on the active session just closes the panel (no switch)', async () => {
  const ctx = setup({
    sessionId: 's1',
    list: [{ id: 's1', title: 'a', state: 'completed', messageCount: 1 }],
  });
  await ctx.api.open();
  const li = ctx.timelineList.children[0];
  const viewBtn = findOneByClass(li, 'timeline-view');
  viewBtn.onclick({ stopPropagation: () => {} });
  assert.deepEqual(ctx.switchCalls, []);
  assert.equal(ctx.timelinePanel.hidden, true);
});

test('Continue button POSTs to /touch then switches session', async () => {
  const ctx = setup({
    sessionId: 's1',
    list: [
      { id: 's1', title: 'a', state: 'completed', messageCount: 1 },
      { id: 's2', title: 'b', state: 'completed', messageCount: 1 },
    ],
  });
  await ctx.api.open();
  const li2 = ctx.timelineList.children[1];
  const continueBtn = findOneByClass(li2, 'timeline-continue');
  await continueBtn.onclick({ stopPropagation: () => {} });

  const touchCall = fetchCalls.find((c) => c.url.includes('/touch'));
  assert.ok(touchCall, 'expected a /touch fetch call');
  assert.equal(touchCall.url, '/api/sessions/s2/touch');
  assert.equal(touchCall.options?.method, 'POST');
  assert.deepEqual(ctx.switchCalls, ['s2']);
  assert.equal(ctx.timelinePanel.hidden, true);
});

test('Continue button on active session touches then closes (no switch)', async () => {
  const ctx = setup({
    sessionId: 's1',
    list: [{ id: 's1', title: 'a', state: 'completed', messageCount: 1 }],
  });
  await ctx.api.open();
  const li = ctx.timelineList.children[0];
  const continueBtn = findOneByClass(li, 'timeline-continue');
  await continueBtn.onclick({ stopPropagation: () => {} });

  const touchCall = fetchCalls.find((c) => c.url.includes('/touch'));
  assert.ok(touchCall);
  assert.equal(touchCall.url, '/api/sessions/s1/touch');
  assert.deepEqual(ctx.switchCalls, []);
  assert.equal(ctx.timelinePanel.hidden, true);
});

test('Continue button URL-encodes the session id', async () => {
  const weirdId = 'a/b c';
  const ctx = setup({
    list: [{ id: weirdId, title: 't', state: 'completed', messageCount: 1 }],
  });
  await ctx.api.open();
  const li = ctx.timelineList.children[0];
  const continueBtn = findOneByClass(li, 'timeline-continue');
  await continueBtn.onclick({ stopPropagation: () => {} });
  const touchCall = fetchCalls.find((c) => c.url.includes('/touch'));
  assert.equal(touchCall.url, `/api/sessions/${encodeURIComponent(weirdId)}/touch`);
});

test('Continue button swallows touch errors and still switches', async () => {
  fetchHandler = (url) => {
    if (url === '/api/sessions') {
      return jsonResponse([
        { id: 's1', title: 'a', state: 'completed', messageCount: 1 },
        { id: 's2', title: 'b', state: 'completed', messageCount: 1 },
      ]);
    }
    if (url.includes('/touch')) throw new Error('network down');
    throw new Error(`unexpected ${url}`);
  };
  // setup() would overwrite fetchHandler, so rebuild manually
  const timelinePanel = new FakeElement('div'); timelinePanel.hidden = true;
  const timelineList = new FakeElement('ul');
  const timelineEmpty = new FakeElement('div');
  const timelineBtn = new FakeElement('button');
  const timelineClose = new FakeElement('button');
  const switchCalls = [];
  const api = initTimeline({
    timelinePanel, timelineList, timelineEmpty, timelineBtn, timelineClose,
    getSessionId: () => 's1',
    switchSession: (id) => switchCalls.push(id),
  });

  await api.open();
  const li2 = timelineList.children[1];
  const continueBtn = findOneByClass(li2, 'timeline-continue');
  await continueBtn.onclick({ stopPropagation: () => {} });

  assert.deepEqual(switchCalls, ['s2'], 'switch must still happen even if /touch fails');
  assert.equal(timelinePanel.hidden, true);
});

test('timelineBtn click opens the panel when hidden, hides it when visible', async () => {
  const ctx = setup({ list: [] });
  // First click → open()
  ctx.timelineBtn.dispatchEvent({ type: 'click' });
  // open() is async; let microtasks flush
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.timelinePanel.hidden, false);

  // Second click → hide
  ctx.timelineBtn.dispatchEvent({ type: 'click' });
  assert.equal(ctx.timelinePanel.hidden, true);
});

test('timelineClose click hides the panel', async () => {
  const ctx = setup({ list: [] });
  await ctx.api.open();
  assert.equal(ctx.timelinePanel.hidden, false);
  ctx.timelineClose.dispatchEvent({ type: 'click' });
  assert.equal(ctx.timelinePanel.hidden, true);
});

test('refreshIfOpen is a no-op when panel is hidden (no fetch issued)', async () => {
  const ctx = setup({ list: [] });
  // panel starts hidden
  assert.equal(ctx.timelinePanel.hidden, true);
  ctx.api.refreshIfOpen();
  // wait past the 250ms debounce
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fetchCalls.length, 0);
});

test('refreshIfOpen re-fetches when panel is open (debounced)', async () => {
  const ctx = setup({ list: [] });
  await ctx.api.open();
  assert.equal(fetchCalls.length, 1, 'open() did the initial fetch');

  // Multiple rapid calls should collapse into one refresh
  ctx.api.refreshIfOpen();
  ctx.api.refreshIfOpen();
  ctx.api.refreshIfOpen();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fetchCalls.length, 2, 'debounced into a single refresh fetch');
});
