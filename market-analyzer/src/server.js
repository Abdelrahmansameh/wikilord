import http from 'node:http';
import fs from 'node:fs';
import { Session, normalizeCookieInput, cookieLooksRight } from './http.js';

const UI = new URL('./ui.html', import.meta.url);

export function startServer({ cfg, analysis, collector, pool, log }) {
  const routes = {
    'GET /api/status': () => {
      const stats = analysis.status();
      return {
        account: pool.accounts[0].session.username(),
        hasCookie: pool.activeCount > 0,
        accounts: pool.status(),
        collector: collector.status(),
        db: stats.db,
        ingestion: stats.ingestion,
        analysis: { updatedAt: stats.updatedAt, pending: stats.pending, error: stats.error },
        config: { maxRps: cfg.maxRps, pollMs: cfg.pollMs, recentPollMs: cfg.recentPollMs,
          scoutPollMs: cfg.scoutPollMs, scoutRecentPollMs: cfg.scoutRecentPollMs, scoutHeadPollMs: cfg.scoutHeadPollMs,
          coverSec: cfg.coverSec, keepRaw: cfg.keepRaw },
      };
    },
    'GET /api/overview': (q, _body, call) => call('overview', q),
    'GET /api/turnover': (q, _body, call) => call('turnover', q),
    'GET /api/auction-appearances': (q, _body, call) => call('auctionAppearances', q),
    'GET /api/prices': async (q, _body, call) => {
      const [groups, start] = await Promise.all([call('prices', q), call('startingPrice', q)]);
      return { groups, start };
    },
    'GET /api/scatter': (q, _body, call) => call('scatter', q),
    'GET /api/category-groups': (q, _body, call) => call('categoryGroups', q),
    'GET /api/category-detail': (q, _body, call) => call('categoryDetail', q),
    'GET /api/timing': (q, _body, call) => call('timing', q),
    'GET /api/players': (q, _body, call) => call('players', q),
    'GET /api/auctions': (q, _body, call) => call('auctions', q),
    'GET /api/auction': async (q, _body, call) => (await call('auction', q.id)) ?? { error: 'not found' },
    'GET /api/cards': (q, _body, call) => call('cards', q.q),
    'GET /api/card-rankings': (q, _body, call) => call('cardRankings', q.sort),
    'GET /api/card': async (q, _body, call) => (await call('card', q.id, q.page)) ?? { error: 'card not found' },
    'GET /api/raw': async (q, _body, call) => (await call('raw', q.id)) ?? { error: 'no raw copy stored' },
    'GET /api/comparable': (q, _body, call) => call('comparable', { rarity: q.rarity, shiny: q.shiny, q_score: q.q_score, band: Number(q.band) || 5, days: Number(q.days) || 30 }),
    'GET /api/users': (q, _body, call) => call('users', q.q ?? ''),
    'POST /api/cookie': async (_q, body) => {
      const slot = body?.slot ?? 'primary';
      if (!['primary', 'secondary', 'tertiary'].includes(slot)) return { ok: false, error: 'Unknown account slot.' };
      const cookie = normalizeCookieInput(body?.cookie);
      if (!cookieLooksRight(cookie)) return { ok: false, error: "That doesn't look like a wiki-masters cookie (no sb-…-auth-token in it)." };
      const t = await Session.test(cookie);
      if (!t.ok) return { ok: false, error: `The site rejected that cookie (HTTP ${t.status}). Copy a fresh one.` };
      if (!t.id) return { ok: false, error: 'Could not identify the account in this cookie.' };
      if (pool.accounts.some((a) => a.slot !== slot && a.session.userId() === t.id))
        return { ok: false, error: 'Each slot needs a different player account.' };
      const session = pool.accounts.find((a) => a.slot === slot).session;
      session.replaceCookie(cookie);
      collector.resume(slot);
      log(`new cookie saved for ${slot}: ${session.username() ?? 'unknown user'}`);
      return { ok: true, slot, account: session.username() };
    },
  };

  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const call = (method, ...args) => analysis.callWithSignal(method, args, controller.signal);
    const url = new URL(req.url, 'http://localhost');
    const send = (code, data, type = 'application/json') => {
      if (res.destroyed) return;
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    };
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html'))
        return send(200, fs.readFileSync(UI), 'text/html; charset=utf-8');
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(404, { error: 'not found' });
      let body;
      if (req.method === 'POST') {
        let s = '';
        for await (const chunk of req) s += chunk;
        body = s ? JSON.parse(s) : {};
      }
      send(200, await route(Object.fromEntries(url.searchParams), body, call));
    } catch (e) {
      if (controller.signal.aborted) return;
      log(`dashboard error on ${url.pathname}: ${e.message}`);
      send(500, { error: e.message });
    }
  });
  // Local only: the dashboard can replace the login cookie.
  server.listen(cfg.port, '127.0.0.1', () => log(`dashboard: http://localhost:${cfg.port}`));
  return server;
}
