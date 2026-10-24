import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQueue } from '../src/lib/queue.js';
import { createBackend } from '../src/lib/api.js';
import { badgeFor } from '../src/lib/badge.js';
import { viewFor } from '../src/popup/view.js';
import { FLUSH_ALARM } from '../src/lib/controller.js';
import { capture, fakeBackend, preview, refused, setup, unreachable, URL1 } from './fakes.js';

const lastBadge = (badges) => badges.at(-1)[1];

// --- save ---------------------------------------------------------------------------------------

test('save sends the full capture and the badge becomes a tick', async () => {
  const { controller, backend, badges } = setup();
  await controller.onAdViewed(1, capture());
  assert.deepEqual(await controller.perform(1, 'save'), { ok: true });
  const [, job] = backend.named('save')[0];
  assert.equal(job.descriptionSnippet, 'We build things.');
  assert.equal(job.raw.site, 'duunitori');
  assert.equal(lastBadge(badges), '✓');
  const state = await controller.getState(1, URL1);
  assert.equal(state.preview.status, 'saved');
  assert.deepEqual(state.decision, { action: 'save', previous: 'seen' });
});

test('save works before the score arrives, and the late score cannot overwrite it', async () => {
  let release;
  const slow = fakeBackend({ scorePreview: () => new Promise((resolve) => { release = () => resolve(preview({ fit_score: 12 })); }) });
  const { controller, badges } = setup({ backend: slow });
  const viewing = controller.onAdViewed(1, capture());
  await new Promise((r) => setTimeout(r, 0));
  await controller.perform(1, 'save');
  assert.equal(lastBadge(badges), '✓');
  release();
  await viewing;
  assert.equal(lastBadge(badges), '✓', 'the earlier score request must not replace the decision');
  assert.equal((await controller.getState(1, URL1)).preview.status, 'saved');
});

test('save is allowed with auto-scoring off, on an expired ad, and with only a short description', async () => {
  for (const [settings, cap] of [
    [{ autoScore: false }, capture()],
    [{}, capture({ expired: true })],
    [{}, capture({ missing: ['fullDescription'] })],
  ]) {
    const { controller, backend } = setup({ settings });
    await controller.onAdViewed(1, cap);
    assert.equal((await controller.perform(1, 'save')).ok, true);
    assert.equal(backend.named('save').length, 1);
  }
});

test('an ad that cannot be identified is refused, with a message', async () => {
  const { controller, backend } = setup();
  await controller.onAdViewed(1, capture({ missing: ['title', 'descriptionSnippet'] }));
  const result = await controller.perform(1, 'save');
  assert.equal(result.ok, false);
  assert.match((await controller.getState(1, URL1)).notice, /could not be read completely/);
  assert.equal(backend.named('save').length, 0);
});

test('nothing happens on a tab with no ad', async () => {
  const { controller, backend } = setup();
  assert.equal((await controller.perform(5, 'save')).ok, false);
  assert.equal(backend.calls.length, 0);
});

test('saving an ad that is already saved sends nothing', async () => {
  const { controller, backend } = setup({ backend: fakeBackend({ scorePreview: async () => preview({ status: 'saved' }) }) });
  await controller.onAdViewed(1, capture());
  assert.deepEqual(await controller.perform(1, 'save'), { ok: true, unchanged: true });
  assert.equal(backend.named('save').length, 0);
});

test('a refusal from the backend is shown, not queued', async () => {
  const { controller, queue, badges } = setup({ backend: fakeBackend({ save: async () => { throw refused('bad ad'); } }) });
  await controller.onAdViewed(1, capture());
  const result = await controller.perform(1, 'save');
  assert.deepEqual(result, { ok: false, error: 'bad ad' });
  assert.equal(lastBadge(badges), '!');
  assert.equal(await queue.size(), 0);
});

// --- reject -------------------------------------------------------------------------------------

test('reject of a scored ad changes its status by id and sends no text', async () => {
  const { controller, backend, badges } = setup();
  await controller.onAdViewed(1, capture());
  await controller.perform(1, 'reject');
  assert.deepEqual(backend.named('setStatus')[0], ['setStatus', 1, 'rejected']);
  assert.equal(backend.named('recordSeen').length, 0);
  assert.equal(backend.named('save').length, 0);
  assert.equal(lastBadge(badges), '✗');
});

