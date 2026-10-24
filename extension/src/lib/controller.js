// The extension's logic, with the browser API, backend client, storage and queue injected so it runs in tests.
//
// Per-tab state lives in session storage (in memory, never written to disk) because the service worker
// can be stopped at any time and must not rely on variables. It holds the parsed ad text for the open tab
// and is removed when the tab closes. Only a save writes ad text anywhere durable (the backend, or the
// offline queue until it can be sent).
import { badgeFor } from './badge.js';
import { DUUNITORI_FILES, readerFor, WHY } from './sites.js';

// Without these there is nothing to score. The popup says what is missing.
const NEEDED_TO_SCORE = ['title', 'company', 'descriptionSnippet'];
// A save or reject needs to know which ad it is; the description can be absent.
const NEEDED_TO_DECIDE = ['title', 'company'];
export const FLUSH_ALARM = 'flush-queue';
// The scripts the manifest injects on ad pages, in order. scanTab() injects the same files on demand;
// a test checks this list against the manifest so the two cannot drift apart.
export const CONTENT_FILES = DUUNITORI_FILES;

const keyOf = (tabId) => `tab:${tabId}`;
// Same ad = same page address. The query string and fragment are ignored: a page can add tracking parameters or
// rewrite its own URL after the content script has read it, which must not make its state "not this page".
function samePage(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
  } catch (e) {
    return String(a).split('#')[0] === String(b).split('#')[0];
  }
}
const isUnreachable = (e) => e.kind === 'offline' || e.kind === 'timeout';
const normalise = (r) => ({ id: r.id, status: r.status, fit_score: r.fit_score ?? null, fit_reason: r.fit_reason ?? null });
// What a reject needs: which ad it was. No description, no raw capture.
const withoutText = ({ descriptionSnippet, raw, ...rest }) => rest;

// Carry out one decision against the backend. Also used to replay queued decisions.
export async function execute(backend, item) {
  if (item.type === 'save') return normalise(await backend.save(item.job));
  const id = item.id ?? (await backend.recordSeen(item.job)).id;
  return normalise(await backend.setStatus(id, 'rejected'));
}

function decided(state, result, action, previous) {
  const old = state.preview || {};
  return {
    ...state,
    status: 'scored',
    error: undefined,
    notice: undefined,
    preview: {
      ...old,
      id: result.id,
      status: result.status,
      fit_score: result.fit_score ?? old.fit_score ?? null,
      fit_reason: result.fit_reason ?? old.fit_reason ?? null,
      cached: true,
    },
    decision: { action, previous },
  };
}

