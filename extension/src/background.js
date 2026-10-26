// Background worker (a service worker in Chrome, an event page in Firefox). It can be stopped at any time,
// so it keeps no state in variables: see controller.js. Listeners must be registered at the top level.
import { api } from './lib/browser.js';
import { createBackend } from './lib/api.js';
import { createController, createStore, FLUSH_ALARM } from './lib/controller.js';
import { createQueue } from './lib/queue.js';
import { createSettings } from './lib/settings.js';

const settings = createSettings(api.storage.local);
const backend = createBackend({ getBaseUrl: async () => (await settings.get()).backendUrl });
const controller = createController({
  api,
  backend,
  store: createStore(api.storage.session),
  queue: createQueue(api.storage.local),
  getSettings: () => settings.get(),
});

async function handle(message, sender) {
  switch (message.type) {
    case 'ad-viewed':
      if (!sender.tab) return null;
      return controller.onAdViewed(sender.tab.id, message.capture);
    case 'ad-error':
      if (!sender.tab) return null;
      return controller.onAdError(sender.tab.id, { url: message.url, error: message.error });
    case 'lookup': {
      // Duunitori list pages ask which of the listed ads are already known. The backend caps one request at 200.
      if (!sender.tab || !Array.isArray(message.urls)) return null;
      const urls = message.urls.filter((u) => typeof u === 'string').slice(0, 200);
      return { items: urls.length ? await backend.lookup(urls) : [] };
    }
    case 'scan-tab':
      return controller.scanTab(message.tabId, message.url);
    case 'edit':
      return controller.editCapture(message.tabId, message.fields || {});
    case 'get-state':
      return controller.getState(message.tabId, message.url);
    case 'score-now':
      return controller.rescore(message.tabId, { force: false });
    case 'rescore':
      return controller.rescore(message.tabId, { force: true });
    case 'save':
    case 'reject':
      return controller.perform(message.tabId, message.type);
    case 'undo':
      return controller.undo(message.tabId);
    case 'flush':
      return controller.flushQueue();
    default:
      return null;
  }
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(
    (result) => sendResponse(result === undefined ? null : result),
    (error) => sendResponse({ failure: String(error) }), // not `error`: states such as "offline" carry that field
  );
  return true; // the response is sent asynchronously
});

api.tabs.onRemoved.addListener((tabId) => controller.onTabRemoved(tabId));

// Keyboard shortcuts (see "commands" in the manifest; the user can rebind them in the browser).
const SHORTCUT_ACTIONS = { 'save-job': 'save', 'reject-job': 'reject' };
api.commands.onCommand.addListener(async (command) => {
  const action = SHORTCUT_ACTIONS[command];
  if (!action) return;
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const result = await controller.perform(tab.id, action);
  // Nothing has been read in this tab yet: read it (and score it) instead of saving blind. A second press decides.
  if (result.noAd) await controller.scanTab(tab.id, tab.url);
});

// Send decisions that were made while the backend was unreachable.
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) controller.flushQueue();
});
api.runtime.onStartup.addListener(() => controller.flushQueue());
