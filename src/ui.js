import http from 'node:http';
import fs from 'node:fs';
import { CONFIG_PATH, loadConfig, validate } from './config.js';
import { Session, cookieLooksRight, normalizeCookieInput } from './http.js';
import { readCardEvents } from './history.js';

const PAGE = new URL('./ui.html', import.meta.url);

/** Local-only dashboard. Listens on 127.0.0.1 and rejects cross-site requests. */
export function startUI({ port, getState, control, log, session, onConnected, getValues = () => ({ cards: [] }), sellCard = async () => ({ ok: false, error: 'not available' }), refreshValues = () => ({ ok: false }), refreshValue = async () => ({ ok: false }), recycleCard = async () => ({ ok: false }), getWishlist = () => new Set(), setWishlisted = async () => ({ ok: false, error: 'still starting up' }), getReport = () => ({}), getIds = () => ({}), changeTargets = () => { throw new Error('not available'); }, readJournal = () => [], catalog = async () => ({ cards: [] }), restart = () => ({ ok: false, error: 'not available' }), scanNow = async () => ({ ok: false, error: 'still starting up' }) }) {
  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let s = '';
      req.on('data', (c) => ((s += c), s.length > 1e6 && req.destroy()));
      req.on('end', () => resolve(s));
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    try {
      // Only reachable as localhost, and state-changing calls must come from our own page.
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return send(res, 403, { error: 'forbidden host' });
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (req.headers['x-bot-ui'] !== '1' || (origin && origin !== `http://${req.headers.host}`)) return send(res, 403, { error: 'forbidden' });
      }
      const url = new URL(req.url, 'http://x');

      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, getState());
      if (req.method === 'GET' && url.pathname === '/api/values') return send(res, 200, getValues());
      if (req.method === 'POST' && url.pathname === '/api/values/refresh') return send(res, 200, refreshValues());
      if (req.method === 'POST' && url.pathname === '/api/values/refresh-one') {
        const r = await refreshValue(JSON.parse((await readBody(req)) || '{}').cardId);
        return send(res, r.ok ? 200 : 400, r);
      }
      if (req.method === 'POST' && url.pathname === '/api/recycle') {
        const { cardId, force } = JSON.parse((await readBody(req)) || '{}');
        const r = await recycleCard(cardId, { force: force === true });
        return send(res, r.ok ? 200 : 400, r);
      }
      if (req.method === 'POST' && url.pathname === '/api/sell') {
        const { cardId, factor, force } = JSON.parse((await readBody(req)) || '{}');
        const r = await sellCard(cardId, { factor, force: force === true });
        return send(res, r.ok ? 200 : 400, r);
      }
      if (req.method === 'GET' && url.pathname === '/api/cards-history') {
        const q = url.searchParams;
        const r = readCardEvents({ limit: Math.min(Number(q.get('limit')) || 300, 2000), type: q.get('type') || undefined, q: q.get('q') || undefined });
        const wl = getWishlist();
        return send(res, 200, { ...r, events: r.events.map((e) => ({ ...e, onWishlist: wl.has(e.cardId) })) });
      }
      if (req.method === 'POST' && url.pathname === '/api/wishlist') {
        const { cardId, on, title } = JSON.parse((await readBody(req)) || '{}');
        const r = await setWishlisted(cardId, on === true, typeof title === 'string' ? title : undefined);
        return send(res, r.ok ? 200 : 400, r);
      }
      // Targets (targets.json): read the full report, change targets/themes with a list of ops.
      if (req.method === 'GET' && url.pathname === '/api/report') return send(res, 200, getReport());
      if (req.method === 'GET' && url.pathname === '/api/ids') return send(res, 200, getIds());
      if (req.method === 'GET' && url.pathname === '/api/journal') return send(res, 200, { entries: readJournal(Math.min(Number(url.searchParams.get('limit')) || 50, 1000)) });
      if (req.method === 'POST' && url.pathname === '/api/targets') {
        const { ops, by } = JSON.parse((await readBody(req)) || '{}');
        if (!Array.isArray(ops) || !ops.length) return send(res, 400, { error: 'send { ops: [...] }' });
        try {
          return send(res, 200, { ok: true, done: changeTargets(ops, ['agent', 'cli'].includes(by) ? by : 'you') });
        } catch (e) {
          return send(res, 400, { ok: false, error: e.message });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/catalog') {
        const q = url.searchParams;
        try {
          return send(res, 200, await catalog({ text: q.get('text') || undefined, category: q.get('category') || undefined, rarity: q.get('rarity') || undefined, minPageviews: q.get('minPageviews') || undefined, limit: q.get('limit') || 50 }));
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/scan') {
        const r = await scanNow(JSON.parse((await readBody(req)) || '{}').what);
        return send(res, r.ok ? 200 : 400, r);
      }
      if (req.method === 'POST' && url.pathname === '/api/restart') {
        const r = restart(JSON.parse((await readBody(req)) || '{}').why);
        return send(res, r.ok ? 200 : 400, r);
      }
      // The config comes with a version (file time) so a page opened long ago cannot overwrite newer settings.
      const version = () => fs.statSync(CONFIG_PATH).mtimeMs;
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return send(res, 200, { version: version(), config: JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) });
      }

      if (req.method === 'PUT' && url.pathname === '/api/config') {
        const body = JSON.parse(await readBody(req));
        if (body.version !== version()) {
          return send(res, 409, { error: 'the settings changed since this page loaded. Click Discard to load the current settings, then make your change again.' });
        }
        const next = body.config;
        const errors = validate(next);
        if (errors.length) return send(res, 400, { errors });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
        loadConfig(); // sanity: the file we just wrote must load
        log('config saved from the dashboard');
        return send(res, 200, { ok: true, version: version() });
      }

      if (req.method === 'POST' && url.pathname === '/api/cookie') {
        const cookie = normalizeCookieInput(JSON.parse((await readBody(req)) || '{}').cookie);
        if (!cookie) return send(res, 400, { error: 'Nothing to connect: paste the cookie text first.' });
        if (!cookieLooksRight(cookie)) {
          return send(res, 400, { error: "That doesn't look like the WikiMasters login cookie. It should contain something like sb-...-auth-token. Use Copy as cURL (bash) on a request to wiki-masters.com while logged in, then paste the whole thing." });
        }
        const t = await Session.test(cookie);
        if (!t.ok) {
          return send(res, 400, { error: `WikiMasters did not accept that cookie (HTTP ${t.status}). Log in again in a private window and copy it fresh.` });
        }
        session.replaceCookie(cookie);
        onConnected?.();
        log(`connected from the dashboard (balance ${t.balance})`);
        return send(res, 200, { ok: true, balance: t.balance });
      }

      if (req.method === 'POST' && url.pathname === '/api/pause') {
        control.paused = Boolean(JSON.parse((await readBody(req)) || '{}').paused);
        log(control.paused ? 'PAUSED from the dashboard: no bids, packs or recycling' : 'RESUMED from the dashboard');
        return send(res, 200, { paused: control.paused });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });
  server.on('error', (e) => log(`dashboard could not start: ${e.message}`));
  server.listen(port, '127.0.0.1', () => log(`dashboard: http://localhost:${port}`));
}
