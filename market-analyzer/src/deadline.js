/** A deadline must reject even if a network operation ignores cancellation. */
export async function withDeadline(run, timeoutMs, { signal, label = 'market request' } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(
    new Error(`${label} timed out after ${timeoutMs} ms`), { name: 'TimeoutError' },
  )), timeoutMs);
  let rejectOnAbort;
  const expired = new Promise((_, reject) => {
    rejectOnAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    if (controller.signal.aborted) rejectOnAbort();
  });
  try {
    return await Promise.race([expired, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return run(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}
