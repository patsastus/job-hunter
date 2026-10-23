import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

// Run the extension's classic scripts in a page the way a browser runs content scripts: in the page's
// global scope, in manifest order, so they share the JH namespace.
export function pageWith(html, { url = 'https://duunitori.fi/tyopaikat/tyo/backend-developer-acme-123', scripts = [], globals = {} } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  Object.assign(dom.window, globals);
  for (const file of scripts) dom.window.eval(readFileSync(join(here, '..', 'src', file), 'utf8'));
  return dom.window;
}

export const PARSERS = ['parsers/jsonld.js', 'parsers/duunitori.js'];
