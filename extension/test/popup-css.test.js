// The popup shows and hides parts with the `hidden` attribute. An author rule such as `#edit { display: grid }` beats
// the browser's built-in `[hidden] { display: none }`, so the form was always visible and an empty score box could
// show. popup.css therefore restates the rule with !important.
//
// This checks the stylesheet text, not the rendered result: jsdom does not implement specificity or !important, so it
// cannot tell the difference (it reports the broken and the fixed stylesheet alike as wrong). The rendered result was
// checked once in headless Chrome: before the fix `score` was inline-block and `edit` was grid; after, both are none.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../src/popup/popup.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');

test('popup.css makes the hidden attribute win over any display rule', () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('the elements that start hidden include ones whose own rules set display (so the rule above is needed)', () => {
  for (const id of ['edit', 'score']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*\\bhidden\\b`), `#${id} starts hidden`);
  }
  assert.match(css, /#edit\s*\{[^}]*display:/);
  assert.match(css, /\.score\s*\{[^}]*display:/);
});
