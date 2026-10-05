import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Run the actual inline dashboard with a small DOM and controllable network. Some
// tests deliberately deliver aborted responses to exercise the stale-view guards.
function dashboard(t, { tab = 'browse', honorAbort = true } = {}) {
  const elements = new Map(), requests = [], intervals = [];
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
      open: false, checked: false, style: {}, dataset: {}, firstChild: { textContent: '' },
      selectedOptions: [{ text: 'Stat' }], attributes: {}, handlers: {},
      classList: { toggle() {} }, closest() { return null; },
      querySelector(child) { return element(selector + ' ' + child); },
      querySelectorAll() { return []; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      showModal() { this.open = true; },
      close() { this.open = false; this.handlers.close?.({}); },
      hidePopover() {},
    });
    return elements.get(selector);
  }
  element('#b-status').value = '';
  element('#sc-rarity').value = 'UR';
  element('#sc-x').value = 'pageviews';
  const document = {
    hidden: false, body: { append() {} }, documentElement: {}, handlers: {},
    querySelector: element, getElementById: (id) => element('#' + id),
    querySelectorAll() { return []; }, createElement: (tag) => element(tag),
    addEventListener(name, handler) { this.handlers[name] = handler; },
  };
  const context = vm.createContext({
    document, AbortController, AbortSignal, URLSearchParams, Date,
    getComputedStyle: () => ({ getPropertyValue: () => '#123456' }),
    localStorage: { getItem: () => JSON.stringify({ tab }), setItem() {} },
    setTimeout, clearTimeout, setInterval: (handler, ms) => { intervals.push({ handler, ms }); },
    addEventListener() {}, console: { error() {} },
    Chart: class {
      constructor(_canvas, config) { this.config = config; this.data = config.data; }
      destroy() {} update() {}
    },
    fetch(url, { signal } = {}) {
      return new Promise((resolve, reject) => {
        const request = { url, signal, settled: false,
          respond(data, status = 200) {
            if (this.settled) return;
            this.settled = true;
            resolve({ ok: status < 400, status, json: async () => data });
          },
          reject(error = new DOMException('Aborted', 'AbortError')) {
            if (this.settled) return;
            this.settled = true; reject(error);
          },
        };
        requests.push(request);
        if (honorAbort) {
          if (signal?.aborted) request.reject();
          else signal?.addEventListener('abort', () => request.reject(), { once: true });
        }
      });
    },
  });
  vm.runInContext(script, context);
  t.after(async () => {
    vm.runInContext('activeView?.controller.abort(); rankingPending?.controller.abort(); activeDialog?.abort();', context);
    for (const request of requests) request.reject();
    await tick();
  });
  return { context, element, requests, intervals, document,
    run: (code) => vm.runInContext(code, context),
    request: (path) => requests.findLast((r) => r.url.startsWith('/api/' + path)),
  };
}

test('changing a page starts immediately and cannot be overwritten by its old response', async (t) => {
  const ui = dashboard(t, { honorAbort: false });
  const first = ui.request('auctions');
  const next = ui.run('state.browse.page = 2; refresh()');
  const second = ui.request('auctions');
  assert.notEqual(second, first);
  assert.equal(first.signal.aborted, true);
  assert.equal(new URL('http://localhost' + second.url).searchParams.get('page'), '2');
  second.respond({ rows: [], page: 2, hasMore: true });
  await next;
  assert.equal(ui.element('#b-page').textContent, 'Page 2');
  first.respond({ rows: [], page: 1, hasMore: false });
  await tick();
  assert.equal(ui.element('#b-page').textContent, 'Page 2');
});

test('overview paints its totals while slow distribution panels are still loading', async (t) => {
  const ui = dashboard(t, { tab: 'overview' });
  ui.request('overview').respond({ totals: { n: 123, sold: 10, volume: 400, bids: 30, buyers: 8, sellers: 20 }, series: [], step: 3600000 });
  await tick();
  assert.match(ui.element('#tiles').innerHTML, /123/);
  assert.equal(ui.request('turnover').settled, false);
  assert.equal(ui.request('auction-appearances').settled, false);
  assert.equal(new URL('http://localhost' + ui.request('auctions').url).searchParams.get('limit'), '15');
  const count = ui.requests.length;
  ui.run('refresh(true)');
  assert.equal(ui.requests.length, count, 'background refresh does not duplicate pending work');
  ui.run('go("players")');
  assert.ok(ui.request('players'), 'a different page starts without waiting for the slow panels');
});

test('card detail and search start concurrently without irrelevant range filters', (t) => {
  const ui = dashboard(t, { tab: 'cards' });
  ui.run('state.card.id = "physical-card"; state.range = "all"; refresh()');
  const search = ui.request('cards'), detail = ui.request('card?');
  assert.ok(search && detail);
  assert.equal(search.settled, false);
  assert.equal(new URL('http://localhost' + detail.url).searchParams.get('id'), 'physical-card');
  assert.equal(new URL('http://localhost' + detail.url).searchParams.has('range'), false);
  assert.equal(new URL('http://localhost' + search.url).searchParams.has('range'), false);
  assert.equal(ui.requests.some((r) => r.url.startsWith('/api/card-rankings')), false);
});

