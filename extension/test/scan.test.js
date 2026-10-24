import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { badgeFor } from '../src/lib/badge.js';
import { CONTENT_FILES } from '../src/lib/controller.js';
import { viewFor } from '../src/popup/view.js';
import { fixture, pageWith, PARSERS } from './helpers.js';
import { capture, setup, URL1 } from './fakes.js';

const plain = (v) => JSON.parse(JSON.stringify(v));
const parseWith = (ld, extraBody = '') => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', ...ld })}</script></head><body>${extraBody}</body></html>`;
  const win = pageWith(html, { scripts: PARSERS });
  return plain(win.JH.parseDuunitori(win.document, win.location.href, new Date('2026-10-24')));
};

// --- the parser must not lose a whole ad to one odd field --------------------------------------

test('awkward JSON-LD shapes cost only the field they affect', () => {
  const long = 'Describe the work. '.repeat(20);
  const { job, quality } = parseWith({
    title: 'Dev',
    hiringOrganization: [{ name: 'Acme Oy' }],            // an array instead of an object
    jobLocation: [{ address: 'Helsinki, Finland' }],        // a bare string instead of an address object
    employmentType: ['PART_TIME', 'FULL_TIME'],
    datePosted: 20260101,                                  // a number
    validThrough: { weird: true },                         // an object
    description: `<p>${long}</p>`,
  });
  assert.equal(job.title, 'Dev');
  assert.equal(job.company, 'Acme Oy');
  assert.equal(job.location, 'Helsinki, Finland');
  assert.equal(job.jobType, 'Osa-aikatyö');
  assert.equal(job.published, '20260101');
  assert.equal(job.deadline, '');
  assert.deepEqual(quality.missing, []);
});

test('non-string or missing description and title do not throw', () => {
  for (const ld of [{ description: { html: '<p>x</p>' } }, { description: ['a'] }, { title: { name: 'x' } }, { hiringOrganization: 'Acme' }, { jobLocation: 5 }, { jobLocation: [null] }, {}]) {
    const { job, quality } = parseWith(ld, '<h1>From the page</h1>');
    assert.equal(typeof job.title, 'string');
    assert.ok(Array.isArray(quality.missing));
  }
  assert.equal(parseWith({ title: { name: 'x' } }, '<h1>From the page</h1>').job.title, 'From the page');
});

test('a company name that is not a string used to crash the whole parse', () => {
  assert.equal(parseWith({ title: 'Dev', hiringOrganization: { name: 12345 } }).job.company, '12345');
  assert.equal(parseWith({ title: 'Dev', hiringOrganization: { name: { text: 'Acme' } } }).job.company, '');
});

test('a page with no JSON-LD at all still yields what the markup has', () => {
  const win = pageWith('<html><body><h1>Only a heading</h1></body></html>', { scripts: PARSERS });
  const result = plain(win.JH.parseDuunitori(win.document, win.location.href));
  assert.equal(result.job.title, 'Only a heading');
  assert.deepEqual(result.quality.missing, ['company', 'descriptionSnippet']);
});

// --- the content script reports failures --------------------------------------------------------

const contentScript = readFileSync(new URL('../src/content/duunitori.js', import.meta.url), 'utf8');

test('when reading the ad throws, the content script says why instead of staying silent', () => {
  const sent = [];
  const win = pageWith(fixture('duunitori-ad.html'), {
    url: 'https://duunitori.fi/tyopaikat/tyo/backend-developer-acme-123',
    scripts: PARSERS,
    globals: { chrome: { runtime: { sendMessage: (m) => { sent.push(m); } } } },
  });
  Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => 'visible' });
  win.JH.parseDuunitori = () => { throw new TypeError('Cannot read properties of null'); };
  win.console.error = () => {};
  win.eval(contentScript);
  assert.deepEqual(plain(sent), [{ type: 'ad-error', url: 'https://duunitori.fi/tyopaikat/tyo/backend-developer-acme-123', error: 'Cannot read properties of null' }]);
});

// --- controller ---------------------------------------------------------------------------------

