import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createBackend } from '../src/lib/api.js';
import { DUUNITORI_FILES, GENERIC_FILES, readerFor, WHY } from '../src/lib/sites.js';
import { viewFor } from '../src/popup/view.js';
import { buildManifest } from '../build.mjs';
import { fixture, pageWith } from './helpers.js';
import { capture, fakeBackend, preview, refused, setup, URL1 } from './fakes.js';

const GENERIC_URL = 'https://careers.northwind.example/jobs/101';
const plain = (v) => JSON.parse(JSON.stringify(v));
const generic = (over = {}, quality = {}) => {
  const c = capture({ url: GENERIC_URL });
  return { ...c, ...over, quality: { missing: [], guessed: [], confidence: 'high', ambiguous: false, ...quality } };
};

// --- routing ----------------------------------------------------------------------------------

test('which reader fits which page', () => {
  assert.deepEqual(readerFor('https://duunitori.fi/tyopaikat/tyo/dev-1').kind, 'duunitori');
  assert.deepEqual(readerFor('https://www.duunitori.fi/tyopaikat/tyo/dev-1?haku=go#x').files, DUUNITORI_FILES);
  assert.deepEqual(readerFor(GENERIC_URL), { kind: 'generic', files: GENERIC_FILES });
  assert.equal(readerFor('http://localhost:3000/job/1').kind, 'generic');
  for (const [url, why] of [
    ['https://duunitori.fi/tyopaikat?haku=python', 'duunitori-not-an-ad'],
    ['https://duunitori.fi/yritys/acme', 'duunitori-not-an-ad'],
    ['about:blank', 'unsupported-page'],
    ['chrome://extensions', 'unsupported-page'],
    ['moz-extension://abc/popup.html', 'unsupported-page'],
    ['file:///home/me/job.html', 'unsupported-page'],
    ['', 'unknown-address'],
    [undefined, 'unknown-address'],
  ]) assert.deepEqual(readerFor(url), { kind: null, why }, String(url));
  for (const why of ['unknown-address', 'unsupported-page', 'duunitori-not-an-ad']) assert.ok(WHY[why]);
});

test('the generic reader is never injected automatically', async () => {
  for (const target of ['chrome', 'firefox']) {
    const m = await buildManifest(target);
    const injected = m.content_scripts.flatMap((c) => c.js);
    assert.deepEqual(injected, DUUNITORI_FILES);
    assert.ok(!injected.some((f) => f.includes('generic')));
    assert.ok(m.content_scripts.every((c) => c.matches.every((p) => /duunitori\.fi/.test(p))));
  }
});

// --- the generic content script ---------------------------------------------------------------

const contentScript = readFileSync(new URL('../src/content/generic.js', import.meta.url), 'utf8');
function runGeneric(html, url, { throwInParser = false } = {}) {
  const sent = [];
  const win = pageWith(html, { url, scripts: ['parsers/jsonld.js', 'parsers/generic.js'], globals: { chrome: { runtime: { sendMessage: (m) => { sent.push(m); } } } } });
  if (throwInParser) { win.JH.parseGeneric = () => { throw new RangeError('parser blew up'); }; win.console.error = () => {}; }
  win.eval(contentScript);
  return plain(sent);
}

test('the generic content script reads the page once and reports it, whatever the address', () => {
  const sent = runGeneric(fixture('careers-jsonld.html'), GENERIC_URL);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'ad-viewed');
  assert.equal(sent[0].capture.job.title, 'Platform Engineer');
  assert.equal(sent[0].capture.job.url, GENERIC_URL);
});

test('and reports its own failure instead of staying silent', () => {
  const sent = runGeneric(fixture('careers-jsonld.html'), GENERIC_URL, { throwInParser: true });
  assert.deepEqual(sent, [{ type: 'ad-error', url: GENERIC_URL, error: 'parser blew up' }]);
});

// --- controller: choosing a reader ------------------------------------------------------------

test('scanTab injects the reader that fits the page address', async () => {
  const { controller, scripts } = setup();
  await controller.scanTab(1, GENERIC_URL);
  await controller.scanTab(2, 'https://duunitori.fi/tyopaikat/tyo/dev-1');
  await controller.scanTab(3); // no address available: keep the Duunitori reader
  assert.deepEqual(scripts.map((s) => [s.target.tabId, s.files]), [[1, GENERIC_FILES], [2, DUUNITORI_FILES], [3, DUUNITORI_FILES]]);
});

