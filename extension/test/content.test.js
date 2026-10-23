import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, pageWith, PARSERS } from './helpers.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const contentScript = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'content', 'duunitori.js'), 'utf8');

function run({ url, visibility = 'visible' }) {
  const sent = [];
  const win = pageWith(fixture('duunitori-ad.html'), {
    url,
    scripts: PARSERS,
    globals: { chrome: { runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve(); } } } },
  });
  Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => visibility });
  win.eval(contentScript);
  return { win, sent };
}

const AD = 'https://duunitori.fi/tyopaikat/tyo/backend-developer-acme-123';

test('reports the ad straight away when the tab is visible', () => {
  const { sent } = run({ url: AD });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'ad-viewed');
  assert.equal(sent[0].capture.job.title, 'Backend Developer');
  assert.equal(sent[0].capture.job.url, AD);
});

test('waits in a background tab, and reports once when the tab becomes visible', () => {
  let visibility = 'hidden';
  const sent = [];
  const win = pageWith(fixture('duunitori-ad.html'), {
    url: AD,
    scripts: PARSERS,
    globals: { chrome: { runtime: { sendMessage: (m) => { sent.push(m); } } } },
  });
  Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => visibility });
  win.eval(contentScript);
  assert.equal(sent.length, 0);
  win.document.dispatchEvent(new win.Event('visibilitychange'));
  assert.equal(sent.length, 0, 'still hidden');
  visibility = 'visible';
  win.document.dispatchEvent(new win.Event('visibilitychange'));
  win.document.dispatchEvent(new win.Event('visibilitychange'));
  assert.equal(sent.length, 1);
});

test('ignores action URLs under an ad, and non-ad paths', () => {
  assert.equal(run({ url: AD + '/lisaa_suosikkeihin' }).sent.length, 0);
  assert.equal(run({ url: 'https://duunitori.fi/tyopaikat/tyo/' }).sent.length, 0);
});

test('a missing background listener does not throw', () => {
  const win = pageWith(fixture('duunitori-ad.html'), {
    url: AD,
    scripts: PARSERS,
    globals: { chrome: { runtime: { sendMessage: () => Promise.reject(new Error('no receiver')) } } },
  });
  Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => 'visible' });
  assert.doesNotThrow(() => win.eval(contentScript));
});