test('an ad-error is kept as an "unreadable" state with a ? badge', async () => {
  const { controller, badges } = setup();
  await controller.onAdError(3, { url: URL1, error: 'boom' });
  const state = await controller.getState(3, URL1);
  assert.deepEqual([state.status, state.error], ['unreadable', 'boom']);
  assert.equal(badges.at(-1)[1], '?');
  assert.equal(badgeFor({ status: 'unreadable' }).text, '?');
});

test('scanTab injects the manifest scripts into that tab', async () => {
  const { controller, scripts } = setup();
  assert.deepEqual(await controller.scanTab(9), { ok: true });
  assert.deepEqual(scripts, [{ target: { tabId: 9 }, files: CONTENT_FILES }]);
});

test('scanTab failing is shown as the reason, not thrown', async () => {
  const { controller } = setup({ scriptingError: 'Missing host permission for the tab' });
  const result = await controller.scanTab(9);
  assert.deepEqual(result, { ok: false, error: 'Could not read the page: Missing host permission for the tab' });
  const state = await controller.getState(9, URL1);
  assert.equal(state.status, 'unreadable');
  assert.match(state.error, /Missing host permission/);
});

test('state still matches when the page adds a query string, a fragment or a trailing slash', async () => {
  const { controller } = setup();
  await controller.onAdViewed(1, capture());
  for (const url of [URL1 + '?utm_source=x', URL1 + '#hae', URL1 + '/', URL1 + '/?a=1#b']) {
    assert.ok(await controller.getState(1, url), url);
  }
  for (const url of ['https://duunitori.fi/tyopaikat/tyo/other-2', 'https://example.com/tyopaikat/tyo/backend-1']) {
    assert.equal(await controller.getState(1, url), null, url);
  }
});

// --- popup view ---------------------------------------------------------------------------------

test('popup view for unreadable and for waiting', () => {
  const unreadable = viewFor({ status: 'unreadable', url: URL1, error: 'boom' }, URL1);
  assert.equal(unreadable.message, 'Could not read this ad: boom');
  assert.deepEqual(unreadable.actions.map((a) => a.id), ['scan-tab']);
  assert.equal(unreadable.heading, undefined);
  assert.equal(viewFor({ status: 'unreadable', url: '', error: 'Could not read the page: nope' }, URL1).message, 'Could not read the page: nope');

  const waiting = viewFor(null, URL1);
  assert.equal(waiting.message, 'Reading the ad…');
  assert.deepEqual(waiting.actions, []);
  const gaveUp = viewFor(null, URL1, { gaveUp: true });
  assert.match(gaveUp.message, /about:addons/);
  assert.deepEqual(gaveUp.actions.map((a) => a.id), ['scan-tab']);
  assert.equal(viewFor(null, 'https://example.com/', { gaveUp: true }).kind, 'unknown-page', 'only a page the user asked to read can be "waiting"');
  assert.equal(viewFor(null, 'about:blank', { gaveUp: true }).kind, 'not-ad');
  assert.doesNotMatch(JSON.stringify(waiting), /[Rr]eload/, 'never asks for a reload: that closes the popup');
});

// --- the bug that hid every failure behind "reload this page" ----------------------------------

import { readReply } from '../src/popup/view.js';

test('states that carry their own `error` are states, not failed requests', () => {
  for (const status of ['offline', 'error', 'unreadable']) {
    const state = { status, url: URL1, error: 'Cannot reach the backend at http://jobs.test.', capture: capture() };
    assert.deepEqual(readReply(state), { state, failure: null }, status);
  }
  assert.deepEqual(readReply(null), { state: null, failure: null });
  assert.deepEqual(readReply(undefined), { state: null, failure: null });
  assert.deepEqual(readReply({ failure: 'TypeError: x' }), { state: null, failure: 'TypeError: x' });
});

test('the popup shows an offline ad as offline, with the real reason, never as "reload"', () => {
  const state = { status: 'offline', url: URL1, capture: capture(), error: 'Cannot reach the backend at http://jobs.test.' };
  const view = viewFor(readReply(state).state, URL1);
  assert.equal(view.kind, 'offline');
  assert.match(view.message, /Cannot reach the backend at http:\/\/jobs\.test\./);
  assert.match(view.message, /about:addons/);
  assert.doesNotMatch(view.message, /[Rr]eload/);
});
