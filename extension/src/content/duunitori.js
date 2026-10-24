// Classic script injected on Duunitori ad pages (see manifest). Parses the ad and reports it to the
// background worker once the tab is actually visible, so ads opened in background tabs are not scored
// until you look at them. Reads only; makes no requests of its own.
(function () {
  const api = globalThis.browser || globalThis.chrome;

  // Only the ad page itself, not action URLs such as /tyopaikat/tyo/<slug>/lisaa_suosikkeihin.
  if (!/^\/tyopaikat\/tyo\/[^/]+\/?$/.test(location.pathname)) return;

  const send = (message) => {
    const pending = api.runtime.sendMessage(message);
    if (pending && pending.catch) pending.catch(() => {}); // background not ready: nothing to do
  };

  function report() {
    let capture;
    try {
      capture = JH.parseDuunitori(document, location.href);
    } catch (e) {
      // Tell the popup why instead of leaving it to guess; the page console has the stack.
      console.error('[Job Hunter] could not read this ad', e);
      send({ type: 'ad-error', url: location.href, error: String((e && e.message) || e) });
      return;
    }
    send({ type: 'ad-viewed', capture });
  }

  if (document.visibilityState === 'visible') {
    report();
  } else {
    document.addEventListener('visibilitychange', function onVisible() {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisible);
      report();
    });
  }
})();
