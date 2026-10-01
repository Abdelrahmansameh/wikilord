import fs from 'node:fs';

/**
 * Targets: specific cards you want, each with a priority and its own max bid, grouped in themes that can have a
 * weekly budget. Kept in targets.json and edited from the dashboard (Targets tab) or with `npm run agent`.
 * The bot works the same without it: no file = no targets.
 *
 * limits.json holds hard limits that apply to every bid, whoever set the rules or targets. It is meant to be
 * edited only by you, by hand (the agent is not allowed to change it).
 */
export const TARGETS_PATH = new URL('../targets.json', import.meta.url);
export const LIMITS_PATH = new URL('../limits.json', import.meta.url);
export const JOURNAL_PATH = new URL('../journal.jsonl', import.meta.url);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THEME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RARITIES = new Set(['C', 'PC', 'R', 'SR', 'UR', 'L']);
export const LIMIT_KEYS = {
  maxBidPerCard: 'never bid more than this on one card',
  maxDailySpend: 'total won + held per day (UTC)',
  maxWeeklySpend: 'total won + held over the last 7 days',
  minReserve: 'balance always kept (the higher of this and global.reserveBalance applies)',
  maxThemeBudget: 'highest weekly budget a theme may be given',
};

export const emptyTargets = () => ({ themes: {}, targets: [] });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Human-readable problems with a targets file (empty = valid). */
export function validateTargets(d) {
  const e = [];
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['targets.json must be a JSON object'];
  if (typeof d.themes !== 'object' || !d.themes || Array.isArray(d.themes)) e.push('themes must be an object');
  else
    for (const [name, t] of Object.entries(d.themes)) {
      if (!THEME.test(name)) e.push(`theme "${name}": names are lower-case letters, digits and dashes (e.g. "jeux-video")`);
      if (t.weeklyBudget != null && (!isNum(t.weeklyBudget) || t.weeklyBudget < 0)) e.push(`theme "${name}": weeklyBudget must be a number or null`);
      if (t.enabled !== undefined && typeof t.enabled !== 'boolean') e.push(`theme "${name}": enabled must be true or false`);
    }
  if (!Array.isArray(d.targets)) return [...e, 'targets must be a list'];
  const seen = new Set();
  d.targets.forEach((t, i) => {
    const w = `targets[${i}]${t?.title ? ` (${t.title})` : ''}`;
    if (!UUID.test(t?.cardId ?? '')) e.push(`${w}: cardId must be a card id`);
    else if (seen.has(t.cardId)) e.push(`${w}: this card is listed twice`);
    seen.add(t?.cardId);
    if (typeof t?.title !== 'string' || !t.title) e.push(`${w}: needs a title`);
    if (t?.rarity !== undefined && !RARITIES.has(t.rarity)) e.push(`${w}: rarity must be one of ${[...RARITIES].join(', ')}`);
    if (![1, 2, 3].includes(t?.priority)) e.push(`${w}: priority must be 1 (high), 2 or 3 (low)`);
    if (!isNum(t?.maxBid) || t.maxBid < 1) e.push(`${w}: maxBid must be a number of at least 1`);
    if (t?.theme != null && !d.themes?.[t.theme]) e.push(`${w}: theme "${t.theme}" does not exist`);
    if (t?.expires != null && Number.isNaN(Date.parse(t.expires))) e.push(`${w}: expires must be a date like 2026-10-15`);
    if (t?.enabled !== undefined && typeof t.enabled !== 'boolean') e.push(`${w}: enabled must be true or false`);
    if (t?.counters !== undefined && (!isNum(t.counters) || t.counters < 0)) e.push(`${w}: counters must be a number`);
  });
  return e;
}

export function readTargets(path = TARGETS_PATH) {
  if (!fs.existsSync(path)) return emptyTargets();
  let d;
  try {
    d = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`targets.json is not valid JSON: ${err.message}`);
  }
  const problems = validateTargets(d);
  if (problems.length) throw new Error(`targets.json has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  return d;
}

/** Validate, then replace the file in one step (write a temp file and rename it) so a reader never sees half a file. */
export function writeTargets(d, path = TARGETS_PATH) {
  const problems = validateTargets(d);
  if (problems.length) throw new Error(problems.join('; '));
  const tmp = new URL(`${path.href}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, path);
}

