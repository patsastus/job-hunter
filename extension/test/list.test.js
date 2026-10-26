import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture, pageWith } from './helpers.js';

const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'content', 'duunitori-list.js'), 'utf8');

const LIST = 'https://duunitori.fi/tyopaikat?haku=ohjelmoija';
const ACME = 'https://duunitori.fi/tyopaikat/tyo/backend-developer-acme-123';
const NIMBUS = 'https://duunitori.fi/tyopaikat/tyo/qa-engineer-nimbus-456';
const ORBIT = 'https://duunitori.fi/tyopaikat/tyo/data-engineer-orbit-789';
const ZENITH = 'https://duunitori.fi/tyopaikat/tyo/devops-zenith-321';

const plain = (x) => JSON.parse(JSON.stringify(x)); // arrays made inside the jsdom window are not the test's Array
const wait = (ms = 450) => new Promise((r) => setTimeout(r, ms)); // the script waits 300 ms for the page to settle

// `known` maps an ad URL to the backend's answer for it; `answer` can be replaced to simulate other backend states.
function run({ url = LIST, known = {}, visibility = 'visible', html = fixture('duunitori-list.html') } = {}) {
  const sent = [];
  const state = { known, answer: null };
  const win = pageWith(html, {
    url,
    globals: {
      chrome: {
        runtime: {
          sendMessage: (m) => {
            sent.push(m);
            if (state.answer) return state.answer(m);
            return Promise.resolve({ items: m.urls.map((u) => ({ url: u, ...(state.known[u] || {}) })) });
          },
        },
      },
    },
  });
  let vis = visibility;
  Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => vis });
  win.eval(script);
  return { win, sent, state, setVisibility: (v) => { vis = v; win.document.dispatchEvent(new win.Event('visibilitychange')); } };
}

const badges = (win) => [...win.document.querySelectorAll('[data-jh-badge]')];
const badgeAfter = (win, href) => {
  const a = [...win.document.querySelectorAll('a')].find((x) => x.getAttribute('href').startsWith(href) && x.textContent.trim());
  return a.nextElementSibling && a.nextElementSibling.hasAttribute('data-jh-badge') ? a.nextElementSibling.textContent : null;
};

test('asks once for each distinct ad (without query strings, action links or other sites) and marks the known ones', async () => {
  const { win, sent } = run({ known: { [ACME]: { status: 'saved', fit_score: 82 }, [ZENITH]: { status: 'rejected', fit_score: null } } });
  await wait();
  assert.equal(sent.length, 1);
  assert.deepEqual(plain(sent[0]), { type: 'lookup', urls: [ACME, NIMBUS, ORBIT, ZENITH] });
  assert.equal(badgeAfter(win, '/tyopaikat/tyo/backend-developer-acme-123'), 'Saved · 82');
  assert.equal(badgeAfter(win, '/tyopaikat/tyo/devops-zenith-321'), 'Rejected');
  assert.equal(badges(win).length, 2, 'unknown ads get no badge');
});

test('the badge goes next to the title link, not the logo link to the same ad', async () => {
  const { win } = run({ known: { [ACME]: { status: 'saved', fit_score: 82 } } });
  await wait();
  const logo = win.document.querySelector('a img').parentElement;
  assert.equal(logo.nextElementSibling.hasAttribute('data-jh-badge'), false);
  assert.equal(win.document.querySelector('h3 a').nextElementSibling.textContent, 'Saved · 82');
});

test('ads added later (the list loads more as you scroll) are looked up; ones already answered are not asked again', async () => {
  const { win, sent, state } = run();
  await wait();
  state.known[NEW] = { status: 'applied', fit_score: 71 };
  const more = win.document.createElement('article');
  more.innerHTML = `<h3><a href="/tyopaikat/tyo/new-ad-555">New ad</a></h3>`;
  win.document.getElementById('results').append(more);
  await wait();
  assert.equal(sent.length, 2);
  assert.deepEqual(plain(sent[1].urls), [NEW]);
  assert.equal(more.querySelector('a').nextElementSibling.textContent, 'Applied · 71');
});
const NEW = 'https://duunitori.fi/tyopaikat/tyo/new-ad-555';

test('does not loop: its own badges do not trigger new lookups', async () => {
  const { sent } = run({ known: { [ACME]: { status: 'saved', fit_score: 82 } } });
  await wait(900);
  assert.equal(sent.length, 1);
});

test('a backend that does not answer leaves the page untouched, and the next visit to the tab tries again', async () => {
  const { win, sent, state, setVisibility } = run();
  state.answer = () => Promise.resolve(null);
  await wait();
  assert.equal(badges(win).length, 0);
  state.answer = null;
  state.known[ACME] = { status: 'saved', fit_score: 90 };
  setVisibility('hidden');
  setVisibility('visible');
  await wait(50);
  assert.equal(badgeAfter(win, '/tyopaikat/tyo/backend-developer-acme-123'), 'Saved · 90');
  assert.ok(sent.length >= 2);
});

test('coming back to the tab refreshes the badges, so a decision made elsewhere shows', async () => {
  const { win, state, setVisibility } = run({ known: { [ACME]: { status: 'seen', fit_score: 60 } } });
  await wait();
  assert.equal(badgeAfter(win, '/tyopaikat/tyo/backend-developer-acme-123'), 'Seen · 60');
  state.known[ACME] = { status: 'saved', fit_score: 60 };
  state.known[ZENITH] = { status: 'applied', fit_score: null };
  setVisibility('hidden');
  setVisibility('visible');
  await wait(50);
  assert.equal(badgeAfter(win, '/tyopaikat/tyo/backend-developer-acme-123'), 'Saved · 60');
  assert.equal(badgeAfter(win, '/tyopaikat/tyo/devops-zenith-321'), 'Applied');
  delete state.known[ACME]; // removed from the database
  setVisibility('hidden');
  setVisibility('visible');
  await wait(50);
  assert.equal(badgeAfter(win, '/tyopaikat/tyo/backend-developer-acme-123'), null);
});

test('does nothing in a background tab until it is looked at', async () => {
  const { win, sent, setVisibility } = run({ visibility: 'hidden', known: { [ACME]: { status: 'saved', fit_score: 82 } } });
  await wait();
  assert.equal(sent.length, 0);
  setVisibility('visible');
  await wait(50);
  assert.equal(sent.length, 1);
  assert.equal(badges(win).length, 1);
});

test('leaves single ad pages to the ad reader', async () => {
  const { sent } = run({ url: ACME, known: {} });
  await wait();
  assert.equal(sent.length, 0);
});

test('a page with no ad links asks nothing', async () => {
  const { sent } = run({ html: '<html><body><a href="/yritykset/acme">Acme</a></body></html>' });
  await wait();
  assert.equal(sent.length, 0);
});

test('more than 200 ads are asked about in batches of 200', async () => {
  const links = Array.from({ length: 450 }, (_, i) => `<li><a href="/tyopaikat/tyo/ad-${i}">Ad ${i}</a></li>`).join('');
  const { sent } = run({ html: `<html><body><ul>${links}</ul></body></html>` });
  await wait();
  assert.deepEqual(sent.map((m) => m.urls.length), [200, 200, 50]);
});

test('a missing background listener does not throw', async () => {
  const win = pageWith(fixture('duunitori-list.html'), {
    url: LIST,
    globals: { chrome: { runtime: { sendMessage: () => Promise.reject(new Error('no receiver')) } } },
  });
  Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => 'visible' });
  assert.doesNotThrow(() => win.eval(script));
  await wait();
});
