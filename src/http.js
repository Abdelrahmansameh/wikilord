import fs from 'node:fs';

const BASE = 'https://www.wiki-masters.com';
const SESSION_FILE = new URL('../.session.json', import.meta.url);
const ENV_FILE = new URL('../.env', import.meta.url);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function parseCookieHeader(str) {
  const jar = new Map();
  for (const part of str.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return jar;
}

function loadJar() {
  // .session.json holds cookies refreshed by the server; prefer it over the original .env value.
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))));
  } catch {}
  try {
    const m = fs.readFileSync(ENV_FILE, 'utf8').match(/^COOKIE=(.*)$/m);
    if (m && m[1].trim()) return parseCookieHeader(m[1].trim());
  } catch {}
  throw new Error('No session. Create .env with COOKIE=<cookie header> (see .env.example).');
}

const SUPABASE = 'https://cyrxjeppjqsxxjayfrur.supabase.co';
const COOKIE_BASE = 'sb-cyrxjeppjqsxxjayfrur-auth-token';
const CHUNK = 3180;

function anonKey() {
  const m = fs.readFileSync(ENV_FILE, 'utf8').match(/^SUPABASE_ANON_KEY=(.*)$/m);
  if (!m) throw new Error('SUPABASE_ANON_KEY missing in .env');
  return m[1].trim();
}

const randomLeftSec = () => 300 + Math.random() * 2400; // renew 15-55 min after issue, never at a fixed time

export class Session {
  constructor() {
    this.jar = loadJar();
    this.renewWhenLeftSec = randomLeftSec();
  }

  /** Reassemble the Supabase session object stored across the chunked auth cookie. */
  readAuth() {
    let raw = this.jar.get(COOKIE_BASE);
    if (raw === undefined) {
      raw = '';
      for (let i = 0; this.jar.has(`${COOKIE_BASE}.${i}`); i++) raw += this.jar.get(`${COOKIE_BASE}.${i}`);
    }
    if (!raw) return null;
    try {
      if (raw.startsWith('base64-')) raw = Buffer.from(raw.slice(7), 'base64url').toString('utf8');
      return JSON.parse(decodeURIComponent(raw));
    } catch {
      try { return JSON.parse(raw); } catch { return null; }
    }
  }

  writeAuth(sess) {
    for (const k of [...this.jar.keys()]) if (k === COOKIE_BASE || k.startsWith(COOKIE_BASE + '.')) this.jar.delete(k);
    const enc = 'base64-' + Buffer.from(JSON.stringify(sess), 'utf8').toString('base64url');
    for (let i = 0; i * CHUNK < enc.length; i++) this.jar.set(`${COOKIE_BASE}.${i}`, enc.slice(i * CHUNK, (i + 1) * CHUNK));
    fs.writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(this.jar)));
    this._diskMtime = fs.statSync(SESSION_FILE).mtimeMs;
  }

  /** Pick up tokens rotated by another process sharing .session.json. */
  syncFromDisk() {
    try {
      const m = fs.statSync(SESSION_FILE).mtimeMs;
      if (m > (this._diskMtime ?? 0)) {
        this._diskMtime = m;
        this.jar = new Map(Object.entries(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))));
      }
    } catch {}
  }

  /** Renew the access token via Supabase at a randomised point in its lifetime. */
  async ensureFresh(force = false) {
    this.syncFromDisk();
    const sess = this.readAuth();
    if (!sess?.refresh_token) return;
    const left = sess.expires_at - Date.now() / 1000;
    if (!force && left > this.renewWhenLeftSec) return;
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: anonKey(), 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: sess.refresh_token }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.access_token) throw new Error(`token refresh failed HTTP ${res.status}: ${JSON.stringify(j).slice(0, 160)}. Copy a fresh cookie into .env and delete .session.json.`);
      this.writeAuth(j);
      this.renewWhenLeftSec = randomLeftSec();
      (this.onLog ?? ((m) => console.log(new Date().toISOString().slice(11, 23), m)))(`session refreshed (had ${Math.round(left / 60)} min left), valid for ${Math.round(j.expires_in / 60)} min, next renewal ~${Math.round((j.expires_in - this.renewWhenLeftSec) / 60)} min from now`);
    })().finally(() => (this._refreshing = null));
    return this._refreshing;
  }

  /** Call a Supabase RPC as the logged-in user. */
  async rpc(name, body = {}) {
    await this.ensureFresh();
    const sess = this.readAuth();
    const res = await fetch(`${SUPABASE}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: anonKey(),
        authorization: `Bearer ${sess?.access_token}`,
        'content-type': 'application/json',
        'content-profile': 'public',
        'x-client-info': 'supabase-ssr/0.9.0 createBrowserClient',
        origin: BASE,
        referer: BASE + '/',
        'user-agent': UA,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    const sc = res.headers.getSetCookie?.() ?? [];
    if (!sc.length) return;
    for (const line of sc) {
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0/i.test(a)) || value === '';
      if (expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(this.jar)));
  }

  /** Returns { status, json, text, date, t0, t1 } with local ms timestamps around the request. */
  async request(method, path, { json, cache = false } = {}) {
    await this.ensureFresh();
    const headers = {
      'user-agent': UA,
      accept: '*/*',
      'accept-language': 'fr-CA,fr;q=0.9,en;q=0.8',
      cookie: this.cookieHeader(),
      referer: `${BASE}/marketplace`,
    };
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      headers.origin = BASE;
    }
    if (!cache) headers['cache-control'] = 'no-cache';
    const t0 = Date.now();
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : undefined,
      redirect: 'manual',
    });
    const text = await res.text();
    const t1 = Date.now();
    this.absorb(res);
    let body;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, json: body, text, date: res.headers.get('date'), t0, t1, location: res.headers.get('location') };
  }
}
