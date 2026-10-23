// Background worker (a service worker in Chrome, an event page in Firefox). It can be stopped at any time,
// so it keeps no state in variables: see controller.js. Listeners must be registered at the top level.
import { api } from './lib/browser.js';
import { createBackend } from './lib/api.js';
import { createController, createStore } from './lib/controller.js';
import { createSettings } from './lib/settings.js';

const settings = createSettings(api.storage.local);
const controller = createController({
  api,
  backend: createBackend({ getBaseUrl: async () => (await settings.get()).backendUrl }),
  store: createStore(api.storage.session),
  getSettings: () => settings.get(),
});

async function handle(message, sender) {
  switch (message.type) {
    case 'ad-viewed':
      if (!sender.tab) return null;
      return controller.onAdViewed(sender.tab.id, message.capture);
    case 'get-state':
      return controller.getState(message.tabId, message.url);
    case 'score-now':
      return controller.rescore(message.tabId, { force: false });
    case 'rescore':
      return controller.rescore(message.tabId, { force: true });
    default:
      return null;
  }
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(
    (result) => sendResponse(result === undefined ? null : result),
    (error) => sendResponse({ error: String(error) }),
  );
  return true; // the response is sent asynchronously
});

api.tabs.onRemoved.addListener((tabId) => controller.onTabRemoved(tabId));
