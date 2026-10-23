import { api } from '../lib/browser.js';
import { createSettings } from '../lib/settings.js';
import { viewFor } from './view.js';

const settings = createSettings(api.storage.local);
const $ = (id) => document.getElementById(id);

// Ad text is untrusted: it is only ever put on the page with textContent, never as HTML.
function render(view) {
  $('ad').hidden = !view.heading;
  if (view.heading) {
    $('ad-title').textContent = view.heading.title;
    const parts = [view.heading.company, view.heading.location];
    if (view.heading.deadline) parts.push(`deadline ${view.heading.deadline.slice(0, 10)}`);
    $('ad-meta').textContent = parts.filter(Boolean).join(' · ');
  }

  const hasScore = typeof view.score === 'number';
  $('result').hidden = !hasScore;
  $('score').hidden = !hasScore;
  if (hasScore) {
    $('score').textContent = String(Math.round(view.score));
    $('score').style.background = view.scoreColor;
    $('reason').textContent = [view.reason, view.status && view.status !== 'seen' ? `(${view.status})` : '']
      .filter(Boolean)
      .join(' ');
  }

  $('message').textContent = view.message || '';
  const actions = $('actions');
  actions.replaceChildren();
  for (const action of view.actions || []) {
    const button = document.createElement('button');
    button.textContent = action.label;
    button.addEventListener('click', async () => {
      button.disabled = true;
      const tab = await activeTab();
      await api.runtime.sendMessage({ type: action.id, tabId: tab.id });
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
async function refresh() {
  const tab = await activeTab();
  const state = await api.runtime.sendMessage({ type: 'get-state', tabId: tab.id, url: tab.url });
  render(viewFor(state && !state.error ? state : null, tab.url));
  // Scoring takes a few seconds; keep looking until it settles (about 40 s at most).
  if (state && state.status === 'scoring' && polls++ < 50) setTimeout(refresh, 800);
}

async function init() {
  const toggle = $('auto-score');
  toggle.checked = (await settings.get()).autoScore;
  toggle.addEventListener('change', () => settings.set({ autoScore: toggle.checked }));
  refresh();
}

init();
