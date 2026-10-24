// Classic script injected on request into a page the extension has no dedicated reader for (popup button or
// shortcut, never automatically). Reads the page once and reports it to the background worker.
(function () {
  const api = globalThis.browser || globalThis.chrome;
  const send = (message) => {
    const pending = api.runtime.sendMessage(message);
    if (pending && pending.catch) pending.catch(() => {}); // background not ready: nothing to do
  };

  try {
    send({ type: 'ad-viewed', capture: JH.parseGeneric(document, location.href) });
  } catch (e) {
    console.error('[Job Hunter] could not read this page', e);
    send({ type: 'ad-error', url: location.href, error: String((e && e.message) || e) });
  }
})();
