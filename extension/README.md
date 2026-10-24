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
| `?` | the ad could not be read (or not completely), not scored; the popup says why |
| `!` | backend unreachable or rejected the request |

The popup shows the ad, score and reason, a banner ("Saved", "Already rejected"), Save / Reject / Undo
buttons, "Score again" (re-scores, bypassing the cache) and a switch for automatic scoring.

## When the popup can't read or score the ad

The popup never asks you to reload (that would close it). If it opens on a Duunitori ad the extension has not
read yet, it reads the ad itself, using the access the browser grants when you open it, and then scores it. If
something fails it shows the actual reason:

- **"Cannot reach the backend at …":** the backend is down, or the extension is not allowed to reach it. The popup
  offers an **Allow access** button when the browser says the permission is missing. Firefox treats site access as
  something you grant: if it persists, open about:addons → Job Hunter → Permissions and allow `jobs.test`.
- **"Cannot reach the backend … (TypeError: NetworkError when attempting to fetch resource.)" in Firefox while
  the same URL opens in a tab:** Firefox's default policy for Manifest V3 extension pages includes
  `upgrade-insecure-requests`, which rewrites the extension's `http://jobs.test` requests to `https://` (loopback
  addresses are exempt, host names are not), and the TLS handshake against a plain-http backend then fails. The Firefox
  build therefore states its own policy without that directive (`content_security_policy` in `build.mjs`). If you see
  this message again, check that the loaded build is the one from `dist/firefox` and that it is version 0.3.1 or later.
- **"Could not read the page: …":** the browser refused to let the extension into the tab. In Firefox, allow
  `duunitori.fi` under the same Permissions tab. This also makes ads score automatically as you browse, without
  opening the popup (Firefox does not run the extension's page scripts until that site access is granted).
- **"Could not read this ad: …":** the page had an unexpected shape. Open the page's console (F12) and look for
  `[Job Hunter] could not read this ad`; the message there includes the error.

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
| `scripting` | read the ad in the open tab when you open the popup, if the browser has not already (no reload needed) |
| `http://jobs.test/*` | talk to your local backend |
| content script on `duunitori.fi/tyopaikat/tyo/*` | read the ad you are looking at |

## Tests

```sh
npm test       # parsers, content script, controller, backend client, popup view, build output
npm run lint   # builds, then Mozilla's addons-linter on the Firefox build (exit 1 on errors)
```

The Duunitori fixture is **synthetic** (hand-written to match the markup the parser expects). Replace it with
real snapshots once the extension can export them.

Verified so far (including the Firefox http-upgrade fix, against the real gateway in an isolated Firefox 158): all unit tests (including the real `background.js` loaded against a fake browser, and the parser against awkward JSON-LD shapes);
`addons-linter` (0 errors; one warning about Firefox's `data_collection_permissions` key, deliberately
not set); an end-to-end run of the Chrome build in a real Chrome against a stub backend (scoring, save, undo,
reject, the popup's buttons, the offline queue and its replay, the registered shortcuts, reading an unread ad from the
popup, the unreachable-backend and no-access messages); in Firefox 158 (isolated profile): on-demand reading, scoring,
the offline state and the permission APIs. **Not verified:** pressing the shortcuts and clicking the real toolbar button (automation can do
neither; the same code paths are driven by messages and a patched `tabs.query`, so in particular the `activeTab` grant
that lets the popup read the tab is untested in a real popup), and a hidden background tab in a real Firefox.

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
