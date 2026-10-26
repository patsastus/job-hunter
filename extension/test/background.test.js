// Loads the real background.js against a fake browser, to check the wiring the controller tests can't see:
// listeners registered at the top level, message routing, shortcuts, alarms.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capture, preview, URL1 } from './fakes.js';

const listeners = {};
const on = (name) => ({ addListener: (fn) => { (listeners[name] ||= []).push(fn); } });
const memory = () => {
  const m = new Map();
  return {
    get: async (key) => (m.has(key) ? { [key]: m.get(key) } : {}),
    set: async (obj) => Object.entries(obj).forEach(([k, v]) => m.set(k, v)),
    remove: async (key) => { m.delete(key); },
  };
};
const badges = [];
const alarmLog = { created: [], cleared: [] };
let activeTabs = [{ id: 4 }];

globalThis.chrome = {
  runtime: { onMessage: on('message'), onStartup: on('startup') },
  tabs: { onRemoved: on('tabRemoved'), query: async () => activeTabs },
  commands: { onCommand: on('command') },
  alarms: {
    onAlarm: on('alarm'),
    create: async (...args) => { alarmLog.created.push(args); },
    clear: async (name) => { alarmLog.cleared.push(name); },
  },
  storage: { local: memory(), session: memory() },
  action: {
    setBadgeText: async ({ tabId, text }) => { badges.push([tabId, text]); },
    setBadgeBackgroundColor: async () => {},
  },
};

const injected = [];
globalThis.chrome.scripting = { executeScript: async (details) => { injected.push(details); } };

const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
  const sent = init.body ? JSON.parse(init.body) : {};
  const body = url.endsWith('/api/jobs/lookup') ? (sent.urls || []).map((u) => ({ url: u, status: u.endsWith('-1') ? 'saved' : null, fit_score: u.endsWith('-1') ? 80 : null })) : url.endsWith('/api/jobs') ? { id: 1, status: 'saved' } : url.includes('/api/jobs/') ? { id: 1, status: sent.status } : preview();
  return { ok: true, status: 200, json: async () => body };
};

// Registration must happen while the module loads: a stopped worker is woken by the event, and only
// listeners added at the top level are there to receive it.
const registeredAtLoad = await import('../src/background.js').then(() => Object.fromEntries(Object.entries(listeners).map(([k, v]) => [k, v.length])));

const send = (message, sender = { tab: { id: 4 } }) =>
  new Promise((resolve) => {
    const keepOpen = listeners.message[0](message, sender, resolve);
    assert.equal(keepOpen, true, 'onMessage must return true to answer asynchronously');
  });

test('every listener is registered synchronously when the worker starts', () => {
  assert.deepEqual(registeredAtLoad, { message: 1, tabRemoved: 1, command: 1, alarm: 1, startup: 1 });
});

test('an ad-viewed message from a tab is scored, and the popup can read the state', async () => {
  await send({ type: 'ad-viewed', capture: capture() });
  assert.equal(requests.at(-1).url, 'http://jobs.test/api/score-preview');
  assert.equal(badges.at(-1)[1], '82');
  const state = await send({ type: 'get-state', tabId: 4, url: URL1 }, {});
  assert.equal(state.status, 'scored');
  assert.equal(await send({ type: 'get-state', tabId: 4 }, {}).then((s) => s.status), 'scored', 'works without a url');
});

test('ad-viewed with no sending tab, and unknown message types, are ignored', async () => {
  const before = requests.length;
  assert.equal(await send({ type: 'ad-viewed', capture: capture() }, {}), null);
  assert.equal(await send({ type: 'nonsense' }), null);
  assert.equal(requests.length, before);
});

test('save, reject and undo messages reach the backend', async () => {
  await send({ type: 'save', tabId: 4 }, {});
  assert.deepEqual([requests.at(-1).method, requests.at(-1).url, requests.at(-1).body.status], ['POST', 'http://jobs.test/api/jobs', 'saved']);
  await send({ type: 'undo', tabId: 4 }, {});
  assert.deepEqual([requests.at(-1).method, requests.at(-1).body], ['PATCH', { status: 'seen' }]);
  await send({ type: 'reject', tabId: 4 }, {});
  assert.deepEqual([requests.at(-1).method, requests.at(-1).body], ['PATCH', { status: 'rejected' }]);
});