export function createController({ api, backend, store, queue, getSettings }) {
  // Guards against an older request finishing after a newer one for the same tab (reload, new ad, a decision).
  const latest = new Map();
  let flushing = false;

  const bump = (tabId) => latest.set(tabId, (latest.get(tabId) || 0) + 1);

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
    bump(tabId);
    const seq = latest.get(tabId);
    await setState(tabId, { ...base, status: 'scoring' });
    let next;
    try {
      const preview = await backend.scorePreview(base.capture.job, { force });
      next = { ...base, status: 'scored', preview };
    } catch (e) {
      next = { ...base, status: e.kind === 'http' ? 'error' : 'offline', error: e.message };
    }
    if (latest.get(tabId) !== seq) return;
    await setState(tabId, next);
    if (next.status === 'scored') await flushQueue(); // the backend is reachable: send anything that was waiting
  }

  async function ensureFlushAlarm() {
    await api.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  }

  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      for (const item of await queue.all()) {
        try {
          const result = await execute(backend, item);
          await queue.remove(item.id);
          const state = await store.get(keyOf(item.tabId));
          if (state && state.status === 'queued' && state.url === item.url) {
            await setState(item.tabId, decided(state, result, item.type, item.previous));
          }
        } catch (e) {
          if (isUnreachable(e)) return; // still offline: the alarm will try again
          await queue.fail(item.id, e.message);
          const state = await store.get(keyOf(item.tabId));
          if (state && state.status === 'queued' && state.url === item.url) {
            await setState(item.tabId, { ...state, status: 'error', error: `Could not sync: ${e.message}` });
          }
        }
      }
    } finally {
      flushing = false;
      if ((await queue.size()) === 0) await api.alarms.clear(FLUSH_ALARM);
    }
  }

  // A reader found an ad in a visible tab (the Duunitori reader on its own, the generic one on request).
  async function viewed(tabId, capture) {
    const base = { url: capture.job.url, capture };
    bump(tabId); // cancels any request still running for this tab
    if (capture.expired) return setState(tabId, { ...base, status: 'expired' });
    if (NEEDED_TO_SCORE.some((field) => capture.quality.missing.includes(field))) {
      return setState(tabId, { ...base, status: 'incomplete' });
    }
    // A page that does not look like a job ad is not sent for scoring on its own: it would cost an LLM call and
    // leave a record for every stray page that was read. "Score anyway" in the popup goes ahead.
    if (capture.quality.confidence === 'low') return setState(tabId, { ...base, status: 'idle', why: 'low-confidence' });
    if (!(await getSettings()).autoScore) return setState(tabId, { ...base, status: 'idle', why: 'autoscore-off' });
    return score(tabId, base, { force: false });
  }

  return {
    flushQueue,

    // A reader found an ad in a visible tab.
    onAdViewed: viewed,

    // The content script could not read the ad. Keep the reason so the popup can show it.
    async onAdError(tabId, { url, error }) {
      bump(tabId);
      return setState(tabId, { url, status: 'unreadable', error });
    },

    // Read the ad in this tab now, by injecting the same scripts the manifest would have. Needs only the
    // access the browser grants when the popup is opened (activeTab), so it works even when the page was
    // loaded before the extension, or the browser did not inject the scripts for lack of site access.
    async scanTab(tabId, url) {
      // Without an address (the browser withheld it) keep the Duunitori reader: it is what the extension is for.
      const reader = url ? readerFor(url) : { kind: 'duunitori', files: DUUNITORI_FILES };
      if (!reader.kind) {
        const error = WHY[reader.why] || 'This page cannot be read.';
        await setState(tabId, { url: url || '', status: 'unreadable', error });
        return { ok: false, error };
      }
      try {
        await api.scripting.executeScript({ target: { tabId }, files: reader.files });
        return { ok: true };
      } catch (e) {
        const error = `Could not read the page: ${(e && e.message) || e}`;
        await setState(tabId, { url: '', status: 'unreadable', error });
        return { ok: false, error };
      }
    },

    // Score an ad that was parsed but not scored (auto-scoring off), or score it again.
    async rescore(tabId, { force }) {
      const state = await store.get(keyOf(tabId));
      if (!state) return { ok: false };
      const base = { url: state.url, capture: state.capture };
      if (state.decision) base.decision = state.decision; // a re-score does not undo a decision
      await score(tabId, base, { force });
      return { ok: true };
    },

    // Save or reject the ad in this tab.
    async perform(tabId, action) {
      const state = await store.get(keyOf(tabId));
      if (!state || !state.capture) return { ok: false, noAd: true, error: 'No job ad in this tab.' };
      const refuse = async (error) => {
        await setState(tabId, { ...state, notice: error });
        return { ok: false, error };
      };
      const { job, quality } = state.capture;
      const current = state.preview && state.preview.status;
      if (NEEDED_TO_DECIDE.some((field) => quality.missing.includes(field))) {
        return refuse('The ad could not be read completely, so it cannot be saved or rejected.');
      }
      // The backend lets a status be overwritten, so keep a stray keypress from clobbering real progress.
      if (current === 'applied') return refuse('This job is marked applied. Change that in the web app.');
      if ((action === 'save' && current === 'saved') || (action === 'reject' && current === 'rejected')) {
        return { ok: true, unchanged: true };
      }

      bump(tabId); // a score still in flight must not overwrite the decision when it arrives
      const previous = current || 'seen';
      const item = { type: action, url: job.url, tabId, id: state.preview && state.preview.id, job: action === 'save' ? job : withoutText(job) };
      await setState(tabId, { ...state, status: 'saving', notice: undefined });
      try {
        const result = await execute(backend, item);
        await setState(tabId, decided(state, result, action, previous));
        await flushQueue();
        return { ok: true };
      } catch (e) {
        if (isUnreachable(e)) {
          await queue.add({ ...item, previous });
          await ensureFlushAlarm();
          await setState(tabId, { ...state, status: 'queued', decision: { action, previous }, notice: undefined });
          return { ok: true, queued: true };
        }
        await setState(tabId, { ...state, status: 'error', error: e.message });
        return { ok: false, error: e.message };
      }
    },

    // Correct the title or company the reader guessed (or could not find). Stored records are corrected too.
    async editCapture(tabId, fields) {
      const state = await store.get(keyOf(tabId));
      if (!state || !state.capture) return { ok: false, error: 'Nothing to edit.' };
      if (state.decision) return { ok: false, error: 'Already decided: change it in the web app.' };
      const job = { ...state.capture.job };
      const quality = { ...state.capture.quality, missing: [...state.capture.quality.missing], guessed: [...(state.capture.quality.guessed || [])] };
      const changed = {};
      for (const key of ['title', 'company']) {
        const value = typeof fields[key] === 'string' ? fields[key].trim() : '';
        if (!value || value === job[key]) continue;
        job[key] = changed[key] = value;
        quality.missing = quality.missing.filter((m) => m !== key);
        quality.guessed = quality.guessed.filter((g) => g !== key);
      }
      if (!Object.keys(changed).length) return { ok: true, unchanged: true };
      const capture = { ...state.capture, job, quality };
      const id = state.preview && state.preview.id;
      if (id) {
        try {
          await backend.update(id, changed);
        } catch (e) {
          await setState(tabId, { ...state, notice: `Could not update the stored record: ${e.message}` });
          return { ok: false, error: e.message };
        }
      }
      // Already scored: the score came from the text, which did not change. Otherwise start the normal flow, which
      // may now be able to score (a missing company was what stopped it).
      if (state.status === 'scored' || state.status === 'saving') {
        await setState(tabId, { ...state, capture, notice: undefined });
      } else {
        await viewed(tabId, capture);
      }
      return { ok: true };
    },

    // Put the ad back to how it was before the last save or reject.
    async undo(tabId) {
      const state = await store.get(keyOf(tabId));
      if (!state || !state.decision || state.status !== 'scored') return { ok: false };
      try {
        const result = normalise(await backend.setStatus(state.preview.id, state.decision.previous));
        const { decision, ...rest } = state;
        await setState(tabId, { ...rest, notice: undefined, preview: { ...state.preview, status: result.status } });
        return { ok: true };
      } catch (e) {
        await setState(tabId, { ...state, notice: `Could not undo: ${e.message}` });
        return { ok: false, error: e.message };
      }
    },

    // Only returns state for the page the tab is on now. The url is optional: it is unavailable
    // when the browser withholds tab URLs from the extension.
    async getState(tabId, url) {
      const state = await store.get(keyOf(tabId));
      if (!state) return null;
      if (url && state.url && !samePage(state.url, url)) return null;
      return state.status === 'queued' ? { ...state, queueSize: await queue.size() } : state;
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
