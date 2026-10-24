// Which reader (set of page scripts) understands a page. Pure, so the popup, the background worker and the tests
// agree. Duunitori ad pages have a dedicated reader; any other http(s) page can be read once, on request, by the
// generic reader. Nothing is ever read automatically on an unknown site.

export const AD_URL = /^https?:\/\/(www\.)?duunitori\.fi\/tyopaikat\/tyo\/[^/?#]+\/?(?:[?#].*)?$/;

// The scripts each reader injects, in order. The Duunitori list must match the manifest's content script entry
// (a test checks this); the generic one is only ever injected on demand.
export const DUUNITORI_FILES = ['parsers/jsonld.js', 'parsers/duunitori.js', 'content/duunitori.js'];
export const GENERIC_FILES = ['parsers/jsonld.js', 'parsers/generic.js', 'content/generic.js'];

const DUUNITORI_HOST = /(^|\.)duunitori\.fi$/;

// -> { kind: 'duunitori' | 'generic', files } or { kind: null, why } when no reader applies.
export function readerFor(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return { kind: null, why: 'unknown-address' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: null, why: 'unsupported-page' };
  if (AD_URL.test(url)) return { kind: 'duunitori', files: DUUNITORI_FILES };
  // The rest of Duunitori (search results, company pages) is not an ad; the generic reader would only produce junk.
  if (DUUNITORI_HOST.test(u.hostname)) return { kind: null, why: 'duunitori-not-an-ad' };
  return { kind: 'generic', files: GENERIC_FILES };
}

export const WHY = {
  'unknown-address': "This page's address could not be read.",
  'unsupported-page': "Browser pages and files can't be read.",
  'duunitori-not-an-ad': 'Open a single Duunitori job ad (not a search or company page) to read it.',
};
