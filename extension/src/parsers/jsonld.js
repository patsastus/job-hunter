// Classic script: content scripts cannot be ES modules, so this attaches to a shared JH namespace
// and the manifest loads the parser files in order.
(function (root) {
  const JH = (root.JH = root.JH || {});

  function findJobPosting(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findJobPosting(item);
        if (found) return found;
      }
      return null;
    }
    const type = node['@type'];
    if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return node;
    return findJobPosting(node['@graph']);
  }

  // The schema.org JobPosting embedded in the page, or null.
  JH.parseJsonLd = function (doc) {
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const found = findJobPosting(JSON.parse(script.textContent));
        if (found) return found;
      } catch (e) {
        // A malformed block on the page shouldn't stop us reading the others.
      }
    }
    return null;
  };

  function collectJobPostings(node, out) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      node.forEach((n) => collectJobPostings(n, out));
      return out;
    }
    const type = node['@type'];
    if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) out.push(node);
    collectJobPostings(node['@graph'], out);
    collectJobPostings(node.itemListElement, out); // listing pages wrap postings in an ItemList
    collectJobPostings(node.item, out);
    return out;
  }

  // Every JobPosting on the page (a careers index can list many), in document order.
  JH.parseAllJsonLd = function (doc) {
    const out = [];
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        collectJobPostings(JSON.parse(script.textContent), out);
      } catch (e) {
        // skip malformed JSON
      }
    }
    return out;
  };

  // Small helpers for readers: real pages give a string, an array, an object or nothing for the same field.
  JH.util = {
    first: (value) => (Array.isArray(value) ? value[0] : value),
    str: (value) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''),
    attempt(fn, fallback = '') {
      try {
        const value = fn();
        return value == null ? fallback : value;
      } catch (e) {
        return fallback;
      }
    },
    // True when `value` (ISO date or datetime) is before now. A bare date means "valid through that day".
    isPast(value, now) {
      if (!value) return false;
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value < now.toISOString().slice(0, 10);
      const t = Date.parse(value);
      return !Number.isNaN(t) && t < now.getTime();
    },
  };

  // HTML (as found in JSON-LD descriptions) to readable text, keeping paragraph and list breaks.
  // DOMParser makes an inert document, so images and scripts in the ad are never loaded or run.
  JH.htmlToText = function (html, doc) {
    const withBreaks = String(html || '')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|ul|ol|h[1-6])\s*>/gi, '\n\n')
      .replace(/<\/li\s*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ');
    const Parser = (doc.defaultView && doc.defaultView.DOMParser) || root.DOMParser;
    const body = new Parser().parseFromString(withBreaks, 'text/html').body;
    for (const el of body.querySelectorAll('script, style, noscript, template')) el.remove(); // not visible text
    const text = body.textContent || '';
    return text
      .replace(/ /g, ' ')
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };
})(globalThis);
