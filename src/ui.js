import http from 'node:http';
import fs from 'node:fs';
import { CONFIG_PATH, loadConfig, validate } from './config.js';

const PAGE = new URL('./ui.html', import.meta.url);

/** Local-only dashboard. Listens on 127.0.0.1 and rejects cross-site requests. */
export function startUI({ port, getState, control, log }) {
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
      if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, fs.readFileSync(CONFIG_PATH, 'utf8'));

      if (req.method === 'PUT' && url.pathname === '/api/config') {
        const next = JSON.parse(await readBody(req));
        const errors = validate(next);
        if (errors.length) return send(res, 400, { errors });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
        loadConfig(); // sanity: the file we just wrote must load
        log('config saved from the dashboard');
        return send(res, 200, { ok: true });
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
