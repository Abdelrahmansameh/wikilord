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
          coverSec: cfg.coverSec, keepRaw: cfg.keepRaw },
      };
    },
    'GET /api/overview': (q) => analysis.call('overview', q),
    'GET /api/turnover': (q) => analysis.call('turnover', q),
    'GET /api/prices': async (q) => {
      const [groups, start] = await Promise.all([analysis.call('prices', q), analysis.call('startingPrice', q)]);
      return { groups, start };
    },
    'GET /api/scatter': (q) => analysis.call('scatter', q),
    'GET /api/category-groups': (q) => analysis.call('categoryGroups', q),
    'GET /api/category-detail': (q) => analysis.call('categoryDetail', q),
    'GET /api/timing': (q) => analysis.call('timing', q),
    'GET /api/players': (q) => analysis.call('players', q),
    'GET /api/auctions': (q) => analysis.call('auctions', q),
    'GET /api/auction': async (q) => (await analysis.call('auction', q.id)) ?? { error: 'not found' },
    'GET /api/cards': (q) => analysis.call('cards', q.q),
    'GET /api/card': async (q) => (await analysis.call('card', q.id, q.page)) ?? { error: 'card not found' },
    'GET /api/raw': async (q) => (await analysis.call('raw', q.id)) ?? { error: 'no raw copy stored' },
    'GET /api/comparable': (q) => analysis.call('comparable', { rarity: q.rarity, shiny: q.shiny, q_score: q.q_score, band: Number(q.band) || 5, days: Number(q.days) || 30 }),
    'GET /api/users': (q) => analysis.call('users', q.q ?? ''),
    'POST /api/cookie': async (_q, body) => {
      const slot = body?.slot ?? 'primary';
      if (slot !== 'primary' && slot !== 'secondary') return { ok: false, error: 'Unknown account slot.' };
      const cookie = normalizeCookieInput(body?.cookie);
      if (!cookieLooksRight(cookie)) return { ok: false, error: "That doesn't look like a wiki-masters cookie (no sb-…-auth-token in it)." };
      const t = await Session.test(cookie);
      if (!t.ok) return { ok: false, error: `The site rejected that cookie (HTTP ${t.status}). Copy a fresh one.` };
      const other = pool.accounts.find((a) => a.slot !== slot).session;
      if (!t.id) return { ok: false, error: 'Could not identify the account in this cookie.' };
      if (t.id === other.userId()) return { ok: false, error: 'Both slots need different player accounts.' };
      const session = pool.accounts.find((a) => a.slot === slot).session;
      session.replaceCookie(cookie);
      collector.resume(slot);
      log(`new cookie saved for ${slot}: ${session.username() ?? 'unknown user'}`);
      return { ok: true, slot, account: session.username() };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, data, type = 'application/json') => {
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
      send(200, await route(Object.fromEntries(url.searchParams), body));
    } catch (e) {
      log(`dashboard error on ${url.pathname}: ${e.message}`);
      send(500, { error: e.message });
    }
  });
  // Local only: the dashboard can replace the login cookie.
  server.listen(cfg.port, '127.0.0.1', () => log(`dashboard: http://localhost:${cfg.port}`));
  return server;
}
