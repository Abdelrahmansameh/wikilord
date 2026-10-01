/** Aim for the normal lead time. If it has passed, send immediately. */
export function counterWaitMs(msLeft, targetRemainingMs, oneWayMs, jitterMs = 0) {
  const wait = msLeft - targetRemainingMs - oneWayMs;
  return wait <= 0 ? 0 : Math.max(0, wait + jitterMs);
}
