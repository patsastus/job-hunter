import { BackendError } from '../src/lib/api.js';
import { createController, createStore } from '../src/lib/controller.js';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';
import { createQueue } from '../src/lib/queue.js';

export const URL1 = 'https://duunitori.fi/tyopaikat/tyo/backend-1';

export const capture = ({ missing = [], expired = false, url = URL1 } = {}) => ({
  job: {
    title: 'Backend Developer', company: 'Acme Oy', location: 'Helsinki', url,
    descriptionSnippet: 'We build things.', raw: { site: 'duunitori', jsonld: { title: 'Backend Developer' } },
  },
  quality: { missing },
  expired,
});

export const preview = (over = {}) => ({ id: 1, status: 'seen', fit_score: 82, fit_reason: 'Good Go match.', cached: false, created: true, ...over });

export const unreachable = () => new BackendError('offline', 'Cannot reach the backend at http://jobs.test.');
export const refused = (message = 'rejected', status = 422) => new BackendError('http', message, status);

// A backend that records every call. Pass functions in `over` to change what a call does.
export function fakeBackend(over = {}) {
  const calls = [];
  const record = (name, impl) => async (...args) => {
    calls.push([name, ...args]);
    return impl(...args);
  };
  const backend = {
    scorePreview: record('scorePreview', over.scorePreview || (async () => preview())),
    recordSeen: record('recordSeen', over.recordSeen || (async () => preview({ id: 7, fit_score: null, fit_reason: null }))),
    save: record('save', over.save || (async () => ({ id: 1, status: 'saved', fit_score: 82, fit_reason: 'Good Go match.' }))),
    setStatus: record('setStatus', over.setStatus || (async (id, status) => ({ id, status, fit_score: 82, fit_reason: 'Good Go match.' }))),
  };
  backend.calls = calls;
  backend.named = (name) => calls.filter((c) => c[0] === name);
  return backend;
}

export function setup({ settings = {}, backend = fakeBackend() } = {}) {
  const badges = []; // [tabId, text] in call order
  const session = new Map();
  const local = new Map();
  const alarms = { created: [], cleared: [] };
  const area = (map) => ({
    get: async (key) => (map.has(key) ? { [key]: map.get(key) } : {}),
    set: async (obj) => Object.entries(obj).forEach(([k, v]) => map.set(k, v)),
    remove: async (key) => { map.delete(key); },
  });
  const api = {
    action: {
      setBadgeText: async ({ tabId, text }) => { badges.push([tabId, text]); },
      setBadgeBackgroundColor: async () => {},
    },
    alarms: {
      create: async (name, info) => { alarms.created.push([name, info]); },
      clear: async (name) => { alarms.cleared.push(name); },
    },
  };
  const queue = createQueue(area(local));
  const controller = createController({
    api, backend, queue, store: createStore(area(session)),
    getSettings: async () => ({ ...DEFAULT_SETTINGS, ...settings }),
  });
  return { controller, backend, queue, badges, session, local, alarms, calls: backend.calls };
}