test('pages no reader can handle are explained, not injected into', async () => {
  const { controller, scripts, badges } = setup();
  for (const url of ['about:blank', 'https://duunitori.fi/tyopaikat?haku=go']) {
    const result = await controller.scanTab(4, url);
    assert.equal(result.ok, false);
    const state = await controller.getState(4, undefined);
    assert.equal(state.status, 'unreadable');
    assert.equal(state.error, WHY[readerFor(url).why]);
  }
  assert.equal(scripts.length, 0);
  assert.equal(badges.at(-1)[1], '?');
});

// --- controller: low confidence and corrections -----------------------------------------------

test('a page that does not look like a job ad is not scored on its own, but can be on request', async () => {
  const { controller, backend } = setup();
  await controller.onAdViewed(1, generic({}, { confidence: 'low' }));
  assert.equal(backend.named('scorePreview').length, 0);
  const state = await controller.getState(1, GENERIC_URL);
  assert.deepEqual([state.status, state.why], ['idle', 'low-confidence']);
  await controller.rescore(1, { force: false }); // "Score anyway"
  assert.equal(backend.named('scorePreview').length, 1);
  assert.equal((await controller.getState(1, GENERIC_URL)).status, 'scored');
});

test('medium confidence and above are scored as usual', async () => {
  for (const confidence of ['medium', 'high']) {
    const { controller, backend } = setup();
    await controller.onAdViewed(1, generic({}, { confidence }));
    assert.equal(backend.named('scorePreview').length, 1, confidence);
  }
});

test('a missing company can be supplied, and then the ad is scored', async () => {
  const { controller, backend, badges } = setup();
  const cap = generic({}, { missing: ['company'], confidence: 'medium' });
  cap.job.company = '';
  await controller.onAdViewed(1, cap);
  assert.equal((await controller.getState(1, GENERIC_URL)).status, 'incomplete');
  assert.deepEqual(await controller.editCapture(1, { company: '  Northwind  ' }), { ok: true });
  const [, sent] = backend.named('scorePreview')[0];
  assert.equal(sent.company, 'Northwind');
  const state = await controller.getState(1, GENERIC_URL);
  assert.equal(state.status, 'scored');
  assert.deepEqual(state.capture.quality.missing, []);
  assert.equal(backend.named('update').length, 0, 'nothing stored yet, so nothing to correct');
  assert.equal(badges.at(-1)[1], '82');
});

test('correcting a guessed title after scoring updates the stored record and keeps the score', async () => {
  const { controller, backend } = setup();
  await controller.onAdViewed(1, generic({}, { guessed: ['title', 'company'], confidence: 'medium' }));
  assert.equal(backend.named('scorePreview').length, 1);
  await controller.editCapture(1, { title: 'Platform Engineer', company: 'Northwind' });
  assert.deepEqual(backend.named('update')[0], ['update', 1, { title: 'Platform Engineer', company: 'Northwind' }]);
  assert.equal(backend.named('scorePreview').length, 1, 'the text did not change, so it is not scored again');
  const state = await controller.getState(1, GENERIC_URL);
  assert.equal(state.status, 'scored');
  assert.deepEqual(state.capture.quality.guessed, []);
  assert.equal(state.capture.job.title, 'Platform Engineer');
});

test('an unchanged or empty correction does nothing; a decided ad cannot be edited here', async () => {
  const { controller, backend } = setup();
  await controller.onAdViewed(1, generic({}, { guessed: ['company'] }));
  assert.deepEqual(await controller.editCapture(1, { company: '   ', title: capture().job.title }), { ok: true, unchanged: true });
  assert.equal(backend.named('update').length, 0);
  await controller.perform(1, 'save');
  const result = await controller.editCapture(1, { company: 'Other' });
  assert.equal(result.ok, false);
  assert.match(result.error, /web app/);
  assert.equal(await controller.editCapture(9, { company: 'x' }).then((r) => r.ok), false);
});

test('if the stored record cannot be corrected, the edit is not applied and the reason is shown', async () => {
  const backend = fakeBackend({ update: async () => { throw refused('bad field'); } });
  const { controller } = setup({ backend });
  await controller.onAdViewed(1, generic({}, { guessed: ['company'], confidence: 'medium' }));
  const result = await controller.editCapture(1, { company: 'Northwind' });
  assert.equal(result.ok, false);
  const state = await controller.getState(1, GENERIC_URL);
  assert.match(state.notice, /Could not update the stored record: bad field/);
  assert.equal(state.capture.job.company, 'Acme Oy', 'the capture keeps the old value');
});

