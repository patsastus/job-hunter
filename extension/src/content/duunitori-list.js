// Classic script injected on Duunitori pages that list ads (search results, regions). It marks the ads your database
// already knows with a small badge next to the title link. Reads the links of the page you have open and asks only
// your own backend about them (through the background worker); it opens nothing, follows nothing, makes no requests
// to Duunitori and stores nothing.
(function () {
  const api = globalThis.browser || globalThis.chrome;

  const AD_PATH = /^\/tyopaikat\/tyo\/[^/]+\/?$/;
  // A single ad page is read by content/duunitori.js, which already shows the state on the toolbar badge.
  if (AD_PATH.test(location.pathname)) return;

  const MARK = 'data-jh-badge';
  const SETTLE_MS = 300; // lists load more ads as you scroll; wait for the page to stop changing before asking
  const LABEL = { saved: 'Saved', applied: 'Applied', rejected: 'Rejected', seen: 'Seen', new: 'In inbox' };
  const COLOUR = { saved: '#1a7f37', applied: '#0b5cad', rejected: '#6b7280', seen: '#8a6d1d', new: '#6b7280' };

  const known = new Map(); // ad URL -> { status, fit_score } as the backend last said
  const asked = new Set(); // ad URLs the backend has already answered for

  const visible = () => document.visibilityState === 'visible';

  // One entry per distinct ad: the first link to it that has text (a logo link next to the title would otherwise
  // get the badge). Query strings are dropped: they are tracking, and the backend ignores them anyway.
  function adLinks() {
    const links = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      let u;
      try {
        u = new URL(a.href, location.href);
      } catch (e) {
        continue;
      }
      if (!/(^|\.)duunitori\.fi$/.test(u.hostname) || !AD_PATH.test(u.pathname)) continue;
      if (!a.textContent.trim()) continue;
      const url = u.origin + u.pathname;
      if (!links.has(url)) links.set(url, a);
    }
    return links;
  }

  function badgeFor(item) {
    const b = document.createElement('span');
    b.setAttribute(MARK, '');
    const score = item.fit_score == null ? '' : ` · ${item.fit_score}`;
    b.textContent = `${LABEL[item.status] || item.status}${score}`;
    b.title = `Job Hunter: ${item.status}${item.fit_score == null ? '' : `, score ${item.fit_score}`}`;
    Object.assign(b.style, {
      display: 'inline-block',
      margin: '0 0 0 .5em',
      padding: '.05em .5em',
      borderRadius: '.7em',
      background: COLOUR[item.status] || '#6b7280',
      color: '#fff',
      font: '600 .75rem/1.5 system-ui, sans-serif',
      verticalAlign: 'middle',
      whiteSpace: 'nowrap',
    });
    return b;
  }

  function render(links) {
    for (const [url, a] of links) {
      const item = known.get(url);
      const next = a.nextElementSibling;
      const current = next && next.hasAttribute(MARK) ? next : null;
      const wanted = item && item.status ? badgeFor(item) : null;
      // Leave an unchanged badge alone: every DOM change we make wakes the observer below, so redrawing would never settle.
      if (current && wanted && current.textContent === wanted.textContent) continue;
      if (current) current.remove();
      if (wanted) a.after(wanted);
    }
  }

  function send(message) {
    try {
      return Promise.resolve(api.runtime.sendMessage(message)).catch(() => null); // background not ready
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  async function lookup(urls) {
    for (let i = 0; i < urls.length; i += 200) {
      const chunk = urls.slice(i, i + 200);
      const res = await send({ type: 'lookup', urls: chunk });
      // Offline or not answering: leave these unasked, so the next scan (or coming back to the tab) tries again.
      if (!res || !Array.isArray(res.items)) return;
      for (const item of res.items) {
        asked.add(item.url);
        if (item.status) known.set(item.url, item);
        else known.delete(item.url);
      }
    }
  }

  let running = false;
  let again = false;

  // refresh: ask about every ad on the page again (a decision may have been made in another tab since).
  async function scan({ refresh = false } = {}) {
    if (!visible()) return;
    if (running) {
      again = again || refresh;
      return;
    }
    running = true;
    try {
      const links = adLinks();
      const urls = [...links.keys()].filter((u) => refresh || !asked.has(u));
      if (urls.length) await lookup(urls);
      render(links);
    } finally {
      running = false;
    }
    if (again) {
      again = false;
      scan({ refresh: true });
    }
  }

  let timer = null;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(scan, SETTLE_MS);
  };

  new MutationObserver(soon).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => scan({ refresh: true }));
  // Coming back to the list with the Back button restores the page from cache without running anything.
  window.addEventListener('pageshow', (e) => e.persisted && scan({ refresh: true }));
  scan();
})();
