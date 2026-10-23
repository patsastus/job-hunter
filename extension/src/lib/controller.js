// The extension's logic, with the browser API, backend client and storage injected so it runs in tests.
//
// Per-tab state lives in session storage (in memory, never written to disk) because the service worker
// can be stopped at any time and must not rely on variables. It holds the parsed ad text for the open tab
// and is removed when the tab closes.
import { badgeFor } from './badge.js';

// Without these there is nothing to score. The popup says what is missing.
const NEEDED_TO_SCORE = ['title', 'company', 'descriptionSnippet'];

const keyOf = (tabId) => `tab:${tabId}`;
const withoutHash = (url) => String(url || '').split('#')[0];

export function createController({ api, backend, store, getSettings }) {
  // Guards against an older request finishing after a newer one for the same tab (reload, new ad).
  const latest = new Map();

  async function setState(tabId, state) {
    await store.set(keyOf(tabId), state);
    const { text, color } = badgeFor(state);
    try {
      await api.action.setBadgeText({ tabId, text });
      await api.action.setBadgeBackgroundColor({ tabId, color });
    } catch (e) {
      // The tab was closed while we were working.
    }
  }

  async function score(tabId, base, { force }) {
    const seq = (latest.get(tabId) || 0) + 1;
    latest.set(tabId, seq);
    await setState(tabId, { ...base, status: 'scoring' });
    let next;
    try {
      const preview = await backend.scorePreview(base.capture.job, { force });
      next = { ...base, status: 'scored', preview };
    } catch (e) {
      next = { ...base, status: e.kind === 'http' ? 'error' : 'offline', error: e.message };
    }
    if (latest.get(tabId) === seq) await setState(tabId, next);
  }

  return {
    // The content script found an ad in a visible tab.
    async onAdViewed(tabId, capture) {
      const base = { url: capture.job.url, capture };
      latest.set(tabId, (latest.get(tabId) || 0) + 1); // cancels any score still running for this tab
      if (capture.expired) return setState(tabId, { ...base, status: 'expired' });
      if (NEEDED_TO_SCORE.some((field) => capture.quality.missing.includes(field))) {
        return setState(tabId, { ...base, status: 'incomplete' });
      }
      if (!(await getSettings()).autoScore) return setState(tabId, { ...base, status: 'idle' });
      return score(tabId, base, { force: false });
    },

    // Score an ad that was parsed but not scored (auto-scoring off), or score it again.
    async rescore(tabId, { force }) {
      const state = await store.get(keyOf(tabId));
      if (!state) return { ok: false };
      await score(tabId, { url: state.url, capture: state.capture }, { force });
      return { ok: true };
    },

    // Only returns state for the page the tab is on now, not a previous page in the same tab.
    async getState(tabId, url) {
      const state = await store.get(keyOf(tabId));
      return state && withoutHash(state.url) === withoutHash(url) ? state : null;
    },

    async onTabRemoved(tabId) {
      latest.delete(tabId);
      await store.remove(keyOf(tabId));
    },
  };
}

export function createStore(area) {
  return {
    async get(key) {
      return (await area.get(key))[key];
    },
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key),
  };
}