test('reject before any score exists first records the ad as seen, without its text', async () => {
  const { controller, backend } = setup({ settings: { autoScore: false } });
  await controller.onAdViewed(1, capture());
  await controller.perform(1, 'reject');
  const [, job] = backend.named('recordSeen')[0];
  assert.equal(job.title, 'Backend Developer');
  assert.equal('descriptionSnippet' in job, false);
  assert.equal('raw' in job, false);
  assert.deepEqual(backend.named('setStatus')[0], ['setStatus', 7, 'rejected']); // id returned by recordSeen
});

test('an applied job is never overwritten by a shortcut', async () => {
  const { controller, backend } = setup({ backend: fakeBackend({ scorePreview: async () => preview({ status: 'applied' }) }) });
  await controller.onAdViewed(1, capture());
  for (const action of ['reject', 'save']) {
    const result = await controller.perform(1, action);
    assert.equal(result.ok, false);
    assert.match(result.error, /marked applied/);
  }
  assert.equal(backend.named('setStatus').length + backend.named('save').length, 0);
});

// --- offline queue ------------------------------------------------------------------------------

test('a save made while the backend is down is queued with its text, and shown as queued', async () => {
  const backend = fakeBackend({ save: async () => { throw unreachable(); } });
  const { controller, queue, badges, alarms } = setup({ backend });
  await controller.onAdViewed(1, capture());
  assert.deepEqual(await controller.perform(1, 'save'), { ok: true, queued: true });
  const [item] = await queue.all();
  assert.equal(item.type, 'save');
  assert.equal(item.job.descriptionSnippet, 'We build things.');
  assert.equal(lastBadge(badges), '↻');
  assert.equal(alarms.created[0][0], FLUSH_ALARM);
  const state = await controller.getState(1, URL1);
  assert.equal(state.status, 'queued');
  assert.equal(state.queueSize, 1);
});

test('a reject made while the backend is down is queued without any ad text', async () => {
  const backend = fakeBackend({ setStatus: async () => { throw unreachable(); } });
  const { controller, queue } = setup({ backend });
  await controller.onAdViewed(1, capture());
  await controller.perform(1, 'reject');
  const [item] = await queue.all();
  assert.equal(item.type, 'reject');
  assert.equal(item.id, 1);
  assert.equal('descriptionSnippet' in item.job, false);
  assert.equal('raw' in item.job, false);
});

test('a timeout counts as unreachable and is queued', async () => {
  const { BackendError } = await import('../src/lib/api.js');
  const backend = fakeBackend({ save: async () => { throw new BackendError('timeout', 'slow'); } });
  const { controller, queue } = setup({ backend });
  await controller.onAdViewed(1, capture());
  await controller.perform(1, 'save');
  assert.equal(await queue.size(), 1);
});

test('the last decision about an ad wins in the queue', async () => {
  let down = true;
  const backend = fakeBackend({
    save: async () => { if (down) throw unreachable(); return { id: 1, status: 'saved' }; },
    setStatus: async (id, status) => { if (down) throw unreachable(); return { id, status }; },
  });
  const { controller, queue } = setup({ backend });
  await controller.onAdViewed(1, capture());
  await controller.perform(1, 'save');
  await controller.perform(1, 'reject');
  assert.deepEqual((await queue.all()).map((i) => i.type), ['reject']);
  down = false;
  await controller.flushQueue();
  assert.equal(backend.named('save').length, 1, 'only the attempt that failed, never replayed');
  assert.equal((await controller.getState(1, URL1)).preview.status, 'rejected');
});

test('flushing sends queued decisions, updates the tab, and stops the retry alarm', async () => {
  let down = true;
  const backend = fakeBackend({ save: async () => { if (down) throw unreachable(); return { id: 1, status: 'saved', fit_score: 80 }; } });
  const { controller, queue, badges, alarms } = setup({ backend });
  await controller.onAdViewed(1, capture());
  await controller.perform(1, 'save');
  await controller.flushQueue(); // still down: nothing lost, nothing sent
  assert.equal(await queue.size(), 1);
  assert.equal(lastBadge(badges), '↻');
  down = false;
  await controller.flushQueue();
  assert.equal(await queue.size(), 0);
  assert.equal(lastBadge(badges), '✓');
  assert.equal((await controller.getState(1, URL1)).status, 'scored');
  assert.ok(alarms.cleared.includes(FLUSH_ALARM));
});

