import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { build, buildManifest } from '../build.mjs';

test('the two manifests differ only where the browsers differ', async () => {
  const chrome = await buildManifest('chrome');
  const firefox = await buildManifest('firefox');
  assert.deepEqual(chrome.background, { service_worker: 'background.js', type: 'module' });
  assert.deepEqual(firefox.background, { scripts: ['background.js'], type: 'module' });
  assert.equal(chrome.browser_specific_settings, undefined);
  assert.equal(firefox.browser_specific_settings.gecko.id, 'job-hunter@nraatika.local');
  const strip = ({ background, browser_specific_settings, content_security_policy, action, ...rest }) => rest;
  assert.deepEqual(strip(chrome), strip(firefox));
});

test('permissions stay minimal: what each feature needs, the backend, and Duunitori ad pages', async () => {
  const m = await buildManifest('chrome');
  // storage: settings, tab state, queue. activeTab: the tab URL when you open the popup or press a shortcut.
  // alarms: retry queued decisions. scripting: read the ad in the open tab on demand (scan-tab).
  assert.deepEqual(m.permissions, ['storage', 'activeTab', 'alarms', 'scripting']);
  assert.deepEqual(m.host_permissions, ['http://jobs.test/*']);
  // Ad pages get the reader; the list pages (/tyopaikat...) get the highlighter, which only asks the local backend.
  const [ads, lists] = m.content_scripts;
  for (const pattern of ads.matches) assert.match(pattern, /duunitori\.fi\/tyopaikat\/tyo\/\*$/);
  for (const pattern of lists.matches) assert.match(pattern, /^\*:\/\/(www\.)?duunitori\.fi\/tyopaikat\*$/);
  assert.deepEqual(lists.js, ['content/duunitori-list.js']);
  assert.equal(m.content_scripts.length, 2);
});

test('build writes both targets and every file the manifest names exists', async () => {
  const out = mkdtempSync(join(tmpdir(), 'jh-ext-'));
  await build(out);
  for (const target of ['chrome', 'firefox']) {
    const dir = join(out, target);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const files = [manifest.action.default_popup, ...manifest.content_scripts.flatMap((c) => c.js)];
    files.push(manifest.background.service_worker || manifest.background.scripts[0]);
    for (const file of files) assert.ok(existsSync(join(dir, file)), `${target}: ${file} is missing`);
    const popup = readFileSync(join(dir, manifest.action.default_popup), 'utf8');
    for (const ref of popup.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(existsSync(join(dir, 'popup', ref[1])), `${target}: popup references ${ref[1]}`);
  }
});

test('both shortcuts are declared, and the names match what the background worker handles', async () => {
  const m = await buildManifest('firefox');
  assert.deepEqual(Object.keys(m.commands), ['save-job', 'reject-job']);
  assert.equal(m.commands['save-job'].suggested_key.default, 'Alt+Shift+S');
  assert.equal(m.commands['reject-job'].suggested_key.default, 'Alt+Shift+X');
  const background = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  for (const name of Object.keys(m.commands)) assert.ok(background.includes(`'${name}'`), `${name} is not handled in background.js`);
});

test('the scripts scanTab() injects are exactly the ones the manifest injects', async () => {
  const { CONTENT_FILES } = await import('../src/lib/controller.js');
  const m = await buildManifest('chrome');
  assert.deepEqual(CONTENT_FILES, m.content_scripts[0].js);
});

test("Firefox's extension pages must not upgrade http:// requests (the backend is plain http on a host name)", async () => {
  const firefox = await buildManifest('firefox');
  const csp = firefox.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  // Chrome's default policy has no such directive, so the Chrome build states none.
  assert.equal((await buildManifest('chrome')).content_security_policy, undefined);
  assert.match((await import('node:fs')).readFileSync(new URL('../build.mjs', import.meta.url), 'utf8'), /upgrade-insecure-requests/, 'the reason is documented next to the setting');
});

test('Firefox asks for a toolbar button (not the puzzle-piece menu); Chrome gets no Firefox-only key', async () => {
  const firefox = await buildManifest('firefox');
  const chrome = await buildManifest('chrome');
  assert.equal(firefox.action.default_area, 'navbar');
  assert.equal(chrome.action.default_area, undefined);
  // The per-browser part must add to the action, not replace it.
  for (const m of [firefox, chrome]) {
    assert.equal(m.action.default_popup, 'popup/popup.html');
    assert.equal(m.action.default_title, 'Job Hunter');
  }
});
