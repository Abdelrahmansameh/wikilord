const fs = require('fs');
const must = (c, m) => { if (!c) throw new Error('patch failed: ' + m); };

// ---- history.js: money totals over the whole history
let hj = fs.readFileSync('src/history.js', 'utf8'); let x = hj;
hj = hj.replace("  for (const e of rows) counts[e.type] = (counts[e.type] ?? 0) + 1;", "  const sums = { won: 0, sold: 0, recycled: 0 };\n  for (const e of rows) {\n    counts[e.type] = (counts[e.type] ?? 0) + 1;\n    if (e.type === 'won') sums.won += e.price ?? 0;\n    if (e.type === 'sold') sums.sold += e.price ?? 0;\n    if (e.type === 'recycled') sums.recycled += e.gained ?? 0;\n  }");
hj = hj.replace("  return { events: rows.reverse().slice(0, limit), counts, total: rows.length };", "  return { events: rows.reverse().slice(0, limit), counts, sums, total: rows.length };");
must(hj !== x && hj.includes('sums'), 'history sums');
fs.writeFileSync('src/history.js', hj);

// ---- ui.html: the Cards page
let h = fs.readFileSync('src/ui.html', 'utf8'); x = h;
h = h.replace("const TABS = [['dashboard', 'Dashboard'], ['bid', 'Bid rules'],", "const TABS = [['dashboard', 'Dashboard'], ['cards', 'Cards'], ['bid', 'Bid rules'],");
must(h !== x, 'tabs');
x = h;
h = h.replace("  else if (tab === 'connect') v.replaceChildren(renderConnect());", "  else if (tab === 'connect') v.replaceChildren(renderConnect());\n  else if (tab === 'cards') { v.replaceChildren(renderCards()); loadCards(); }");
must(h !== x, 'route');
x = h;
h = h.replace("    if (tab === 'dashboard') { const l = $('#log');", "    if (tab === 'cards' && !window.__cardsBusy) loadCards();\n    if (tab === 'dashboard') { const l = $('#log');");
must(h !== x, 'poll refresh');

x = h;
h = h.replace("/* ---------- connect (login) ---------- */", `/* ---------- cards: lifetime history of every card event ---------- */
const CARD_EVENTS = {
  pack: ['Opened in a pack', ''],
  won: ['Bought (won bid)', 'good'],
  recycled: ['Recycled', ''],
  listed: ['Listed for sale', ''],
  sold: ['Sold', 'good'],
};
const cardsFilter = { type: '', q: '' };

function renderCards() {
  const box = h('div', { id: 'cardsbox' });
  const chips = h('div', { id: 'cardchips', style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px' });
  const search = h('input', { type: 'text', placeholder: 'Search by card name…', value: cardsFilter.q, style: 'max-width:280px', oninput: (e) => { cardsFilter.q = e.target.value; loadCards(); } });
  box.append(
    h('p', { class: 'hint' }, 'Every card the bot has seen: opened in packs, won at auction, recycled, put on sale and sold. This is a lifetime log kept on this computer (it starts from when this feature was added). Cards the bot won by bidding, and cards that match a bid rule, are never sold or recycled.'),
    h('div', { id: 'cardsum', class: 'grid' }), chips, h('div', { style: 'margin-bottom:10px' }, search), h('div', { id: 'cardtable' }));
  return box;
}

async function loadCards() {
  window.__cardsBusy = true;
  try {
    const qs = new URLSearchParams({ limit: '500' });
    if (cardsFilter.type) qs.set('type', cardsFilter.type);
    if (cardsFilter.q) qs.set('q', cardsFilter.q);
    const r = await api('/api/cards-history?' + qs);
    if (!r.ok || tab !== 'cards' || !$('#cardtable')) return;
    const { events, counts, sums, total } = r.data;
    const tile = (label, n, sub) => h('div', { class: 'stat' }, h('b', {}, n), h('span', {}, label + (sub ? ' · ' + sub : '')));
    $('#cardsum').replaceChildren(
      tile('Opened in packs', counts.pack ?? 0), tile('Bought', counts.won ?? 0, '−' + (sums.won ?? 0)),
      tile('Recycled', counts.recycled ?? 0, '+' + (sums.recycled ?? 0)), tile('Listed for sale', counts.listed ?? 0), tile('Sold', counts.sold ?? 0, '+' + (sums.sold ?? 0)));
    $('#cardchips').replaceChildren(...[['', 'All'], ...Object.entries(CARD_EVENTS).map(([k, v]) => [k, v[0]])].map(([k, label]) =>
      h('button', { class: cardsFilter.type === k ? 'primary' : '', onclick: () => { cardsFilter.type = k; loadCards(); } }, label + (k ? ' (' + (counts[k] ?? 0) + ')' : ''))));
    const rows = events.map((e) => {
      const [label, cls] = CARD_EVENTS[e.type] ?? [e.type, ''];
      const amount = e.type === 'recycled' ? (e.gained ? '+' + e.gained : '') : e.type === 'won' ? '−' + (e.price ?? '') : e.type === 'sold' ? '+' + (e.price ?? '') : e.type === 'listed' ? (e.price ?? '') : '';
      const note = [e.wishlist ? 'on wishlist' : '', e.rule ? 'rule: ' + e.rule : '', e.average != null ? 'avg ' + e.average : ''].filter(Boolean).join(' · ');
      return h('tr', {}, h('td', {}, new Date(e.at).toLocaleString()), h('td', {}, h('span', { class: cls === 'good' ? 'good' : '' }, label)),
        h('td', {}, e.title ?? e.cardId ?? ''), h('td', {}, h('span', { class: 'chip' }, e.rarity ?? '')), h('td', {}, amount), h('td', { class: 'hint' }, note));
    });
    $('#cardtable').replaceChildren(rows.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Event', 'Card', 'Rarity', 'Coins', 'Note'].map((x) => h('th', {}, x)))), h('tbody', {}, rows),
        ...(total > events.length ? [h('p', { class: 'hint' }, 'Showing the latest ' + events.length + ' of ' + total + ' events.')] : []))
      : h('p', { class: 'empty' }, 'Nothing here yet. Events are recorded from now on as the bot opens packs, wins auctions, recycles and sells.'));
  } finally {
    window.__cardsBusy = false;
  }
}

/* ---------- connect (login) ---------- */`);
must(h !== x && h.includes('function loadCards'), 'cards page');
fs.writeFileSync('src/ui.html', h);
console.log('cards page patched');
