# Job Hunter extension

Scores a Duunitori job ad against your profile as you read it, and shows the result on the toolbar badge
and in the popup. Design and constraints: [`docs/EXTENSION_DESIGN.md`](../docs/EXTENSION_DESIGN.md).

**Status: build steps 2 to 4, plus a generic reader for other sites.** Viewing an ad scores it; you can save it, reject it or undo, with keyboard
shortcuts, and decisions made while the backend is down are queued and sent later. Duunitori list pages mark the ads
you already have. LinkedIn, a note field and the options page are not built yet.

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

## What you see on a list page

On a Duunitori search or region page (`duunitori.fi/tyopaikat...`), ads your database already knows get a small badge
next to the title: `Saved · 82`, `Applied`, `Rejected`, `Seen · 64` (or `In inbox` for old scraper rows). Ads it does
not know get nothing. It reads the links on the page you are looking at and asks only your backend about them (one
batch of up to 200 addresses at a time, through the background worker); it opens nothing, follows no link and makes no
request to Duunitori. Ads that load as you scroll are picked up, and returning to the tab refreshes the badges. If
the backend is down the page is left alone.

## What you see on an ad

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

## Other sites (the generic reader)

On a page the extension has no dedicated reader for, the popup says so and offers **Read this page**. Nothing is read
until you press it (or press the save/reject shortcut on a page that has not been read yet, which reads and scores it
instead of saving blind; a second press decides). It reads that one page, using only the access the popup click grants.

What it reads, in order of trust: the schema.org `JobPosting` data most careers pages and applicant-tracking systems
embed (title, company, location, remote, salary, dates, employment type, description); then what the page states in its
own markup (the `h1`, `itemprop` attributes, and labelled facts such as `Location: Helsinki` in definition lists and
two-column tables, in English and Finnish); then things it can only infer (a class name like `…-company`, the site name,
the document title, the web address); then any text you selected (200+ characters become the description, which is the way
to rescue a cluttered page). The details from a sidebar (role type, hours, duration) are added to the text that is scored,
because "internship, hybrid" matters for fit even though it is not part of the prose. Company names on shared job boards come from the address (`boards.greenhouse.io/northwind/…` is
Northwind, not Greenhouse).

It is honest about doubt:

- **Inferred fields are flagged** ("Guessed from the page, not stated by it: company") and a small form, pre-filled with
  the guess, lets you confirm or correct the title and company. A correction also updates the stored record.
- **A page that does not look like a job ad is not scored automatically** (judged from the job-ad wording, the address, the
  title and the labelled facts together, so a short plain ad still counts): the
  popup says so and offers **Score anyway**. Otherwise every stray page you read would cost an LLM call and leave a record.
- A page listing several jobs picks the one for this address, or says it could not tell.
- Descriptions are capped at 12,000 characters, so a long page is not sent whole.

Known limits: LinkedIn pages have no structured data and heavy markup, so the generic read will be rough there (a
dedicated adapter is planned); pages that load their text lazily may yield little until the text is on screen (select it,
then read); the fixtures are mostly synthetic. One real page (a Hive Helsinki job offer, `real-hive-offer.html`, with scripts and the
contact address removed) shaped the labelled-facts and job-ad-evidence rules; how well it does on the other sites you use
is still the open question.

## Toolbar button

Chrome shows the button once you pin it. Firefox keeps new extensions in its puzzle-piece menu, so the Firefox build
asks for the toolbar itself (`"default_area": "navbar"`, Firefox-only, set in `build.mjs`). It only decides where a
*fresh install* starts: if the button was already moved into the menu, or you unpinned it, Firefox keeps your choice.
To pin it by hand: puzzle-piece button → the **⋯** next to Job Hunter → **Pin to Toolbar**. Placement was checked by
installing the build in a clean Firefox profile and reading the toolbar layout Firefox saved (`unified-extensions-area`
before, `nav-bar` after).

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
| `scripting` | read the ad in the open tab when you open the popup or ask for a page to be read (no reload needed); the same access serves unknown sites on request |
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
