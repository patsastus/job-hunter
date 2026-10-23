# Job Hunter extension

Scores a Duunitori job ad against your profile as you read it, and shows the result on the toolbar badge
and in the popup. Design and constraints: [`docs/EXTENSION_DESIGN.md`](../docs/EXTENSION_DESIGN.md).

**Status: skeleton (build step 2).** Viewing an ad scores it. Saving, rejecting, the shortcuts, the offline
save queue, list highlighting, LinkedIn and the options page are not built yet.

It only acts on the page you have open, in a visible tab. It makes no requests to job sites. The ad text is
sent to your local backend (`http://jobs.test`) for scoring and is not kept there; the backend keeps a
`seen` record with the metadata, score and reason.

## Build and load

```sh
cd extension
npm install
npm run build        # writes dist/chrome and dist/firefox
```

- **Chrome / Chromium:** `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `dist/firefox/manifest.json`.
  Firefox asks for site access separately: if the badge shows `!`, check the add-on's permissions
  (about:addons → Job Hunter → Permissions) and allow `jobs.test`.

The backend must be running and reachable at `http://jobs.test` (change `backendUrl` in the extension's
storage until the options page exists).

## What you see

Open a Duunitori ad (`duunitori.fi/tyopaikat/tyo/<ad>`) in a tab you are looking at:

| Badge | Meaning |
|---|---|
| `…` | scoring |
| `82` | fit score (green ≥ 70, amber 40–69, red < 40) |
| `✓` `A` `✗` | already saved / applied / rejected |
| `–` | known, but no score (e.g. no API key) |
| `exp` | the ad has expired, not scored |
| `?` | the ad could not be read completely, not scored |
| `!` | backend unreachable or rejected the request |

The popup shows the ad, score and reason, a "Score again" button (re-scores, bypassing the cache) and a
switch for automatic scoring.

## Tests

```sh
npm test       # parsers, content script, controller, backend client, popup view, build output
npm run lint   # builds, then web-ext lint on the Firefox build
```

The Duunitori fixture is **synthetic** (hand-written to match the markup the parser expects). Replace it with
real snapshots once the extension can export them.

Verified so far: all unit tests; `web-ext lint` (0 errors; one notice about Firefox's upcoming
`data_collection_permissions` key, deliberately not set); an end-to-end run of the Chrome build in a real
Chrome (service worker, content script, messaging, badge, popup, retry and offline paths) against a stub
backend; Firefox 158 installs the build as a temporary add-on. **Not verified:** Firefox runtime behaviour, and
a hidden background tab in a real browser (headless Chrome reports every tab as visible; jsdom tests cover it).

## Layout

```
src/
  background.js          message routing; keeps no state in variables
  lib/                   browser.js (shim)  api.js (backend client)  controller.js  badge.js  settings.js
  parsers/               jsonld.js  duunitori.js      (classic scripts: content scripts cannot be ES modules)
  content/duunitori.js   runs on ad pages, reports once the tab is visible
  popup/                 popup.html/js/css  view.js (pure: decides what to show)
manifest.base.json       shared manifest; build.mjs adds the per-browser background and Firefox ID
```

## Debugging

- Chrome: `chrome://extensions` → Job Hunter → "service worker" opens its console. The worker stops when
  idle, which is normal.
- Firefox: `about:debugging` → Inspect on the extension.
- The popup's own console: right-click the popup → Inspect.
