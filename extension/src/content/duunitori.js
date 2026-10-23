// Classic script injected on Duunitori ad pages (see manifest). Parses the ad and reports it to the
// background worker once the tab is actually visible, so ads opened in background tabs are not scored
// until you look at them. Reads only; makes no requests of its own.
(function () {
  const api = globalThis.browser || globalThis.chrome;

  // Only the ad page itself, not action URLs such as /tyopaikat/tyo/<slug>/lisaa_suosikkeihin.
  if (!/^\/tyopaikat\/tyo\/[^/]+\/?$/.test(location.pathname)) return;

  function report() {
    const capture = JH.parseDuunitori(document, location.href);
    const pending = api.runtime.sendMessage({ type: 'ad-viewed', capture });
    if (pending && pending.catch) pending.catch(() => {}); // background not ready: nothing to do
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
