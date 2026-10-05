// Login session for the market collector. Adapted from the trading bot's src/http.js but self-contained:
// its own .env and .session.json inside market-analyzer/, so the two bots never share a token.
import fs from 'node:fs';
import { ROOT } from './config.js';
import { withDeadline } from './deadline.js';

const BASE = 'https://www.wiki-masters.com';
const ENV_FILE = new URL('.env', ROOT);
const accountFiles = (slot) => {
  if (!['primary', 'secondary', 'tertiary'].includes(slot)) throw new Error('unknown account slot');
  return slot === 'primary'
    ? { env: ENV_FILE, session: new URL('.session.json', ROOT) }
    : { env: new URL(`.env.${slot}`, ROOT), session: new URL(`.session.${slot}.json`, ROOT) };
};
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const SUPABASE = 'https://cyrxjeppjqsxxjayfrur.supabase.co';
const COOKIE_BASE = 'sb-cyrxjeppjqsxxjayfrur-auth-token';
const CHUNK = 3180;

function parseCookieHeader(str) {
  const jar = new Map();
  for (const part of str.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return jar;
}

function readEnv(key, file = ENV_FILE) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m?.[1].trim() || null;
  } catch {
    return null;
  }
}

function loadJar(files) {
  // .session.json holds cookies refreshed by the server; prefer it over the original .env value.
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(files.session, 'utf8'))));
  } catch {}
  const c = readEnv('COOKIE', files.env);
  return c ? parseCookieHeader(c) : new Map();
}

/**
 * Accept what people actually paste: a bare cookie value, "cookie: ...", a whole
 * DevTools "Copy as cURL (bash)" command, or a block of copied request headers.
 */
