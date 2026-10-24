// Decisions (save / reject) that could not reach the backend yet. Kept in storage.local so they survive
// the worker stopping and the browser restarting: a decision you made is never lost because jobs.test was down.
//
// A save's item carries the ad text (you chose to keep it); a reject's item carries metadata only.

export function createQueue(area) {
  // Reads and writes interleave across awaits, so run them one at a time.
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const read = async (key) => (await area.get(key))[key] || [];

  return {
    all: () => exclusive(() => read('queue')),
    size: () => exclusive(async () => (await read('queue')).length),

    // The last decision about an ad wins: a reject replaces a queued save of the same ad.
    add: (item) =>
      exclusive(async () => {
        const full = { id: crypto.randomUUID(), queuedAt: Date.now(), ...item };
        const items = (await read('queue')).filter((i) => i.url !== item.url);
        items.push(full);
        await area.set({ queue: items });
        return full;
      }),

    remove: (id) =>
      exclusive(async () => {
        await area.set({ queue: (await read('queue')).filter((i) => i.id !== id) });
      }),

    // The backend refused the item (not an outage): park it where it can be inspected instead of retrying forever.
    fail: (id, error) =>
      exclusive(async () => {
        const items = await read('queue');
        const item = items.find((i) => i.id === id);
        if (!item) return;
        const failed = await read('queue_failed');
        failed.push({ ...item, error, failedAt: Date.now() });
        await area.set({ queue: items.filter((i) => i.id !== id), queue_failed: failed });
      }),

    failed: () => exclusive(() => read('queue_failed')),
  };
}
