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
  const strip = ({ background, browser_specific_settings, ...rest }) => rest;
  assert.deepEqual(strip(chrome), strip(firefox));
});

test('permissions stay minimal: storage, plus the backend and Duunitori ad pages', async () => {
  const m = await buildManifest('chrome');
  assert.deepEqual(m.permissions, ['storage']);
  assert.deepEqual(m.host_permissions, ['http://jobs.test/*']);
  for (const cs of m.content_scripts) for (const pattern of cs.matches) assert.match(pattern, /duunitori\.fi\/tyopaikat\/tyo\/\*$/);
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