export function readLimits(path = LIMITS_PATH) {
  if (!fs.existsSync(path)) return {};
  let l;
  try {
    l = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`limits.json is not valid JSON: ${err.message}`);
  }
  const out = {};
  for (const [k, v] of Object.entries(l)) {
    if (k.startsWith('_')) continue; // comments
    if (!(k in LIMIT_KEYS)) throw new Error(`limits.json: unknown limit "${k}" (allowed: ${Object.keys(LIMIT_KEYS).join(', ')})`);
    if (v !== null && (!isNum(v) || v < 0)) throw new Error(`limits.json: ${k} must be a number or null`);
    if (v !== null) out[k] = v;
  }
  return out;
}

/** Targets the bot should act on now (enabled, not expired, theme on), by card id. maxBid is capped by the limits. */
export function activeTargets(d, limits = {}, now = Date.now()) {
  const m = new Map();
  for (const t of d.targets) {
    if (t.enabled === false) continue;
    if (t.expires && Date.parse(t.expires) < now) continue;
    if (t.theme && d.themes[t.theme]?.enabled === false) continue;
    const maxBid = limits.maxBidPerCard != null ? Math.min(t.maxBid, limits.maxBidPerCard) : t.maxBid;
    m.set(t.cardId, { ...t, maxBid });
  }
  return m;
}

export function targetStatus(t, d, now = Date.now()) {
  if (t.enabled === false) return 'off';
  if (t.expires && Date.parse(t.expires) < now) return 'expired';
  if (t.theme && d.themes[t.theme]?.enabled === false) return 'theme off';
  return 'active';
}

const clean = (s) => (typeof s === 'string' ? s.trim().slice(0, 300) : undefined);

/**
 * Apply one change to the targets data (in place). Ops:
 *   { op: 'add', cardId, title, rarity?, theme?, priority, maxBid, reason?, expires? }   (adds or updates)
 *   { op: 'update', cardId, ...any of priority, maxBid, theme, reason, expires, enabled, counters }
 *   { op: 'remove', cardId }
 *   { op: 'theme', name, weeklyBudget?, enabled?, note? }                              (adds or updates)
 *   { op: 'removeTheme', name, withTargets? }
 * Refuses values above the hard limits. Returns a short description of what changed.
 */
export function applyOp(d, op, { limits = {}, by = 'you' } = {}) {
  const now = new Date().toISOString();
  const overLimit = (maxBid) =>
    limits.maxBidPerCard != null && maxBid > limits.maxBidPerCard ? `max bid ${maxBid} is above the hard limit maxBidPerCard ${limits.maxBidPerCard} (limits.json)` : null;
  const ensureTheme = (name) => {
    if (name == null) return;
    if (!THEME.test(name)) throw new Error(`theme "${name}": use lower-case letters, digits and dashes (e.g. "jeux-video")`);
    d.themes[name] ??= { weeklyBudget: null, enabled: true, createdAt: now };
  };
  switch (op.op) {
    case 'add': {
      if (!UUID.test(op.cardId ?? '')) throw new Error('add: needs a card id');
      const maxBid = Number(op.maxBid);
      const priority = Number(op.priority ?? 2);
      const bad = overLimit(maxBid);
      if (bad) throw new Error(bad);
      ensureTheme(op.theme);
      const prev = d.targets.find((t) => t.cardId === op.cardId);
      const t = {
        ...(prev ?? {}),
        cardId: op.cardId,
        title: op.title ?? prev?.title,
        ...(op.rarity ?? prev?.rarity ? { rarity: op.rarity ?? prev?.rarity } : {}),
        theme: op.theme ?? prev?.theme ?? null,
        priority,
        maxBid,
        reason: clean(op.reason) ?? prev?.reason ?? '',
        addedBy: prev?.addedBy ?? by,
        addedAt: prev?.addedAt ?? now,
        updatedAt: now,
      };
      if (op.expires !== undefined) t.expires = op.expires || undefined;
      if (prev) Object.assign(prev, t);
      else d.targets.push(t);
      return `${prev ? 'updated' : 'added'} target ${t.title} [${t.rarity ?? '?'}] p${priority} max ${maxBid}${t.theme ? ` in ${t.theme}` : ''}`;
    }
    case 'update': {
      const t = d.targets.find((x) => x.cardId === op.cardId);
      if (!t) throw new Error(`update: ${op.cardId} is not a target`);
      const changes = [];
      if (op.maxBid !== undefined) {
        const bad = overLimit(Number(op.maxBid));
        if (bad) throw new Error(bad);
        t.maxBid = Number(op.maxBid);
        changes.push(`max ${t.maxBid}`);
      }
      if (op.priority !== undefined) (t.priority = Number(op.priority)), changes.push(`p${t.priority}`);
      if (op.theme !== undefined) (ensureTheme(op.theme), (t.theme = op.theme)), changes.push(`theme ${op.theme}`);
      if (op.reason !== undefined) t.reason = clean(op.reason) ?? '';
      if (op.expires !== undefined) (t.expires = op.expires || undefined), changes.push(`expires ${op.expires || 'never'}`);
      if (op.enabled !== undefined) (t.enabled = Boolean(op.enabled)), changes.push(t.enabled ? 'on' : 'off');
      if (op.counters !== undefined) (t.counters = op.counters === null ? undefined : Number(op.counters)), changes.push(`counters ${op.counters}`);
      t.updatedAt = now;
      return `updated target ${t.title}: ${changes.join(', ') || 'reason'}`;
    }
    case 'remove': {
      const i = d.targets.findIndex((x) => x.cardId === op.cardId);
      if (i < 0) throw new Error(`remove: ${op.cardId} is not a target`);
      const [t] = d.targets.splice(i, 1);
      return `removed target ${t.title}`;
    }
    case 'theme': {
      ensureTheme(op.name);
      const th = d.themes[op.name];
      if (op.weeklyBudget !== undefined) {
        const b = op.weeklyBudget === null || op.weeklyBudget === '' ? null : Number(op.weeklyBudget);
        if (b != null && limits.maxThemeBudget != null && b > limits.maxThemeBudget) throw new Error(`budget ${b} is above the hard limit maxThemeBudget ${limits.maxThemeBudget} (limits.json)`);
        th.weeklyBudget = b;
      }
      if (op.enabled !== undefined) th.enabled = Boolean(op.enabled);
      if (op.note !== undefined) th.note = clean(op.note) ?? '';
      th.updatedAt = now;
      return `theme ${op.name}: budget ${th.weeklyBudget ?? 'none'}/week, ${th.enabled === false ? 'off' : 'on'}`;
    }
    case 'removeTheme': {
      if (!d.themes[op.name]) throw new Error(`theme "${op.name}" does not exist`);
      const inTheme = d.targets.filter((t) => t.theme === op.name);
      if (inTheme.length && !op.withTargets) throw new Error(`theme "${op.name}" still has ${inTheme.length} target(s): remove them first, or remove the theme with its targets`);
      d.targets = d.targets.filter((t) => t.theme !== op.name);
      delete d.themes[op.name];
      return `removed theme ${op.name}${inTheme.length ? ` and its ${inTheme.length} target(s)` : ''}`;
    }
    default:
      throw new Error(`unknown op "${op.op}"`);
  }
}