test('a queued decision still goes through after its tab was closed', async () => {
  let down = true;
  const backend = fakeBackend({ save: async () => { if (down) throw unreachable(); return { id: 1, status: 'saved' }; } });
  const { controller, queue } = setup({ backend });
  await controller.onAdViewed(1, capture());
  await controller.perform(1, 'save');
  await controller.onTabRemoved(1);
  down = false;
  await controller.flushQueue();
  assert.equal(await queue.size(), 0);
  assert.equal(backend.named('save').length, 2);
});

test('an item the backend refuses is parked, not retried forever', async () => {
  let phase = 'down';
  const backend = fakeBackend({ save: async () => { if (phase === 'down') throw unreachable(); throw refused('invalid job'); } });
  const { controller, queue } = setup({ backend });
  await controller.onAdViewed(1, capture());
  await controller.perform(1, 'save');
  phase = 'refusing';
  await controller.flushQueue();
  assert.equal(await queue.size(), 0);
  const [failed] = await queue.failed();
  assert.equal(failed.error, 'invalid job');
  const state = await controller.getState(1, URL1);
  assert.equal(state.status, 'error');
  assert.match(state.error, /Could not sync: invalid job/);
});

test('the queue is also flushed after any successful score', async () => {
  let down = true;
  const backend = fakeBackend({ save: async () => { if (down) throw unreachable(); return { id: 9, status: 'saved' }; } });
  const { controller, queue } = setup({ backend });
  await controller.onAdViewed(1, capture());
  await controller.perform(1, 'save');
  down = false;
  await controller.onAdViewed(2, capture({ url: 'https://duunitori.fi/tyopaikat/tyo/other-2' }));
  assert.equal(await queue.size(), 0);
});

test('queue operations that overlap do not lose items', async () => {
  const data = new Map();
  const queue = createQueue({
    get: async (key) => { await new Promise((r) => setTimeout(r, 1)); return data.has(key) ? { [key]: data.get(key) } : {}; },
    set: async (obj) => { await new Promise((r) => setTimeout(r, 1)); Object.entries(obj).forEach(([k, v]) => data.set(k, v)); },
  });
  await Promise.all([1, 2, 3, 4, 5].map((n) => queue.add({ url: `https://x/${n}`, type: 'save' })));
  assert.equal(await queue.size(), 5);
});

// --- undo ---------------------------------------------------------------------------------------

test('undo returns the ad to its earlier status and the badge to its score', async () => {
  const { controller, backend, badges } = setup();
  await controller.onAdViewed(1, capture());
  await controller.perform(1, 'save');
  assert.deepEqual(await controller.undo(1), { ok: true });
  assert.deepEqual(backend.named('setStatus').at(-1), ['setStatus', 1, 'seen']);
  assert.equal(lastBadge(badges), '82');
  const state = await controller.getState(1, URL1);
  assert.equal(state.decision, undefined);
  assert.equal(state.preview.status, 'seen');
});

test('undo restores a previous non-seen status', async () => {
  const { controller, backend } = setup({ backend: fakeBackend({ scorePreview: async () => preview({ status: 'rejected' }) }) });
  await controller.onAdViewed(1, capture());
  await controller.perform(1, 'save');
  await controller.undo(1);
  assert.deepEqual(backend.named('setStatus').at(-1), ['setStatus', 1, 'rejected']);
});

test('a failed undo keeps the decision and says why', async () => {
  let fail = false;
  const backend = fakeBackend({ setStatus: async (id, status) => { if (fail) throw unreachable(); return { id, status }; } });
  const { controller } = setup({ backend });
  await controller.onAdViewed(1, capture());
  await controller.perform(1, 'reject');
  fail = true;
  assert.equal((await controller.undo(1)).ok, false);
  const state = await controller.getState(1, URL1);
  assert.equal(state.preview.status, 'rejected');
  assert.match(state.notice, /Could not undo/);
});

