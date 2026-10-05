import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** Persist the latest approved settings, and apply them between account activities. */
export function createSettingsQueue({ file, getConfig, isBusy, apply, validate = () => [],
  delayMs = 250, log = () => {} }) {
  let job = null, running = null, timer = null, closed = false;
  const save = () => {
    const temporary = `${file}.tmp-${randomUUID()}`;
    try { fs.writeFileSync(temporary, JSON.stringify(job)); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  };
  const status = () => job ? { id: job.id, status: job.status, queuedAt: job.queuedAt,
    appliedAt: job.appliedAt ?? null, error: job.error ?? null } : null;
  const pending = () => Boolean(job && ['queued', 'applying'].includes(job.status));
  function schedule() {
    if (closed || timer || !pending()) return;
    timer = setTimeout(() => {
      timer = null;
      pump().catch((error) => log(`settings queue: ${error.message}`));
    }, delayMs);
    timer.unref?.();
  }
  async function pump() {
    if (closed || running || !pending()) return;
    if (isBusy()) return schedule();
    const current = job;
    running = current;
    try {
      const errors = validate(current.config);
      if (errors.length) throw new Error(errors.join('; '));
      const active = fingerprint(getConfig());
      if (active !== fingerprint(current.config)) {
        if (!current.acceptedBases.includes(active))
          throw new Error('Settings changed outside the queue. Review and save your settings again.');
        current.status = 'applying';
        save();
        await apply(current.config);
      }
      current.status = 'applied'; current.appliedAt = Date.now(); current.error = null;
      if (job === current && fs.existsSync(file)) fs.unlinkSync(file);
    } catch (error) {
      current.status = 'failed'; current.error = error.message;
      if (job === current) save();
      log(`settings were not applied: ${error.message}`);
    } finally {
      running = null;
      schedule();
    }
  }
  try {
    job = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!job?.id || !job.config || !Array.isArray(job.acceptedBases)) throw new Error('Invalid saved settings queue');
    if (job.status !== 'failed') job.status = 'queued';
  } catch (error) {
    if (error.code !== 'ENOENT') {
      job = { id: randomUUID(), status: 'failed', queuedAt: Date.now(), error: error.message };
      log(`settings queue could not be restored: ${error.message}`);
    }
  }
  schedule();
  return {
    status, pending,
    applying: () => Boolean(running),
    proposedConfig: () => job && ['queued', 'applying', 'failed'].includes(job.status) ? job.config ?? getConfig() : getConfig(),
    enqueue(config) {
      if (closed) throw new Error('Settings queue is closed');
      const errors = validate(config);
      if (errors.length) throw new Error(errors.join('; '));
      const acceptedBases = [...new Set([fingerprint(getConfig()), ...(running ? [fingerprint(running.config)] : [])])];
      const next = { id: randomUUID(), config: structuredClone(config), acceptedBases,
        status: 'queued', queuedAt: Date.now() };
      const previous = job;
      job = next;
      try { save(); } catch (error) { job = previous; throw error; }
      schedule();
      return status();
    },
    close() { closed = true; if (timer) clearTimeout(timer); timer = null; },
  };
}