test('the shortcuts act on the active tab; unknown commands are ignored', async () => {
  await send({ type: 'undo', tabId: 4 }, {}); // back to a seen ad
  const before = requests.length;
  await listeners.command[0]('save-job');
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1).url, 'http://jobs.test/api/jobs');
  await listeners.command[0]('something-else');
  assert.equal(requests.length, before + 1);
  activeTabs = [];
  await listeners.command[0]('reject-job'); // no active tab: nothing to do, no crash
  assert.equal(requests.length, before + 1);
});

test('the retry alarm and browser startup flush the queue; other alarms do not', async () => {
  const before = alarmLog.cleared.length;
  await listeners.alarm[0]({ name: 'something-else' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(alarmLog.cleared.length, before);
  await listeners.alarm[0]({ name: 'flush-queue' });
  await listeners.startup[0]();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(alarmLog.cleared.length > before, 'an empty queue clears the retry alarm');
});

test('closing a tab clears its state', async () => {
  await listeners.tabRemoved[0](4);
  assert.equal(await send({ type: 'get-state', tabId: 4 }, {}), null);
});

test('ad-error and scan-tab messages are routed', async () => {
  assert.equal(await send({ type: 'ad-error', url: URL1, error: 'boom' }, {}), null, 'ignored without a sending tab');
  await send({ type: 'ad-error', url: URL1, error: 'boom' }, { tab: { id: 6 } });
  const state = await send({ type: 'get-state', tabId: 6, url: URL1 }, {});
  assert.deepEqual([state.status, state.error], ['unreadable', 'boom']);
  assert.deepEqual(await send({ type: 'scan-tab', tabId: 6 }, {}), { ok: true });
  assert.deepEqual(injected.at(-1), { target: { tabId: 6 }, files: ['parsers/jsonld.js', 'parsers/duunitori.js', 'content/duunitori.js'] });
});

test('a handler that throws is reported as a failure, which the popup can tell apart from a state', async () => {
  const reply = await send({ type: 'ad-viewed', capture: null }, { tab: { id: 8 } }); // capture.job on null
  assert.equal(typeof reply.failure, 'string');
  assert.equal('error' in reply, false, 'states such as "offline" use `error`; the failure envelope must not');
});

test('the save shortcut on a tab with nothing read yet reads it with the reader for that address, instead of saving blind', async () => {
  const run = async (tab) => {
    activeTabs = [tab];
    const before = injected.length;
    const requestsBefore = requests.length;
    await listeners.command[0]('save-job');
    return { files: injected.slice(before).map((i) => [i.target.tabId, i.files]), requests: requests.length - requestsBefore };
  };
  const generic = await run({ id: 21, url: 'https://careers.northwind.example/jobs/101' });
  assert.deepEqual(generic.files, [[21, ['parsers/jsonld.js', 'parsers/generic.js', 'content/generic.js']]]);
  assert.equal(generic.requests, 0, 'no save request: the first press only reads');
  const ad = await run({ id: 22, url: 'https://duunitori.fi/tyopaikat/tyo/dev-1' });
  assert.deepEqual(ad.files, [[22, ['parsers/jsonld.js', 'parsers/duunitori.js', 'content/duunitori.js']]]);
  const blank = await run({ id: 23, url: 'about:blank' });
  assert.deepEqual(blank.files, [], 'nothing is injected into pages that cannot be read');
});

test('list pages ask which ads are known: answered for a tab, capped at 200, ignored without a sending tab', async () => {
  const urls = ['https://duunitori.fi/tyopaikat/tyo/a-1', 'https://duunitori.fi/tyopaikat/tyo/b-2'];
  const reply = await send({ type: 'lookup', urls }, { tab: { id: 30 } });
  assert.deepEqual(reply.items.map((i) => [i.url, i.status]), [[urls[0], 'saved'], [urls[1], null]]);
  assert.deepEqual([requests.at(-1).method, requests.at(-1).url], ['POST', 'http://jobs.test/api/jobs/lookup']);
  const many = Array.from({ length: 250 }, (_, i) => `https://duunitori.fi/tyopaikat/tyo/ad-${i}`);
  await send({ type: 'lookup', urls: many }, { tab: { id: 30 } });
  assert.equal(requests.at(-1).body.urls.length, 200);
  const before = requests.length;
  assert.equal(await send({ type: 'lookup', urls }, {}), null);
  assert.equal(await send({ type: 'lookup', urls: 'nope' }, { tab: { id: 30 } }), null);
  assert.deepEqual(await send({ type: 'lookup', urls: [] }, { tab: { id: 30 } }), { items: [] });
  assert.equal(requests.length, before, 'nothing is sent for those');
});