/** Read targets.json, apply the ops, write it back, and record each change in the journal. */
export function changeTargets(ops, { by = 'you', reason } = {}) {
  const d = readTargets();
  const limits = readLimits();
  const done = ops.map((op) => applyOp(d, op, { limits, by }));
  writeTargets(d);
  for (const [i, what] of done.entries()) journal({ by, type: 'change', text: what, reason: ops[i].reason ?? reason });
  return done;
}

export function journal(entry) {
  try {
    fs.appendFileSync(JOURNAL_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

/** Newest first. */
export function readJournal(limit = 50) {
  try {
    return fs
      .readFileSync(JOURNAL_PATH, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Live copy for the bot: re-reads targets.json and limits.json when they change (checked every few seconds).
 * A broken file keeps the previous good copy and is reported in the log.
 */
export function watchTargets(log) {
  let data = emptyTargets();
  let limits = {};
  const mtimes = { t: -1, l: -1 };
  const mtime = (p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0);
  const check = (first = false) => {
    const t = mtime(TARGETS_PATH);
    if (t !== mtimes.t) {
      mtimes.t = t;
      try {
        data = readTargets();
        if (!first || data.targets.length) log(`targets ${first ? 'loaded' : 'reloaded'}: ${data.targets.length} target(s) in ${Object.keys(data.themes).length} theme(s)`);
      } catch (e) {
        log(`targets change IGNORED (previous targets still active): ${e.message}`);
      }
    }
    const l = mtime(LIMITS_PATH);
    if (l !== mtimes.l) {
      mtimes.l = l;
      try {
        limits = readLimits();
        if (Object.keys(limits).length) log(`hard limits: ${Object.entries(limits).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      } catch (e) {
        log(`limits change IGNORED (previous limits still active): ${e.message}`);
      }
    }
  };
  check(true);
  setInterval(check, 3000).unref?.();
  return {
    data: () => data,
    limits: () => limits,
    reload: () => check(),
    active: () => activeTargets(data, limits),
    isTarget: (cardId) => data.targets.some((t) => t.cardId === cardId),
  };
}
