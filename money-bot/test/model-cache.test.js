import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPremiumCalibrationCache, usablePremiumCalibration, writePremiumCalibrationCache } from '../src/model-cache.js';

test('calibration cache requires matching database identity, valid statistics and an earlier fresh window', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-model-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'market.db'), other = path.join(dir, 'other.db'), cache = path.join(dir, 'calibration.json');
  fs.writeFileSync(db, 'fixture'); fs.writeFileSync(other, 'different database');
  const end = 1_000_000_000;
  const calibration = { shift: 0.25, n: 241, windowEnd: end, windowStart: end - 12 * 3_600_000 };
  assert.equal(readPremiumCalibrationCache(cache, db), null);
  writePremiumCalibrationCache(cache, db, calibration);
  assert.deepEqual(readPremiumCalibrationCache(cache, db), calibration);
  assert.equal(readPremiumCalibrationCache(cache, other), null);
  assert.equal(usablePremiumCalibration(calibration, end), true);
  assert.equal(usablePremiumCalibration(calibration, end - 1), false, 'future calibration cannot leak into as-of pricing');
  assert.equal(usablePremiumCalibration(calibration, end + 6 * 3_600_000), false);
  assert.equal(usablePremiumCalibration({ ...calibration, shift: NaN }, end), false);
  assert.equal(usablePremiumCalibration({ ...calibration, n: 3 }, end), false);
  assert.equal(usablePremiumCalibration({ ...calibration, n: 3, shift: 0 }, end), true);
  assert.equal(usablePremiumCalibration({ ...calibration, windowStart: end }, end), false);
  fs.writeFileSync(cache, '{broken');
  assert.equal(readPremiumCalibrationCache(cache, db), null);
});