test('saving after a correction sends the corrected values', async () => {
  const { controller, backend } = setup();
  await controller.onAdViewed(1, generic({}, { guessed: ['company'], confidence: 'medium' }));
  await controller.editCapture(1, { company: 'Northwind' });
  await controller.perform(1, 'save');
  assert.equal(backend.named('save')[0][1].company, 'Northwind');
});

test('perform says when there is nothing read in the tab yet', async () => {
  const { controller } = setup();
  assert.deepEqual(await controller.perform(3, 'save'), { ok: false, noAd: true, error: 'No job ad in this tab.' });
});

// --- popup view -------------------------------------------------------------------------------

test('popup: unknown site, reading, and giving up', () => {
  const unknown = viewFor(null, GENERIC_URL);
  assert.equal(unknown.kind, 'unknown-page');
  assert.deepEqual(unknown.actions.map((a) => a.id), ['scan-tab']);
  assert.equal(unknown.actions[0].label, 'Read this page');
  assert.match(unknown.message, /select the ad text/);
  const reading = viewFor(null, GENERIC_URL, { reading: true });
  assert.deepEqual([reading.kind, reading.message, reading.actions], ['waiting', 'Reading the page…', []]);
  const gaveUp = viewFor(null, GENERIC_URL, { reading: true, gaveUp: true });
  assert.deepEqual(gaveUp.actions.map((a) => a.label), ['Try again']);
  assert.doesNotMatch(gaveUp.message, /about:addons/, 'the Firefox permission advice is for Duunitori only');
});

test('popup: hints say what the reader was unsure about', () => {
  const base = { status: 'scored', url: GENERIC_URL, preview: preview() };
  const hints = (quality) => viewFor({ ...base, capture: generic({}, quality) }, GENERIC_URL).hints;
  assert.deepEqual(hints({}), []);
  assert.deepEqual(hints({ confidence: 'low' }), ['This page does not look much like a job ad.']);
  assert.deepEqual(hints({ ambiguous: true }), ['This page lists several jobs. Check this is the right one.']);
  assert.deepEqual(hints({ guessed: ['company', 'descriptionSnippet'] }), ['Guessed from the page, not stated by it: company, description. Check before saving.']);
});

test('popup: the correction form appears only while title or company is a guess or missing, and not after a decision', () => {
  const base = { status: 'scored', url: GENERIC_URL, preview: preview() };
  const edit = (quality, extra = {}) => viewFor({ ...base, capture: generic({}, quality), ...extra }, GENERIC_URL).edit;
  assert.equal(edit({}), null);
  assert.equal(edit({ guessed: ['descriptionSnippet'] }), null, 'a guessed description is fixed by selecting text, not by typing');
  assert.deepEqual(edit({ guessed: ['company'] }), { title: 'Backend Developer', company: 'Acme Oy' });
  assert.notEqual(edit({ missing: ['company'] }), null);
  assert.equal(edit({ guessed: ['company'] }, { decision: { action: 'save', previous: 'seen' } }), null);
});

test('popup: a low-confidence page offers "Score anyway", and an unscored page that is merely off says so', () => {
  const idle = (why) => viewFor({ status: 'idle', url: GENERIC_URL, why, capture: generic({}, why === 'low-confidence' ? { confidence: 'low' } : {}) }, GENERIC_URL);
  const low = idle('low-confidence');
  assert.match(low.message, /does not look much like a job ad, so it was not scored/);
  assert.equal(low.actions[0].label, 'Score anyway');
  assert.equal(low.actions[0].id, 'score-now');
  const off = idle('autoscore-off');
  assert.equal(off.message, 'Auto-scoring is off.');
  assert.equal(off.actions[0].label, 'Score this ad');
});

test('popup: an incomplete read tells you to select the text when the description is what is missing', () => {
  const view = viewFor({ status: 'incomplete', url: GENERIC_URL, capture: generic({}, { missing: ['descriptionSnippet'] }) }, GENERIC_URL);
  assert.ok(view.hints.includes('Select the ad text on the page and read it again.'));
});

// --- backend client ---------------------------------------------------------------------------

test('client call to correct a stored record', async () => {
  const calls = [];
  const backend = createBackend({ getBaseUrl: async () => 'http://jobs.test', fetchFn: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({}) }; } });
  await backend.update(7, { company: 'Northwind' });
  assert.equal(calls[0].url, 'http://jobs.test/api/jobs/7');
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].init.body), { company: 'Northwind' });
});
