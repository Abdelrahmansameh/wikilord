/** Share one lazy model build and refresh across the independent money accounts. */
export function createSharedMarketModel({ open, now = Date.now, refreshWindowMs = 60_000, replaceOnRefresh = false } = {}) {
  if (typeof open !== 'function') throw new Error('shared model requires an opener');
  if (!Number.isFinite(refreshWindowMs) || refreshWindowMs < 0)
    throw new Error('shared model refresh window must be nonnegative');
  let opened = null, opening = null, refreshing = null, closing = null, closed = false;
  let refreshedAt = null, refreshResult = null;
  const models = new Set(), leases = new Map(), retired = new Set(), terminations = new WeakMap();
  const closeModel = (model) => {
    if (!terminations.has(model)) terminations.set(model, (async () => {
      await model.close(); models.delete(model); retired.delete(model);
    })());
    return terminations.get(model);
  };
  const retire = (model) => {
    retired.add(model);
    if (!leases.get(model)) closeModel(model).catch(() => {});
  };

  const ensure = async () => {
    if (closed) throw new Error('shared market model is closed');
    if (opened) return opened;
    if (!opening) opening = (async () => {
      const model = await open();
      models.add(model);
      let dataTimestamp;
      try {
        if (closed) throw new Error('shared market model is closed');
        dataTimestamp = typeof model.ready === 'function' ? await model.ready() : undefined;
        if (closed) throw new Error('shared market model is closed');
      } catch (error) { await closeModel(model).catch(() => {}); throw error; }
      opened = model;
      // Opening already builds the model. Start its freshness clock on completion,
      // including when a build takes longer than the refresh suppression window.
      refreshedAt = now();
      refreshResult = { dataTimestamp };
      return model;
    })().finally(() => { opening = null; });
    return opening;
  };

  const refresh = () => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const model = await ensure();
      if (refreshedAt !== null && now() - refreshedAt < refreshWindowMs) return refreshResult;
      let result;
      if (replaceOnRefresh) {
        // The serving worker must never run a blocking rebuild while a snipe
        // waits for a quote. Keep serving it until its replacement is ready.
        const replacement = await open();
        models.add(replacement);
        try {
          if (closed) throw new Error('shared market model is closed');
          const dataTimestamp = typeof replacement.ready === 'function' ? await replacement.ready() : undefined;
          if (closed) throw new Error('shared market model is closed');
          opened = replacement;
          retire(model);
          result = { dataTimestamp };
        } catch (error) { await closeModel(replacement).catch(() => {}); throw error; }
      } else result = await model.refresh();
      refreshedAt = now();
      refreshResult = result;
      return result;
    })().finally(() => { refreshing = null; });
    return refreshing;
  };

  const call = async (method, args) => {
    let model = await ensure();
    while (retired.has(model)) model = await ensure();
    leases.set(model, (leases.get(model) ?? 0) + 1);
    try { return await model[method](...args); }
    finally {
      const count = leases.get(model) - 1;
      if (count) leases.set(model, count); else leases.delete(model);
      if (!count && retired.has(model)) closeModel(model).catch(() => {});
    }
  };

  return {
    quote: (...args) => call('quote', args),
    stats: (...args) => call('stats', args),
    quoteAtPrices: (...args) => call('quoteAtPrices', args),
    dealQuote: (...args) => call('dealQuote', args),
    purchaseAuctions: (...args) => call('purchaseAuctions', args),
    health: (...args) => call('health', args),
    refresh,
    close: () => {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        // Immediate worker factories let shutdown abort an unfinished build.
        await Promise.all([...models].map(closeModel));
        if (opening) await opening.catch(() => {});
        if (refreshing) await refreshing.catch(() => {});
        await Promise.all([...models].map(closeModel));
      })();
      return closing;
    },
  };
}
