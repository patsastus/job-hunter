# Job Hunter extension

Scores a Duunitori job ad against your profile as you read it, and shows the result on the toolbar badge
and in the popup. Design and constraints: [`docs/EXTENSION_DESIGN.md`](../docs/EXTENSION_DESIGN.md).

**Status: build steps 2 to 4.** Viewing an ad scores it; you can save it, reject it or undo, with keyboard
shortcuts, and decisions made while the backend is down are queued and sent later. List highlighting, LinkedIn,
a note field and the options page are not built yet.

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
| `✓` `A` `✗` | saved / applied / rejected (just now, or already) |
| `↻` | decided, waiting for the backend (queued) |
| `–` | known, but no score (e.g. no API key) |
| `exp` | the ad has expired, not scored |
| `?` | the ad could not be read completely, not scored |
| `!` | backend unreachable or rejected the request |

The popup shows the ad, score and reason, a banner ("Saved", "Already rejected"), Save / Reject / Undo
buttons, "Score again" (re-scores, bypassing the cache) and a switch for automatic scoring.

## Saving and rejecting

| Keys (rebindable) | Does |
|---|---|
| `Alt+Shift+S` | **Save**: sends the full ad (description and raw capture) with status `saved`. This is the only time the ad text is kept |
| `Alt+Shift+X` | **Reject**: status `rejected`. No ad text is sent or kept |

Rebind them in `chrome://extensions/shortcuts` (Firefox: about:addons → gear → Manage Extension Shortcuts).
The popup buttons show whatever keys are currently bound. The badge is the feedback: `…` while sending, then
`✓` or `✗`. **Undo** (popup) sets the ad back to its earlier status; going back to "seen" makes the backend drop
the text the save stored.

- You can decide before the score arrives; the late score will not overwrite your decision.
- An ad marked **applied** is never changed from here (the shortcut would overwrite real progress); do that in
  the web app. Saving an already-saved ad, or rejecting a rejected one, does nothing.
- **Offline:** if the backend is unreachable or times out, the decision goes into a queue in `storage.local`
  (a save keeps its text so it can be sent; a reject keeps metadata only). The badge shows `↻`, and it is sent
  automatically: after the next successful request, every minute (alarm), and at browser start. The last decision
  about an ad wins. A decision the backend *refuses* is parked in `queue_failed` rather than retried forever.

## Permissions

| Permission | Why |
|---|---|
| `storage` | settings, per-tab state (session, in memory), the offline queue |
| `activeTab` | the browsers only give an extension the current tab's URL after you open its popup or press its shortcut; the popup uses it to tell whether you are on an ad |
| `alarms` | retry the offline queue |
| `http://jobs.test/*` | talk to your local backend |
| content script on `duunitori.fi/tyopaikat/tyo/*` | read the ad you are looking at |

## Tests

```sh
npm test       # parsers, content script, controller, backend client, popup view, build output
npm run lint   # builds, then Mozilla's addons-linter on the Firefox build (exit 1 on errors)
```

The Duunitori fixture is **synthetic** (hand-written to match the markup the parser expects). Replace it with
real snapshots once the extension can export them.

Verified so far: all unit tests (including the real `background.js` loaded against a fake browser);
`addons-linter` (0 errors; one warning about Firefox's `data_collection_permissions` key, deliberately
not set); an end-to-end run of the Chrome build in a real Chrome against a stub backend (scoring, save, undo,
reject, the popup's buttons, the offline queue and its replay, the registered shortcuts); Firefox 158 installs
the build as a temporary add-on. **Not verified:** pressing the shortcuts and opening the real popup (headless
Chrome can do neither; the same code paths are driven by messages and a patched `tabs.query`, so in particular
the `activeTab` fix for tab URLs is untested), Firefox runtime behaviour, and a hidden background tab in a real
browser (headless Chrome reports every tab as visible; jsdom tests cover it).

## Layout

```
src/
  background.js          message routing; keeps no state in variables
  lib/                   browser.js (shim)  api.js (backend client)  controller.js  queue.js  badge.js  settings.js
  parsers/               jsonld.js  duunitori.js      (classic scripts: content scripts cannot be ES modules)
  content/duunitori.js   runs on ad pages, reports once the tab is visible
  popup/                 popup.html/js/css  view.js (pure: decides what to show)
manifest.base.json       shared manifest; build.mjs adds the per-browser background and Firefox ID
```

## Dependencies

Dev dependencies are `jsdom` (tests) and `addons-linter` (manifest lint). `web-ext` was dropped: its only
use here was `lint`, and it pulls in `@devicefarmer/adbkit` → `node-forge`, which has an unpatched advisory
(GHSA-86w9-cpqp-85rv, no fixed release exists; `npm audit` suggests downgrading web-ext to 5.1.0, which is
wrong). `addons-linter` is the same linter without the Android tooling. Check with `npm audit`.
To run Firefox with auto-reload during development you can use `npx web-ext run`, which is not a project
dependency, so it never enters the lockfile.

## Debugging

- Chrome: `chrome://extensions` → Job Hunter → "service worker" opens its console. The worker stops when
  idle, which is normal.
- Firefox: `about:debugging` → Inspect on the extension.
- The popup's own console: right-click the popup → Inspect.
