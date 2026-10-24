import assert from 'node:assert/strict';
import { test } from 'node:test';
import { badgeFor } from '../src/lib/badge.js';
import { BackendError, createBackend } from '../src/lib/api.js';
import { createController } from '../src/lib/controller.js';
import { createSettings, DEFAULT_SETTINGS } from '../src/lib/settings.js';
import { viewFor } from '../src/popup/view.js';
import { capture, fakeBackend, preview, setup, URL1 } from './fakes.js';

// --- badge ------------------------------------------------------------------------------------

test('badge text and colour per state', () => {
  const text = (state) => badgeFor(state).text;
  assert.equal(text(null), '');
  assert.equal(text({ status: 'scoring' }), '…');
  assert.equal(text({ status: 'expired' }), 'exp');
  assert.equal(text({ status: 'incomplete' }), '?');
  assert.equal(text({ status: 'offline' }), '!');
  assert.equal(text({ status: 'error' }), '!');
  assert.equal(text({ status: 'idle' }), '');
  const scored = (p) => ({ status: 'scored', preview: preview(p) });
  assert.equal(text(scored({ fit_score: 81.6 })), '82');
  assert.equal(text(scored({ fit_score: null })), '–');
  assert.equal(text(scored({ status: 'saved' })), '✓');
  assert.equal(text(scored({ status: 'applied' })), 'A');
  assert.equal(text(scored({ status: 'rejected' })), '✗');
});

test('score colour bands: green from 70, amber from 40, red below', () => {
  const color = (fit_score) => badgeFor({ status: 'scored', preview: preview({ fit_score }) }).color;
  assert.equal(color(70), color(100));
  assert.equal(color(40), color(69));
  assert.notEqual(color(69), color(70));
  assert.notEqual(color(39), color(40));
});

// --- backend client ---------------------------------------------------------------------------

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body, statusText = 'Err') => ({ ok: false, status, statusText, json: async () => body });

test('scorePreview posts the job as JSON, with ?force only when asked', async () => {
  const f = fakeFetch(() => ok(preview()));
  const backend = createBackend({ getBaseUrl: async () => 'http://jobs.test/', fetchFn: f });
  const job = capture().job;
  assert.deepEqual(await backend.scorePreview(job), preview());
  await backend.scorePreview(job, { force: true });
  assert.equal(f.calls[0].url, 'http://jobs.test/api/score-preview');
  assert.equal(f.calls[1].url, 'http://jobs.test/api/score-preview?force=true');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), job);
});

test('backend errors are classified as offline, timeout or http', async () => {
  const make = (handler, extra = {}) => createBackend({ getBaseUrl: async () => 'http://jobs.test', fetchFn: fakeFetch(handler), ...extra });
  await assert.rejects(make(() => { throw new TypeError('Failed to fetch'); }).scorePreview({}),
    (e) => e instanceof BackendError && e.kind === 'offline' && /jobs\.test/.test(e.message) && /TypeError: Failed to fetch/.test(e.message));
  await assert.rejects(make(() => fail(422, { detail: "'seen' records are created elsewhere" })).scorePreview({}),
    (e) => e.kind === 'http' && e.status === 422 && e.message === "'seen' records are created elsewhere");
  await assert.rejects(make(() => fail(422, { detail: [{ loc: ['body'] }] })).scorePreview({}),
    (e) => e.kind === 'http' && e.message === 'The backend rejected the request.');
  await assert.rejects(make(() => ({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => { throw new Error('html'); } })).scorePreview({}),
    (e) => e.kind === 'http' && e.message === 'Bad Gateway');
  const hangs = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(make(hangs, { timeoutMs: 10 }).scorePreview({}), (e) => e.kind === 'timeout');
});

// --- controller -------------------------------------------------------------------------------

test('a viewed ad is scored: badge goes … then the score, and the state is kept for the popup', async () => {
  const { controller, badges, calls } = setup();
  await controller.onAdViewed(7, capture());
  assert.deepEqual(badges, [[7, '…'], [7, '82']]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['scorePreview', capture().job, { force: false }]);
  const state = await controller.getState(7, URL1);
  assert.equal(state.status, 'scored');
  assert.equal(state.preview.fit_score, 82);
});

test('with auto-score off nothing is sent until asked', async () => {
  const { controller, badges, calls } = setup({ settings: { autoScore: false } });
  await controller.onAdViewed(1, capture());
  assert.equal(calls.length, 0);
  assert.equal((await controller.getState(1, URL1)).status, 'idle');
  assert.deepEqual(badges, [[1, '']]);
  await controller.rescore(1, { force: false });
  assert.equal(calls.length, 1);
  assert.equal((await controller.getState(1, URL1)).status, 'scored');
});

test('expired and unreadable ads are never sent for scoring', async () => {
  const { controller, badges, calls } = setup();
  await controller.onAdViewed(1, capture({ expired: true }));
  await controller.onAdViewed(2, capture({ missing: ['title'] }));
  await controller.onAdViewed(3, capture({ missing: ['descriptionSnippet'] }));
  assert.equal(calls.length, 0);
  assert.deepEqual(badges, [[1, 'exp'], [2, '?'], [3, '?']]);
});

test('a short description alone does not stop scoring', async () => {
  const { controller, calls } = setup();
  await controller.onAdViewed(1, capture({ missing: ['fullDescription'] }));
  assert.equal(calls.length, 1);
});