test('rankings load independently and a ranking row opens card details without another ranking request', async (t) => {
  const ui = dashboard(t, { tab: 'rankings' });
  const rankings = ui.request('card-rankings');
  assert.ok(rankings);
  assert.equal(new URL('http://localhost' + rankings.url).searchParams.has('range'), false);
  assert.equal(ui.request('cards?'), undefined);
  rankings.respond([{ id: 'ranked-card', title: 'Ranked card', rarity: 'R', times_sold: 5 }]);
  await tick();
  const row = { dataset: { i: '0' } };
  ui.element('#t-card-rankings').onclick({ target: { closest: (selector) => selector === 'tbody tr.click' ? row : null } });
  assert.equal(ui.run('state.tab'), 'cards');
  assert.equal(new URL('http://localhost' + ui.request('card?').url).searchParams.get('id'), 'ranked-card');
  assert.equal(ui.requests.filter((r) => r.url.startsWith('/api/card-rankings')).length, 1);
  assert.ok(ui.request('cards?'));
});

test('status requests are deduplicated and polling pauses for a hidden dashboard', async (t) => {
  const ui = dashboard(t);
  ui.run('pollStatus(); pollStatus()');
  assert.equal(ui.requests.filter((r) => r.url === '/api/status').length, 1);
  ui.request('status').respond({ collector: { last5min: {}, needsLogin: false }, accounts: [], db: { settled: 1, bytes: 2048 } });
  await tick();
  assert.equal(ui.element('#state').textContent, 'collecting · 0 recorded in 5 min');
  assert.equal(ui.element('#loginText').textContent, '');
  ui.document.hidden = true;
  for (const interval of ui.intervals) interval.handler();
  assert.equal(ui.requests.filter((r) => r.url === '/api/status').length, 1);
});

test('failed requests show an actionable retry instead of a permanently loading page', async (t) => {
  const ui = dashboard(t);
  ui.request('auctions').respond({ error: 'Analysis is busy. Please retry.' }, 503);
  await tick();
  assert.equal(ui.element('#loadNotice').hidden, false);
  assert.equal(ui.element('#loadRetry').hidden, false);
  assert.match(ui.element('#loadText').textContent, /Please retry/);
  ui.element('#loadRetry').handlers.click();
  assert.equal(ui.requests.filter((r) => r.url.startsWith('/api/auctions')).length, 2);
});

test('all category groups remain accessible while table and chart rendering are bounded', async (t) => {
  const ui = dashboard(t, { tab: 'categories' });
  const groups = Array.from({ length: 3000 }, (_, i) => ({ g: String(i), label: 'group ' + i,
    n: i + 10, price_index: 1, sell_through: 0.5 }));
  ui.run('state.cat.show = 100000');
  ui.request('category-groups').respond({ groups, total: 40000 });
  await tick();
  assert.equal((ui.element('#t-cats').innerHTML.match(/<tr class="click"/g) ?? []).length, 250);
  assert.equal(ui.element('#cat-page').textContent, 'Page 1 of 12');
  assert.equal(ui.run('charts["c-cat-map"].data.datasets[0].data.length'), 2000);
  assert.match(ui.element('#cat-map-sub').textContent, /2\D000 largest of 3\D000/);
  ui.element('#cat-next').handlers.click();
  assert.equal(ui.element('#cat-page').textContent, 'Page 2 of 12');
});

test('opening and closing details cancels their requests and rejects stale dialog results', async (t) => {
  const ui = dashboard(t, { honorAbort: false });
  const first = ui.run('loadDialog("/api/auction?id=old", "Loading…")');
  assert.equal(ui.element('#dlg').open, true);
  const firstRequest = ui.request('auction?');
  const second = ui.run('loadDialog("/api/auction?id=new", "Loading…")');
  assert.equal(firstRequest.signal.aborted, true);
  ui.request('auction?').respond({ auction: { id: 'new' } });
  assert.equal((await second).auction.id, 'new');
  firstRequest.respond({ auction: { id: 'old' } });
  assert.equal(await first, null);
  const third = ui.run('loadDialog("/api/auction?id=closed", "Loading…")');
  ui.element('#dlg').close();
  assert.equal(ui.request('auction?').signal.aborted, true);
  ui.request('auction?').respond({ auction: { id: 'closed' } });
  assert.equal(await third, null);
});

test('a request timeout aborts its fetch and reports a retryable error', async (t) => {
  const ui = dashboard(t);
  const request = ui.run('requestJSON("/api/delayed", { timeout: 5 })');
  await assert.rejects(request, /Loading took too long/);
  assert.equal(ui.request('delayed').signal.aborted, true);
});

test('scatter controls keep their selected rarity when the global rarity differs', (t) => {
  const ui = dashboard(t, { tab: 'prices' });
  ui.run('state.rarity.add("R"); refresh(); drawScatter()');
  assert.equal(new URL('http://localhost' + ui.request('scatter').url).searchParams.get('rarity'), 'UR');
});

test('collector renders during database warmup and replaces loading totals when statistics arrive', async (t) => {
  const ui = dashboard(t, { tab: 'collector' });
  const status = { collector: { last5min: {}, lastHour: {}, series: [], needsLogin: false }, accounts: [], config: {} };
  ui.request('status').respond(status);
  await tick();
  assert.match(ui.element('#c-tiles').innerHTML, /Loading totals…/);
  assert.match(ui.element('#c-detail').innerHTML, /Loading totals…/);
  assert.equal(ui.element('#dbsize').textContent, 'Loading database totals…');
  assert.equal(ui.element('#loadNotice').hidden, true);
  const refreshed = ui.run('pollStatus()');
  ui.request('status').respond({ ...status, db: { settled: 321, bids: 22, bytes: 1024, users: 3, cards: 7 } });
  await refreshed;
  assert.doesNotMatch(ui.element('#c-tiles').innerHTML, /Loading totals…/);
  assert.match(ui.element('#c-tiles').innerHTML, /321 settled/);
  assert.match(ui.element('#c-detail').innerHTML, /3 \/ 7/);
});
