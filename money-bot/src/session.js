import fs from 'node:fs';

const BASE = 'https://www.wiki-masters.com';
export const SESSION_FILE = new URL('../.session.json', import.meta.url);
export const ENV_FILE = new URL('../.env', import.meta.url);
export const PREMIUM_SESSION_FILE = new URL('../.session.premium.json', import.meta.url);
export const PREMIUM_ENV_FILE = new URL('../.env.premium', import.meta.url);
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

function loadJar(sessionFile = SESSION_FILE, envFile = ENV_FILE) {
  // .session.json holds cookies refreshed by the server; prefer it over the original .env value.
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(sessionFile, 'utf8'))));
  } catch {}
  try {
    const m = fs.readFileSync(envFile, 'utf8').match(/^COOKIE=(.*)$/m);
    if (m && m[1].trim()) return parseCookieHeader(m[1].trim());
  } catch {}
  return new Map(); // no login yet: the dashboard's Connect tab asks for it
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
function saveEnv(pairs, envFile = ENV_FILE) {
  let lines = [];
  try {
    lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  } catch {}
  for (const [k, v] of Object.entries(pairs)) {
    const i = lines.findIndex((l) => l.startsWith(k + '='));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(envFile, lines.join('\n') + '\n');
}

/** The site's public Supabase "anon" key ships in its JavaScript; find it so nobody has to. */
export async function discoverAnonKey() {
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

function anonKey(envFile = ENV_FILE) {
  const own = fs.existsSync(envFile)
    ? fs.readFileSync(envFile, 'utf8').match(/^SUPABASE_ANON_KEY=(.*)$/m)?.[1] : null;
  const shared = envFile !== ENV_FILE && fs.existsSync(ENV_FILE)
    ? fs.readFileSync(ENV_FILE, 'utf8').match(/^SUPABASE_ANON_KEY=(.*)$/m)?.[1] : null;
  const key = own || shared;
  if (!key) throw new Error('SUPABASE_ANON_KEY missing (it is fetched automatically on start)');
  return key.trim();
}

const randomLeftSec = () => 300 + Math.random() * 2400; // renew 15-55 min after issue, never at a fixed time

export class Session {
  /** Set to true by the running bot only. */
  static allowRenewal = false;

  /** `jar` given = in-memory session that never touches disk (used to test a pasted cookie). */
  constructor(options = {}) {
    // Preserve the old `new Session(jar)` form used by one-off checks.
    const opts = options instanceof Map ? { jar: options } : options;
    this.sessionFile = opts.sessionFile ?? SESSION_FILE;
    this.envFile = opts.envFile ?? ENV_FILE;
    this.allowRenewal = opts.allowRenewal ?? Session.allowRenewal;
    this.noPersist = Boolean(opts.jar);
    this.jar = opts.jar ?? loadJar(this.sessionFile, this.envFile);
    this.renewWhenLeftSec = randomLeftSec();
    this._waiters = [];
  }

  notifyResponse(details) {
    try { this.onResponse?.(details); }
    catch (error) { (this.onLog ?? console.error)(`response observer failed: ${error.message}`); }
  }

  hasCookie() {
    return this.jar.size > 0;
  }

  /** Make sure the public API key is known (fetched from the site once, then kept in .env). */
  async init() {
    try {
      anonKey(this.envFile);
    } catch {
      saveEnv({ SUPABASE_ANON_KEY: await discoverAnonKey() }, this.envFile);
    }
  }

  /** Check a pasted cookie against the site without saving anything. */
  static async test(cookieStr, options = {}) {
    const t = new Session({ ...options, jar: parseCookieHeader(cookieStr), allowRenewal: false });
    t.renewWhenLeftSec = -Infinity; // a test must never rotate the real refresh token
    const r = await t.request('GET', '/api/wikibidous');
    return {
      ok: r.status === 200 && typeof r.json?.balance === 'number',
      status: r.status,
      balance: r.json?.balance,
      id: t.userId(),
      account: t.username(),
    };
  }

  /** Replace the login (from the dashboard): saved to .env, and the old rotated session is dropped. */
  replaceCookie(cookieStr) {
    saveEnv({ COOKIE: cookieStr }, this.envFile);
    try {
      fs.unlinkSync(this.sessionFile);
    } catch {}
    this.jar = parseCookieHeader(cookieStr);
    this._diskMtime = 0;
    this.renewWhenLeftSec = randomLeftSec();
    this._waiters.splice(0).forEach((f) => f());
  }

  waitForCookie() {
    return new Promise((resolve) => this._waiters.push(resolve));
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

  userId() {
    return this.readAuth()?.user?.id ?? null;
  }

  username() {
    return this.readAuth()?.user?.user_metadata?.username ?? null;
  }

  writeAuth(sess) {
    for (const k of [...this.jar.keys()]) if (k === COOKIE_BASE || k.startsWith(COOKIE_BASE + '.')) this.jar.delete(k);
    const enc = 'base64-' + Buffer.from(JSON.stringify(sess), 'utf8').toString('base64url');
    for (let i = 0; i * CHUNK < enc.length; i++) this.jar.set(`${COOKIE_BASE}.${i}`, enc.slice(i * CHUNK, (i + 1) * CHUNK));
    if (this.noPersist) return;
    fs.writeFileSync(this.sessionFile, JSON.stringify(Object.fromEntries(this.jar)));
    this._diskMtime = fs.statSync(this.sessionFile).mtimeMs;
  }

  /** Pick up tokens rotated by another process sharing .session.json. */
  syncFromDisk() {
    if (this.noPersist) return;
    try {
      const m = fs.statSync(this.sessionFile).mtimeMs;
      if (m > (this._diskMtime ?? 0)) {
        this._diskMtime = m;
        this.jar = new Map(Object.entries(JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'))));
      }
    } catch {}
  }

  /** Renew the access token via Supabase at a randomised point in its lifetime. */
  async ensureFresh(force = false) {
    this.syncFromDisk();
    const sess = this.readAuth();
    if (!sess?.refresh_token) return;
    const left = sess.expires_at - Date.now() / 1000;
    // The site cancels the whole login if a renewal key is used twice, so only ONE program may renew it: the
    // running bot (it sets Session.allowRenewal). Any other script (tools, checks, other agents) only reads
    // the login the bot keeps up to date in .session.json.
    if (!this.allowRenewal && !this.noPersist) {
      if (left <= 0) throw new Error('login expired and only the running bot renews it: start the bot, or reconnect on the Connect tab');
      return;
    }
    if (!force && left > this.renewWhenLeftSec) return;
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: anonKey(this.envFile), 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: sess.refresh_token }),
      });
      const j = await res.json().catch(() => ({}));
      this.notifyResponse({ method: 'POST', path: '/auth/v1/token', status: res.status,
        json: j, text: JSON.stringify(j), service: 'auth' });
      if (!res.ok || !j.access_token) {
        // A 5xx (e.g. 525) is the auth server having a moment, not a bad login: keep using the current token
        // while it is still valid and try again in a minute.
        if (res.status >= 500 && left > 90) {
          this.renewWhenLeftSec = Math.max(60, left - 60);
          (this.onLog ?? console.log)(`session refresh hit a server error (HTTP ${res.status}); still valid for ${Math.round(left / 60)} min, retrying in ~1 min`);
          return;
        }
        // Refused: maybe another program renewed first and saved the new login. Use it if so.
        const usedKey = sess.refresh_token;
        this._diskMtime = 0;
        this.syncFromDisk();
        const now = this.readAuth();
        if (now?.refresh_token && now.refresh_token !== usedKey && now.expires_at - Date.now() / 1000 > 60) {
          (this.onLog ?? console.log)('session refresh was refused but a newer login was already saved; using it');
          return;
        }
        const reason = j.error_description || j.msg || j.error || j.error_code || '';
        throw new Error(`token refresh failed (HTTP ${res.status}${reason ? ': ' + reason : ''}). Paste a fresh cookie on the dashboard's Connect tab.`);
      }
      this.writeAuth(j);
      this.renewWhenLeftSec = randomLeftSec();
      const msg = `session refreshed (had ${Math.round(left / 60)} min left), valid for ${Math.round(j.expires_in / 60)} min, next renewal ~${Math.round((j.expires_in - this.renewWhenLeftSec) / 60)} min from now`;
      (this.onLog ?? ((m) => console.log(new Date().toISOString().slice(11, 23), m)))(msg);
    })().finally(() => (this._refreshing = null));
    return this._refreshing;
  }

  /** Call a Supabase RPC as the logged-in user. */
  rpc(name, body = {}) {
    return this.supabase('POST', `rpc/${name}`, body);
  }

  /** Call Supabase's REST API (tables and RPCs) as the logged-in user, the same way the site's own page does. */
  async supabase(method, path, body) {
    await this.ensureFresh();
    const sess = this.readAuth();
    const res = await fetch(`${SUPABASE}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: anonKey(this.envFile),
        authorization: `Bearer ${sess?.access_token}`,
        'content-type': 'application/json',
        'content-profile': 'public',
        'x-client-info': 'supabase-ssr/0.9.0 createBrowserClient',
        origin: BASE,
        referer: BASE + '/',
        'user-agent': UA,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    const response = { status: res.status, json, text };
    this.notifyResponse({ ...response, method, path: `/rest/v1/${path}`, service: 'supabase' });
    return response;
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
    if (!this.noPersist) fs.writeFileSync(this.sessionFile, JSON.stringify(Object.fromEntries(this.jar)));
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
    const response = { status: res.status, json: body, text, date: res.headers.get('date'), t0, t1, location: res.headers.get('location') };
    this.notifyResponse({ ...response, method, path, service: 'site' });
    return response;
  }
}
