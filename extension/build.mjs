// Builds one unpacked extension per browser from the same source: only the manifest differs.
// Usage: node build.mjs        (writes dist/chrome and dist/firefox)
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// What differs between the browsers: how the background code is declared, and Firefox's add-on ID.
export const TARGETS = {
  chrome: {
    background: { service_worker: 'background.js', type: 'module' },
  },
  firefox: {
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: { gecko: { id: 'job-hunter@nraatika.local', strict_min_version: '128.0' } },
  },
};

export async function buildManifest(target) {
  const base = JSON.parse(await readFile(join(root, 'manifest.base.json'), 'utf8'));
  return { ...base, ...TARGETS[target] };
}

export async function build(outRoot = join(root, 'dist')) {
  for (const target of Object.keys(TARGETS)) {
    const out = join(outRoot, target);
    await rm(out, { recursive: true, force: true });
    await cp(join(root, 'src'), out, { recursive: true });
    await writeFile(join(out, 'manifest.json'), JSON.stringify(await buildManifest(target), null, 2) + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build();
  console.log('Built dist/chrome and dist/firefox');
}