test('backend failures show as ! with the reason; the ad is kept so it can be retried', async () => {
  let fail = new BackendError('offline', 'Cannot reach the backend at http://jobs.test.');
  const { controller, badges } = setup({ backend: fakeBackend({ scorePreview: async () => { if (fail) throw fail; return preview(); } }) });
  await controller.onAdViewed(1, capture());
  let state = await controller.getState(1, URL1);
  assert.equal(state.status, 'offline');
  assert.match(state.error, /Cannot reach/);
  fail = new BackendError('http', 'bad request', 422);
  await controller.rescore(1, { force: true });
  assert.equal((await controller.getState(1, URL1)).status, 'error');
  fail = null;
  await controller.rescore(1, { force: true });
  assert.equal((await controller.getState(1, URL1)).status, 'scored');
  assert.equal(badges.at(-1)[1], '82');
});

test('rescore passes force through, and does nothing for a tab with no ad', async () => {
  const { controller, calls } = setup();
  assert.deepEqual(await controller.rescore(99, { force: true }), { ok: false });
  await controller.onAdViewed(1, capture());
  await controller.rescore(1, { force: true });
  assert.deepEqual(calls.map((c) => c[2].force), [false, true]);
});

test('state is only returned for the page the tab is on now', async () => {
  const { controller } = setup();
  await controller.onAdViewed(1, capture());
  assert.ok(await controller.getState(1, URL1 + '#hae'));
  assert.equal(await controller.getState(1, 'https://duunitori.fi/tyopaikat/tyo/other-2'), null);
  assert.equal(await controller.getState(2, URL1), null);
});

test('closing a tab drops its state, including the ad text', async () => {
  const { controller, session } = setup();
  await controller.onAdViewed(5, capture());
  assert.ok(session.has('tab:5'));
  await controller.onTabRemoved(5);
  assert.equal(session.has('tab:5'), false);
});

test('a slow answer for an earlier ad cannot overwrite the current one', async () => {
  const gates = [];
  const backend = fakeBackend({ scorePreview: (job) => new Promise((resolve) => gates.push(() => resolve(preview({ fit_score: job.url.endsWith('-1') ? 10 : 90 })))) });
  const { controller } = setup({ backend });
  const first = controller.onAdViewed(1, capture({ url: 'https://duunitori.fi/tyopaikat/tyo/ad-1' }));
  await new Promise((r) => setTimeout(r, 0));
  const second = controller.onAdViewed(1, capture({ url: 'https://duunitori.fi/tyopaikat/tyo/ad-2' }));
  await new Promise((r) => setTimeout(r, 0));
  gates[1]();
  await second;
  gates[0](); // the first request finishes last
  await first;
  const state = await controller.getState(1, 'https://duunitori.fi/tyopaikat/tyo/ad-2');
  assert.equal(state.preview.fit_score, 90);
});

test('a tab closed mid-update does not break the controller', async () => {
  const closed = createController({
    api: { action: { setBadgeText: async () => { throw new Error('No tab with id'); }, setBadgeBackgroundColor: async () => {} }, alarms: { clear: async () => {} } },
    backend: fakeBackend(),
    queue: { all: async () => [], size: async () => 0 },
    store: { get: async () => undefined, set: async () => {}, remove: async () => {} },
    getSettings: async () => DEFAULT_SETTINGS,
  });
  await assert.doesNotReject(closed.onAdViewed(1, capture()));
});

// --- popup view -------------------------------------------------------------------------------

test('popup view per state', () => {
  const state = (status, extra = {}) => ({ status, url: URL1, capture: capture(), ...extra });
  assert.equal(viewFor(null, 'https://example.com/').kind, 'unknown-page', 'an unknown site can be read on request');
  assert.equal(viewFor(null, 'https://duunitori.fi/tyopaikat?haku=go').kind, 'not-ad', 'a Duunitori list page is not an ad');
  assert.equal(viewFor(null, 'about:blank').kind, 'not-ad');
  assert.equal(viewFor(null, URL1).kind, 'waiting');
  assert.equal(viewFor(null, URL1 + '?utm=x#top').kind, 'waiting');

  const scored = viewFor(state('scored', { preview: preview() }), URL1);
  assert.equal(scored.score, 82);
  assert.equal(scored.reason, 'Good Go match.');
  assert.equal(scored.heading.company, 'Acme Oy');
  assert.deepEqual(scored.actions.map((a) => a.id), ['save', 'reject', 'rescore']);

  const noScore = viewFor(state('scored', { preview: preview({ fit_score: null, fit_reason: 'API Key missing for gemini.' }) }), URL1);
  assert.equal(noScore.score, undefined);
  assert.equal(noScore.message, 'API Key missing for gemini.');

  assert.equal(viewFor(state('scored', { preview: preview({ status: 'saved' }) }), URL1).banner, 'Already saved');
  assert.match(viewFor(state('scoring'), URL1).message, /Scoring/);
  assert.match(viewFor(state('expired'), URL1).message, /expired/);
  assert.match(viewFor(state('incomplete', { capture: capture({ missing: ['title', 'descriptionSnippet'] }) }), URL1).message, /missing: title, description/);
  assert.match(viewFor(state('offline', { error: 'Cannot reach the backend.' }), URL1).message, /Is the backend running/);
  assert.equal(viewFor(state('error', { error: 'bad' }), URL1).message, 'bad');
  assert.deepEqual(viewFor(state('idle'), URL1).actions.map((a) => a.id), ['score-now', 'save', 'reject']);
});

// --- settings ---------------------------------------------------------------------------------

test('settings default, merge and persist', async () => {
  let saved = {};
  const area = { get: async (key) => (key in saved ? { [key]: saved[key] } : {}), set: async (obj) => { saved = { ...saved, ...obj }; } };
  const settings = createSettings(area);
  assert.deepEqual(await settings.get(), DEFAULT_SETTINGS);
  await settings.set({ autoScore: false });
  assert.deepEqual(await settings.get(), { ...DEFAULT_SETTINGS, autoScore: false });
  assert.equal(DEFAULT_SETTINGS.backendUrl, 'http://jobs.test');
});
