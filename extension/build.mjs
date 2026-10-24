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
    // Firefox's default policy for Manifest V3 extension pages includes `upgrade-insecure-requests`, which silently
    // rewrites every http:// request the extension makes to https:// (loopback addresses are exempt, host names are
    // not). The backend is plain http on a local host name (http://jobs.test), so the upgraded request hits a TLS
    // handshake it cannot complete and fails with an opaque "NetworkError". Stating the policy explicitly, without that
    // directive, restores plain-http requests. Chrome's default has no such directive, so it needs nothing.
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self';" },
    // Firefox puts a new extension's button in the puzzle-piece menu unless it asks for the toolbar. Firefox-only
    // key (Chrome would warn about it); it only decides the default for a fresh install, so a button the user has
    // already moved or unpinned stays where they put it.
    action: { default_area: 'navbar' },
  },
};

export async function buildManifest(target) {
  const base = JSON.parse(await readFile(join(root, 'manifest.base.json'), 'utf8'));
  const { action, ...overrides } = TARGETS[target];
  // `action` is merged key by key so the per-browser part adds to the popup settings instead of replacing them.
  return { ...base, ...overrides, action: { ...base.action, ...action } };
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