test('undo with nothing to undo does nothing; scoring again keeps the decision', async () => {
  const { controller, backend } = setup();
  await controller.onAdViewed(1, capture());
  assert.deepEqual(await controller.undo(1), { ok: false });
  await controller.perform(1, 'save');
  await controller.rescore(1, { force: true });
  assert.ok((await controller.getState(1, URL1)).decision);
  assert.equal(backend.named('setStatus').length, 0);
});

// --- url-less popup -----------------------------------------------------------------------------

test('state is found even when the browser withholds the tab URL', async () => {
  const { controller } = setup();
  await controller.onAdViewed(1, capture());
  assert.equal((await controller.getState(1, undefined)).status, 'scored');
  assert.equal(await controller.getState(1, 'https://duunitori.fi/tyopaikat/tyo/different-9'), null);
});

// --- backend client -----------------------------------------------------------------------------

test('client calls for save, reject and undo', async () => {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: 3 }) }; };
  const backend = createBackend({ getBaseUrl: async () => 'http://jobs.test', fetchFn });
  const job = capture().job;
  await backend.save(job);
  await backend.recordSeen(job);
  await backend.setStatus(3, 'rejected');
  assert.equal(calls[0].url, 'http://jobs.test/api/jobs');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ...job, status: 'saved' });
  assert.equal(calls[1].url, 'http://jobs.test/api/score-preview?score=false');
  assert.equal(calls[2].url, 'http://jobs.test/api/jobs/3');
  assert.equal(calls[2].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[2].init.body), { status: 'rejected' });
});

// --- badge and popup view -----------------------------------------------------------------------

test('badge for saving and queued', () => {
  assert.equal(badgeFor({ status: 'saving' }).text, '…');
  assert.equal(badgeFor({ status: 'queued' }).text, '↻');
});

test('popup offers only the decisions that make sense, with banners and undo', () => {
  const base = (over = {}) => ({ status: 'scored', url: URL1, capture: capture(), preview: preview(), ...over });
  const ids = (view) => view.actions.map((a) => a.id);

  assert.deepEqual(ids(viewFor(base(), URL1)), ['save', 'reject', 'rescore']);
  const saved = viewFor(base({ preview: preview({ status: 'saved' }) }), URL1);
  assert.deepEqual(ids(saved), ['reject', 'rescore']);
  assert.equal(saved.banner, 'Already saved');
  assert.deepEqual(ids(viewFor(base({ preview: preview({ status: 'rejected' }) }), URL1)), ['save', 'rescore']);
  assert.deepEqual(ids(viewFor(base({ preview: preview({ status: 'applied' }) }), URL1)), ['rescore']);

  const justSaved = viewFor(base({ preview: preview({ status: 'saved' }), decision: { action: 'save', previous: 'seen' } }), URL1);
  assert.deepEqual(ids(justSaved), ['undo', 'rescore']);
  assert.equal(justSaved.banner, 'Saved');

  const queued = viewFor(base({ status: 'queued', queueSize: 2, decision: { action: 'reject', previous: 'seen' } }), URL1);
  assert.equal(queued.banner, 'Rejected locally');
  assert.match(queued.message, /2 queued/);
  assert.deepEqual(ids(queued), ['flush']);

  assert.deepEqual(ids(viewFor(base({ status: 'idle', preview: undefined }), URL1)), ['score-now', 'save', 'reject']);
  assert.deepEqual(ids(viewFor(base({ status: 'offline', error: 'down', preview: undefined }), URL1)), ['save', 'reject', 'rescore']);
  assert.deepEqual(ids(viewFor(base({ status: 'scoring', preview: undefined }), URL1)), ['save', 'reject']);
  assert.deepEqual(ids(viewFor(base({ status: 'saving' }), URL1)), []);
  assert.deepEqual(ids(viewFor(base({ status: 'incomplete', preview: undefined, capture: capture({ missing: ['title'] }) }), URL1)), []);
  assert.equal(viewFor(base({ notice: 'Could not undo: x' }), URL1).notice, 'Could not undo: x');
});
