# Capture extension: design

The extension is the **only** way jobs enter the database (see "Constraints"). Everything else
(ranking, triage, applications) reads from what it captures, so capture has to be fast, forgiving and
hard to lose data with.

## Constraints

- **No automated collection.** Duunitori's terms forbid scraping or systematically copying content, and
  its `robots.txt` disallows automated access. So the extension only acts when the user asks, on the
  page the user has open. It never opens pages, follows links, paginates or captures whole result lists.
- **Local only.** Talks to the local backend (default `http://jobs.test`), nothing else. No analytics,
  no remote code.
- **Chrome and Firefox from one codebase.** Deliberately two real targets, to learn the differences.
- **Sites:** Duunitori and LinkedIn, plus a generic fallback for any page with a `JobPosting` JSON-LD
  block. Other sites later by adding an adapter.

## What "smooth" means (the acceptance bar)

1. **One action saves.** Click the toolbar icon, or press a shortcut. No form first.
2. **Under ~1 second to "saved".** The popup shows the result from local state immediately;
   scoring happens afterwards and fills in.
3. **Never lose a capture.** If the backend is down, the job is queued and sent later. The user is
   told it is queued, not that it failed.
4. **You can see you already have it.** The toolbar badge shows a tick on pages already in the DB, and
   saving again says "Already saved (status: applied)" instead of pretending to save.
5. **Edit after, not before.** The popup after saving lets you fix title/company, set status, add a
   note, and undo. If the parse looks weak, it says so and offers the edit form straight away.
6. **See the verdict in place.** The fit score and one-line reason appear in the popup a few seconds
   after saving, so triage ("apply / skip") happens at capture time.

## Flow

```
click icon / shortcut
  -> background: inject content script into the active tab (activeTab, no broad host access)
  -> content script: parse page -> { job, quality, raw }
  -> background: POST /api/jobs   (queue in storage.local if unreachable)
  -> popup: shows outcome (created | duplicate | queued) + editable card
  -> background: poll GET /api/jobs/:id for ~15 s -> popup shows fit score + reason
```

The **background worker owns the network call**, not the popup, because a popup closes the moment focus
moves and would drop the request.

### Popup states

| State | Shows |
|---|---|
| Unsupported page | "Not a job page", with a "Save anyway as bookmark" only if the user wants it (off by default) |
| Saving | Title/company as soon as parsed, spinner for the network part |
| Created | Card: title, company, location, deadline; status buttons; note; Undo; Open in app |
| Duplicate | Same card with the existing row and status; "Update with this capture" |
| Queued | "Saved locally, will sync when jobs.test is reachable" with the count of queued jobs |
| Weak parse | Card opens in edit mode with the missing fields highlighted |

Keyboard shortcut (`commands` API): save without opening the popup, with feedback on the badge
(tick, or a count if queued). Default `Alt+Shift+S`, rebindable by the user in the browser.

## Parsing

A registry of parsers tried in order; each returns fields plus a `quality` score (which of
title / company / description / location / dates were found).

1. **JSON-LD `JobPosting`** (Duunitori, many career pages). Most reliable.
2. **Site adapters.** Duunitori DOM fills what JSON-LD misses (salary, job type, industry, apply URL).
   LinkedIn has no JSON-LD, so it relies on the document title (`Title | Company | LinkedIn`), the header
   line (`Location · 21 hours ago · …`), and the description block found by its "About the job" heading,
   not by class names, which LinkedIn obfuscates.
3. **OpenGraph/`<title>` fallback**, giving at least title and URL.
4. **User selection:** if text is selected on the page, it becomes the description. This is the escape
   hatch when a site changes.

Rules: the parser reads the page, it does not change it. The old `content.js` clicks "See more" buttons;
that stays out unless needed for LinkedIn, and then only inside the LinkedIn adapter.
The full description is captured (not cut at 800 characters). The raw structured data is sent too, so
parser bugs can be fixed later without revisiting the page.

LinkedIn pages load lazily and "Save page as" snapshots lack the description, so adapters are tested on
snapshots exported by the extension itself ("Copy debug snapshot" in the popup menu), not on saved pages.

## Browser differences (the learning part)

| Concern | Chrome | Firefox | Handling |
|---|---|---|---|
| Background | `background.service_worker` (can be killed any time) | `background.scripts` (event page) | Two manifests generated from one base; background code written as stateless event handlers either way |
| API namespace | `chrome.*` (promises in MV3) | `browser.*` | Tiny shim `const api = globalThis.browser ?? globalThis.chrome` |
| Extension ID | Not needed | `browser_specific_settings.gecko.id` | Only in the Firefox manifest |
| Host access | `host_permissions` | Granted by the user at install in MV3 | Document the one extra step for Firefox |
| Loading for dev | Load unpacked | `about:debugging` temporary add-on / `web-ext run` | Both in the README |

The worker must hold no in-memory state across events: queue, settings and pending polls live in
`storage.local` and `alarms`.

## Layout

```
extension/
  src/
    background.js        # message routing, API calls, queue, polling, badge
    capture.js           # content script entry: runs the parsers, returns the capture
    parsers/             # jsonld.js  duunitori.js  linkedin.js  generic.js  index.js
    popup/               # popup.html  popup.js  popup.css
    options/             # backend URL, shortcut hint, queue view
    lib/                 # api.js (backend client)  queue.js  browser.js (shim)
  manifest.base.json
  build.mjs              # writes dist/chrome and dist/firefox manifests, copies src
  test/                  # parser tests against exported snapshots
```

Plain ES modules and no bundler, on purpose: nothing hides what the browser actually loads. A bundler
or framework can be added later if the popup grows.

## Backend additions this needs

| Endpoint | Why |
|---|---|
| `GET /api/jobs/lookup?url=` | Badge tick and "already saved" before saving |
| `PATCH /api/jobs/:id` (title, company, location, deadline, status, notes) | Edit after saving (today only status can change) |
| `notes` column on `jobs` | The popup note field |
| `DELETE /api/jobs/:id` (or soft `status=discarded`) | Undo. Soft delete is safer |
| CORS / allowed origins | Extension background fetches are exempt with host permission; the options page needs the backend URL allowed |

`POST /api/jobs` already returns `outcome`, `matched_by` and `id`. The score arrives later by polling
`GET /api/jobs/:id`, which already exists.

## Out of scope for now

Bulk capture, automatic capture while browsing, capturing from result lists, sync to other devices,
auto-attaching extracted skills (a review step stays in the web app), other job sites.

## Build order

1. Backend: lookup, extended PATCH, notes, soft delete (with tests).
2. Extension skeleton: both manifests, shim, background + popup that saves a Duunitori page end to end.
3. Parsers: JSON-LD, Duunitori adapter, generic fallback, with tests.
4. Queue and retry, badge, shortcut.
5. LinkedIn adapter and debug-snapshot export.
6. Edit card, undo, score polling, options page.
