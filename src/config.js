import fs from 'node:fs';

export const CONFIG_PATH = process.env.CONFIG ?? new URL('../config.json', import.meta.url);

const WHEN_KEYS = new Set([
  'wishlist', 'rarity', 'shiny', 'starred', 'tagged',
  'minPageviews', 'maxPageviews', 'minQScore', 'maxQScore',
  'minAtk', 'maxAtk', 'minDef', 'maxDef', 'minPrice', 'maxCurrentPrice',
  'titleRegex', 'categoryRegex',
]);
const RARITIES = new Set(['C', 'PC', 'R', 'SR', 'UR', 'L']);
const TOP_KEYS = new Set(['dryRun', 'myUserId', 'timing', 'global', 'rules', 'packs', 'recycle', 'ui']);

function checkWhen(when, where, errors) {
  if (when === undefined) return;
  if (typeof when !== 'object' || Array.isArray(when)) return void errors.push(`${where}.when must be an object`);
  for (const [k, v] of Object.entries(when)) {
    if (!WHEN_KEYS.has(k)) errors.push(`${where}.when.${k}: unknown condition (allowed: ${[...WHEN_KEYS].join(', ')})`);
    else if (k === 'rarity') {
      if (!Array.isArray(v) || !v.length) errors.push(`${where}.when.rarity must be a list like ["C","PC"]`);
      else for (const r of v) if (!RARITIES.has(String(r).toUpperCase())) errors.push(`${where}.when.rarity: "${r}" is not one of ${[...RARITIES].join(', ')}`);
    } else if (['wishlist', 'shiny', 'starred', 'tagged'].includes(k)) {
      if (typeof v !== 'boolean') errors.push(`${where}.when.${k} must be true or false`);
    } else if (k.endsWith('Regex')) {
      try { new RegExp(v, 'i'); } catch { errors.push(`${where}.when.${k}: invalid regular expression`); }
    } else if (typeof v !== 'number') errors.push(`${where}.when.${k} must be a number`);
  }
}

const isRange = (v) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number') && v[0] <= v[1];

/** Returns a list of human-readable problems (empty = valid). */
export function validate(cfg) {
  const e = [];
  if (typeof cfg !== 'object' || !cfg) return ['config must be a JSON object'];
  for (const k of Object.keys(cfg)) if (!TOP_KEYS.has(k)) e.push(`unknown top-level key "${k}"`);
  if (typeof cfg.myUserId !== 'string') e.push('myUserId must be a string');

  const t = cfg.timing ?? {};
  for (const k of ['targetRemainingMs', 'extraBidLatencyMs', 'jitterMs', 'preCheckLeadMs', 'pollSeconds', 'horizonMinutes', 'maxPages', 'recalibrateMinutes'])
    if (typeof t[k] !== 'number') e.push(`timing.${k} must be a number`);
  if (typeof t.targetRemainingMs === 'number' && t.targetRemainingMs <= 10000) e.push('timing.targetRemainingMs must be > 10000, otherwise the bid triggers the 10 s extension');

  const g = cfg.global ?? {};
  if (typeof g.skipOwned !== 'boolean') e.push('global.skipOwned must be true or false');
  for (const k of ['reserveBalance', 'dailySpendCap', 'maxSnipesPerHour', 'minGapBetweenBidsMs']) if (typeof g[k] !== 'number') e.push(`global.${k} must be a number`);

  if (!Array.isArray(cfg.rules)) e.push('rules must be a list');
  else
    cfg.rules.forEach((r, i) => {
      const w = `rules[${i}]${r?.name ? ` (${r.name})` : ''}`;
      if (!r?.name) e.push(`${w}: needs a "name"`);
      checkWhen(r?.when, w, e);
      if (!r?.skip) {
        if (typeof r?.bid?.max !== 'number') e.push(`${w}: needs bid.max (a number) or "skip": true`);
        if (r?.bid?.increment !== undefined && typeof r.bid.increment !== 'number') e.push(`${w}: bid.increment must be a number`);
      }
    });

  const p = cfg.packs ?? {};
  if (typeof p.enabled !== 'boolean') e.push('packs.enabled must be true or false');
  for (const k of ['checkSeconds', 'jitterSeconds', 'maxPerRun', 'backoffMinutes']) if (typeof p[k] !== 'number') e.push(`packs.${k} must be a number`);
  if (!isRange(p.gapMs)) e.push('packs.gapMs must be [min, max] in milliseconds, e.g. [3500, 5000]');

  const r = cfg.recycle ?? {};
  for (const k of ['enabled', 'afterPackOpen', 'sweepExisting']) if (typeof r[k] !== 'boolean') e.push(`recycle.${k} must be true or false`);
  for (const k of ['sweepMinutes', 'maxPerRun']) if (typeof r[k] !== 'number') e.push(`recycle.${k} must be a number`);
  if (!isRange(r.gapMs)) e.push('recycle.gapMs must be [min, max] in milliseconds, e.g. [3500, 5000]');
  if (!['keep', 'recycle'].includes(r.default)) e.push('recycle.default must be "keep" or "recycle"');
  if (!Array.isArray(r.rules)) e.push('recycle.rules must be a list');
  else
    r.rules.forEach((x, i) => {
      const w = `recycle.rules[${i}]${x?.name ? ` (${x.name})` : ''}`;
      if (!x?.name) e.push(`${w}: needs a "name"`);
      if (!['keep', 'recycle'].includes(x?.action)) e.push(`${w}: "action" must be "keep" or "recycle"`);
      checkWhen(x?.when, w, e);
    });
  return e;
}

export function loadConfig(path = CONFIG_PATH) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }
  const problems = validate(cfg);
  if (problems.length) throw new Error(`config.json has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  return cfg;
}

/** Copy `next` into `cfg` in place so every module holding a reference sees the change. */
function applyInPlace(cfg, next) {
  for (const k of Object.keys(cfg)) if (!(k in next)) delete cfg[k];
  for (const [k, v] of Object.entries(next)) {
    if (k === 'myUserId' && !v && cfg[k]) continue; // keep the id derived from the login
    if (v && typeof v === 'object' && !Array.isArray(v) && cfg[k] && typeof cfg[k] === 'object' && !Array.isArray(cfg[k])) {
      for (const kk of Object.keys(cfg[k])) if (!(kk in v)) delete cfg[k][kk];
      Object.assign(cfg[k], v);
    } else cfg[k] = v;
  }
}

/** Hot-reload: re-read config.json when it changes; keep the old settings if the new file is invalid. */
export function watchConfig(cfg, log, path = CONFIG_PATH) {
  let last = fs.statSync(path).mtimeMs;
  setInterval(() => {
    try {
      const m = fs.statSync(path).mtimeMs;
      if (m === last) return;
      last = m;
      const next = loadConfig(path);
      applyInPlace(cfg, next);
      log(`config reloaded: ${cfg.rules.length} bid rule(s), ${cfg.recycle.rules.length} recycle rule(s), packs ${cfg.packs.enabled ? 'on' : 'off'}, recycle ${cfg.recycle.enabled ? 'on' : 'off'}`);
    } catch (err) {
      log(`config change IGNORED (previous settings still active): ${err.message}`);
    }
  }, 3000);
}
