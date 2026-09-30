const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Estimates (server clock - local clock) and network round-trip.
 * The HTTP Date header only has 1 s resolution, so we fire overlapping requests every
 * `intervalMs` and locate the instants where the header ticks over to the next second.
 */
export async function calibrate(session, { durationMs = 10000, intervalMs = 150 } = {}) {
  const samples = [];
  const inflight = [];
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    inflight.push(
      session
        .request('GET', `/manifest.webmanifest?c=${Math.random().toString(36).slice(2)}`)
        .then((r) => {
          if (r.date) samples.push({ mid: (r.t0 + r.t1) / 2, rtt: r.t1 - r.t0, sec: Math.floor(Date.parse(r.date) / 1000) });
        })
        .catch(() => {}),
    );
    await sleep(intervalMs);
  }
  await Promise.all(inflight);
  samples.sort((a, b) => a.mid - b.mid);

  const rtts = samples.map((s) => s.rtt).sort((a, b) => a - b);
  const rtt = rtts.length ? rtts[Math.floor(rtts.length / 2)] : 300;

  const brackets = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (b.sec === a.sec + 1) {
      // The server second boundary (b.sec*1000, server time) happened between the two request midpoints.
      brackets.push({ width: b.mid - a.mid, offset: b.sec * 1000 - (a.mid + b.mid) / 2 });
    }
  }
  if (!brackets.length) return { offsetMs: 0, rttMs: rtt, uncertaintyMs: 1000, samples: samples.length };
  brackets.sort((x, y) => x.width - y.width);
  const best = brackets.slice(0, 3);
  const offsetMs = best.reduce((s, x) => s + x.offset, 0) / best.length;
  return { offsetMs, rttMs: rtt, uncertaintyMs: best[0].width / 2, samples: samples.length };
}
