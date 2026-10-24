import { api } from '../lib/browser.js';
import { createSettings } from '../lib/settings.js';
import { AD_URL, readReply, viewFor } from './view.js';

const settings = createSettings(api.storage.local);
const $ = (id) => document.getElementById(id);

// The keys the browser actually has bound (the user may have changed them), shown as button hints.
const SHORTCUT_OF = { save: 'save-job', reject: 'reject-job' };
let shortcuts = {};

// Ad text is untrusted: it is only ever put on the page with textContent, never as HTML.
function render(view) {
  $('ad').hidden = !view.heading;
  if (view.heading) {
    $('ad-title').textContent = view.heading.title;
    const parts = [view.heading.company, view.heading.location];
    if (view.heading.deadline) parts.push(`deadline ${view.heading.deadline.slice(0, 10)}`);
    $('ad-meta').textContent = parts.filter(Boolean).join(' · ');
  }

  $('banner').hidden = !view.banner;
  $('banner').textContent = view.banner || '';

  const hasScore = typeof view.score === 'number';
  $('result').hidden = !hasScore;
  $('score').hidden = !hasScore;
  if (hasScore) {
    $('score').textContent = String(Math.round(view.score));
    $('score').style.background = view.scoreColor;
    $('reason').textContent = view.reason || '';
  }

  $('message').textContent = view.message || '';
  $('notice').textContent = view.notice || '';
  const actions = $('actions');
  actions.replaceChildren();
  for (const action of view.actions || []) {
    const button = document.createElement('button');
    button.textContent = action.label;
    const key = shortcuts[SHORTCUT_OF[action.id]];
    if (key) button.title = key;
    button.addEventListener('click', async () => {
      button.disabled = true;
      const tab = await activeTab();
      if (action.id === 'scan-tab') {
        scanned = true; // this click is the scan
        waits = 0;
      }
      await api.runtime.sendMessage({ type: action.id, tabId: tab.id });
      polls = 0;
      refresh();
    });
    actions.append(button);
  }
}

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

let polls = 0;
let scanned = false; // asked the page to be read, once per popup
let waits = 0;
const WAIT_POLLS = 8; // about 6 s for the page to answer before saying so

async function refresh() {
  const tab = await activeTab();
  let reply;
  try {
    reply = readReply(await api.runtime.sendMessage({ type: 'get-state', tabId: tab.id, url: tab.url }));
  } catch (e) {
    reply = { state: null, failure: `The extension's background did not answer: ${(e && e.message) || e}` };
  }
  if (reply.failure) {
    render({ kind: 'failure', message: reply.failure, actions: [] });
    return;
  }
  const { state } = reply;

  // On an ad the extension has not read (opened before it was installed, or the browser did not run its
  // scripts): read it now instead of asking for a reload, which would close this popup.
  if (!state && AD_URL.test(tab.url || '')) {
    if (!scanned) {
      scanned = true;
      api.runtime.sendMessage({ type: 'scan-tab', tabId: tab.id }).catch(() => {});
    }
    const gaveUp = ++waits > WAIT_POLLS;
    render(viewFor(null, tab.url, { gaveUp }));
    if (!gaveUp) setTimeout(refresh, 750);
    return;
  }

  render(viewFor(state, tab.url));
  // Scoring and saving take a few seconds; keep looking until it settles (about 40 s at most).
  if (state && (state.status === 'scoring' || state.status === 'saving') && polls++ < 50) setTimeout(refresh, 800);
}

// Firefox treats host permissions as grantable by the user; until `jobs.test` is allowed, every request to the
// backend fails. Offer the grant. permissions.request() must run inside the click, so the origin is prepared early.
let backendOrigin = null;
async function offerAccess() {
  const { backendUrl } = await settings.get();
  const origin = `${new URL(backendUrl).origin}/*`;
  if (await api.permissions.contains({ origins: [origin] })) return;
  backendOrigin = origin;
  $('access').hidden = false;
  $('access-text').textContent = `Job Hunter needs your permission to reach ${new URL(backendUrl).host}.`;
  $('access-button').addEventListener('click', async () => {
    const granted = await api.permissions.request({ origins: [backendOrigin] }).catch(() => false);
    $('access').hidden = granted;
    if (granted) {
      polls = 0;
      refresh();
    }
  });
}

async function init() {
  try {
    shortcuts = Object.fromEntries((await api.commands.getAll()).map((c) => [c.name, c.shortcut]));
  } catch (e) {
    // Hints are optional.
  }
  const toggle = $('auto-score');
  toggle.checked = (await settings.get()).autoScore;
  toggle.addEventListener('change', () => settings.set({ autoScore: toggle.checked }));
  offerAccess().catch(() => {}); // optional; the rest works without it
  refresh();
}

init();
