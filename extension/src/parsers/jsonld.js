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
