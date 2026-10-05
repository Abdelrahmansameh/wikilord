import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const identity = (dbPath) => {
  const stat = fs.statSync(dbPath);
  return [path.resolve(dbPath), stat.dev, stat.ino, stat.birthtimeMs];
};

export function usablePremiumCalibration(calibration, dataTimestamp) {
  return Boolean(calibration && Number.isFinite(calibration.shift) && calibration.shift >= 0 && calibration.shift <= 3
    && Number.isInteger(calibration.n) && calibration.n >= 0 && calibration.n <= 12000
    && (calibration.n >= 30 || calibration.shift === 0)
    && Number.isFinite(calibration.windowStart) && Number.isFinite(calibration.windowEnd)
    && calibration.windowEnd - calibration.windowStart === 12 * 3_600_000
    && calibration.windowEnd <= dataTimestamp && dataTimestamp - calibration.windowEnd < 6 * 3_600_000);
}

/** Optional private cache; damaged records and replaced databases cannot supply
 * a calibration. The model also checks freshness against its as-of timestamp. */
export function readPremiumCalibrationCache(cachePath, dbPath) {
  if (!cachePath) return null;
  try {
    const record = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (record.version !== VERSION || JSON.stringify(record.database) !== JSON.stringify(identity(dbPath))) return null;
    return record.calibration;
  } catch { return null; }
}

export function writePremiumCalibrationCache(cachePath, dbPath, calibration) {
  if (!cachePath) return;
  const record = { version: VERSION, database: identity(dbPath), calibration };
  fs.writeFileSync(`${cachePath}.tmp`, JSON.stringify(record));
  fs.renameSync(`${cachePath}.tmp`, cachePath);
}