export function normalizeCookieInput(input) {
  let s = String(input ?? '').trim();
  const curl =
    s.match(/(?:-H|--header)\s+\$?(['"])\s*cookie:\s*([\s\S]*?)\1/i) || s.match(/(?:\s-b|--cookie)\s+\$?(['"])([\s\S]*?)\1/i);
  if (curl) s = curl[2];
  else if (/[\r\n]/.test(s)) {
    const line = s.match(/^\s*cookie:\s*(.+)$/im);
    if (line) s = line[1];
  }
  return s
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^cookie:\s*/i, '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}

export const cookieLooksRight = (str) => /sb-[a-z0-9]+-auth-token/i.test(str);

/** Set KEY=value in .env, keeping every other line. */
function saveEnv(pairs, file = ENV_FILE) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  } catch {}
  for (const [k, v] of Object.entries(pairs)) {
    const i = lines.findIndex((l) => l.startsWith(k + '='));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

/** The site's public Supabase "anon" key ships in its JavaScript; find it so nobody has to. */
async function discoverAnonKey() {
  const get = (p) => fetch(BASE + p, { headers: { 'user-agent': UA } }).then((r) => r.text());
  const html = await get('/login');
  const srcs = [...new Set([...html.matchAll(/\/_next\/static\/[^"' <>]+\.js[^"' <>]*/g)].map((m) => m[0]))];
  for (const p of srcs) {
    const js = await get(p).catch(() => '');
    for (const m of js.matchAll(/eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g)) {
      try {
        const payload = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString('utf8'));
        if (payload.role === 'anon' && payload.iss === 'supabase') return m[0];
      } catch {}
    }
  }
  throw new Error('could not find the site API key automatically');
}

const randomLeftSec = () => 300 + Math.random() * 2400; // renew 15-55 min after issue, never at a fixed time

export class Session {
  /** `jar` given = in-memory session that never touches disk (used to test a pasted cookie). */
  constructor(jar, slot = 'primary') {
    this.slot = slot;
    this.files = accountFiles(slot);
    this.noPersist = Boolean(jar);
    this.jar = jar ?? loadJar(this.files);
    this.renewWhenLeftSec = randomLeftSec();
    this.onLog = null;
  }

  hasCookie() {
    return this.jar.size > 0;
  }

  /** Make sure the public API key is known (fetched from the site once, then kept in .env). */
  async init() {
    if (!readEnv('SUPABASE_ANON_KEY')) saveEnv({ SUPABASE_ANON_KEY: await discoverAnonKey() });
  }

  /** Check a pasted cookie against the site without saving anything. */
  static async test(cookieStr) {
    const t = new Session(parseCookieHeader(cookieStr));
    t.renewWhenLeftSec = -Infinity; // a test must never rotate the real refresh token
    const r = await t.request('GET', '/api/wikibidous');
    return { ok: r.status === 200 && typeof r.json?.balance === 'number', status: r.status, id: t.userId(), account: t.username() };
  }

  /** Replace the login (from the dashboard): saved to .env, and the old rotated session is dropped. */
  replaceCookie(cookieStr) {
    saveEnv({ COOKIE: cookieStr }, this.files.env);
    try {
      fs.unlinkSync(this.files.session);
    } catch {}
    this.jar = parseCookieHeader(cookieStr);
    this.renewWhenLeftSec = randomLeftSec();
    this.refreshWarning = null;
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
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
  }

  /** Username of the logged-in account, for the dashboard. */
  username() {
    const a = this.readAuth();
    return a?.user?.user_metadata?.username ?? null;
  }

  userId() {
    return this.readAuth()?.user?.id ?? null;
  }

  writeAuth(sess) {
    for (const k of [...this.jar.keys()]) if (k === COOKIE_BASE || k.startsWith(COOKIE_BASE + '.')) this.jar.delete(k);
    const enc = 'base64-' + Buffer.from(JSON.stringify(sess), 'utf8').toString('base64url');
    for (let i = 0; i * CHUNK < enc.length; i++) this.jar.set(`${COOKIE_BASE}.${i}`, enc.slice(i * CHUNK, (i + 1) * CHUNK));
    this.persist();
  }

  persist() {
    if (!this.noPersist) fs.writeFileSync(this.files.session, JSON.stringify(Object.fromEntries(this.jar)));
  }

  /** Renew the access token via Supabase at a randomised point in its lifetime. */
  async ensureFresh() {
    const sess = this.readAuth();
    if (!sess?.refresh_token) return;
    const left = sess.expires_at - Date.now() / 1000;
    if (left > this.renewWhenLeftSec) return;
    if (this._refreshing) return this._refreshing;
    const log = this.onLog ?? console.log;
    this._refreshing = withDeadline(async (signal) => {
      const apikey = readEnv('SUPABASE_ANON_KEY');
      if (!apikey) throw new Error('SUPABASE_ANON_KEY missing (it is fetched automatically on start)');
      const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: sess.refresh_token }),
        signal,
      });
      const j = await res.json().catch(() => ({}));
      signal.throwIfAborted();
      if (!res.ok || !j.access_token) {
        // A 5xx is the auth server having a moment, not a bad login: keep the current token while it lasts.
        if (res.status >= 500 && left > 90) {
          this.renewWhenLeftSec = Math.max(60, left - 60);
          log(`session refresh hit a server error (HTTP ${res.status}); retrying in ~1 min`);
          return;
        }
        // A rotated refresh token can fail while the existing access token still works.
        // Use that token until shortly before expiry, and keep collection alive in the meantime.
        if (left > 90) {
          this.renewWhenLeftSec = 60;
          this.refreshWarning = `refresh failed (HTTP ${res.status}); paste a fresh cookie before ${new Date(sess.expires_at * 1000).toLocaleTimeString()}`;
          log(this.refreshWarning);
          return;
        }
        throw Object.assign(new Error(`token refresh failed (HTTP ${res.status}). Paste a fresh cookie on the dashboard.`), {
          needsLogin: true,
        });
      }
      this.writeAuth(j);
      this.refreshWarning = null;
      this.renewWhenLeftSec = randomLeftSec();
      log(`session refreshed, valid for ${Math.round(j.expires_in / 60)} min`);
    }, 15_000, { label: `${this.slot} session refresh` }).finally(() => (this._refreshing = null));
    return this._refreshing;
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
    this.persist();
  }

  /** GET/POST against the site. Returns { status, json, text, location }. */
  async request(method, path, { timeoutMs = 15000, signal } = {}) {
    return withDeadline((requestSignal) => this._request(method, path, requestSignal),
      timeoutMs, { signal, label: `${this.slot} ${path}` });
  }

  async _request(method, path, signal) {
    await this.ensureFresh();
    signal.throwIfAborted();
    const headers = {
      'user-agent': UA,
      accept: '*/*',
      'accept-language': 'fr-CA,fr;q=0.9,en;q=0.8',
      'cache-control': 'no-cache',
      referer: `${BASE}/marketplace`,
    };
    if (this.jar.size) headers.cookie = this.cookieHeader();
    const res = await fetch(BASE + path, { method, headers, redirect: 'manual', signal });
    const text = await res.text();
    // A late response from an expired attempt must not replace the current cookies.
    signal.throwIfAborted();
    this.absorb(res);
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, location: res.headers.get('location') };
  }
}
