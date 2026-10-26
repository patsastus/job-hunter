# Capture extension: design

The extension is the **only** way jobs enter the database (see "Constraints"). It does two separate
things, and the difference matters:

- **Score on view:** when you look at an ad, you get a fit score and reason immediately. Nothing about
  the ad's text is kept.
- **Save on demand:** when you decide an ad matters, you save it (full capture) or reject it.

Everything else (ranking, triage, applications) reads from what these produce.

## Constraints

- **No automated collection.** Duunitori's terms forbid scraping or systematically copying content, and
  its `robots.txt` disallows automated access. The extension therefore never makes requests to job
  sites, never opens pages, follows links, paginates or reads result lists to harvest them. It only
  works on the page the user has open and looking at. Marking the ads you already know on a list you are reading
  is not harvesting: it compares the page's links with your own database and sends nothing to the site or anywhere else.
- **Text is processed, not stored, until you save.** Scoring sends the ad text to the backend and the
  scoring LLM, then discards it. What is kept for an ad you only viewed is derived data: URL, title,
  company, location, dates, score and reason (a `seen` record). The description and raw capture are stored
  only when you press Save. This is a deliberate line, not a legal opinion: it keeps the tool a personal
  reading aid rather than an archive of the site.
- **Local only.** Talks to the local backend (default `http://jobs.test`). No analytics, no remote code.
  (The LLM call is made by the backend, as today.)
- **Chrome and Firefox from one codebase**, deliberately, to learn the differences.
- **Sites:** Duunitori first. LinkedIn and a generic JSON-LD fallback are manual-capture only at first.

## Workflow

```
open a Duunitori ad
  -> tab becomes active: content script parses the ad (JSON-LD, then DOM)
  -> background: POST /api/score-preview            badge: "…" then the score, e.g. "82"
  -> you read the ad with the score and a one-line reason in the popup
  -> Alt+Shift+S  save   (full capture stored, status "saved")
     Alt+Shift+X  reject (status "rejected", no text stored)
     or just close the tab: the ad stays a "seen" record with its score
```

Scoring runs when the tab is **active**, not on page load, so ads opened in background tabs and never
read cost nothing. Each ad is scored once; revisiting shows the stored result. The popup has "Re-score".

## Smoothness (the acceptance bar)

1. Score visible within ~5 s of looking at an ad, with no click.
2. Save and reject are one keystroke, with feedback on the badge.
3. **Never lose a save.** If the backend is down, a save is queued and sent later, and the badge shows
   that it is queued. (Scoring just reports "offline"; there is nothing to queue.)
4. You can always tell what state an ad is in: badge colour and text say scored / saved / rejected /
   applied / offline / expired.
5. Edit after saving: title, company, status, note, undo.

### Badge (per tab)

| Badge | Meaning |
|---|---|
| `…` | scoring in progress |
| `82` (green ≥70, amber 40–69, red <40) | fit score, ad not saved |
| `✓` | saved (score in the popup) |
| `✗` grey | rejected |
| `A` | applied |
| `!` | backend unreachable |
| `exp` | the ad is expired, so it is not scored |

### Popup

Shows title, company, location, deadline, the score and reason, and Save / Reject / Re-score buttons, a
note field and Undo. A weak parse (missing title, company or description) is shown with the missing
fields highlighted and editable before saving. Toggles: **auto-score** (on by default), **record viewed
ads as seen** (on by default).

## Parsing

A registry of parsers tried in order; each returns fields plus a `quality` score.

1. **JSON-LD `JobPosting`** (Duunitori, many career pages). Most reliable.
2. **Site adapters.** Duunitori DOM fills what JSON-LD misses (salary, job type, industry, apply URL).
   LinkedIn has no JSON-LD (verified on a saved page), so its adapter uses the document title
   (`Title | Company | LinkedIn`), the header line (`Location · 21 hours ago · …`) and the block under the
   "About the job" heading, never class names.
3. **OpenGraph / `<title>` fallback**, giving at least title and URL.
4. **User selection:** selected text becomes the description. The escape hatch when a site changes.

The parser only reads; it does not click or change the page. LinkedIn pages load lazily and "Save page
as" snapshots lack the description, so LinkedIn adapters are tested on snapshots exported by the
extension itself ("Copy debug snapshot" in the popup menu).

## Generic reader (built)

Other sites are read only on request: the popup's **Read this page** (or the shortcut on an unread tab) injects
`parsers/jsonld.js`, `parsers/generic.js` and `content/generic.js` into that one tab (`activeTab` + `scripting`). It is
never declared in the manifest, so it can never run by itself. Decisions:

- **Confidence, not pretence.** `quality.confidence` is `high` (JobPosting data), `medium` (job-ad words, a selection, or
  an ambiguous listing) or `low`. `quality.guessed` names every field not read from structured data. A `low` page is not
  scored automatically ("Score anyway" is one click) so stray pages cost no LLM call and leave no `seen` record.
- **Correctable.** A guessed or missing title/company can be typed in the popup; the stored record is updated (PATCH).
- **Backend identity had to change** for unknown sites: `canonical_url` keeps identifying query parameters
  (`?gh_jid=123`) and drops only tracking ones, and a fingerprint with no location includes the URL. Otherwise two
  openings on one careers page, or two same-titled roles with no parsed location, would merge into one record.
- **Descriptions are capped** at 12,000 characters.
- LinkedIn stays a separate, later adapter: it has no structured data and heavy markup.

## Browser differences (the learning part)

| Concern | Chrome | Firefox | Handling |
|---|---|---|---|
| Background | `background.service_worker` (killed at any time) | `background.scripts` (event page) | Two manifests from one base; background written as stateless event handlers |
| API namespace | `chrome.*` (promises in MV3) | `browser.*` | Tiny shim: `globalThis.browser ?? globalThis.chrome` |
| Extension ID | Not needed | `browser_specific_settings.gecko.id` | Firefox manifest only |
| Host access | `host_permissions` | Granted by the user at install in MV3 | Documented extra step; the content-script match is narrow (below) |
| Dev loading | Load unpacked | `about:debugging` (temporary add-on) | Both in the README |

The worker holds no in-memory state across events: save queue, settings and per-tab state live in
`storage.local` / `storage.session`, and retries use `alarms`.

### Permissions

- Content scripts: `*://duunitori.fi/tyopaikat/tyo/*` (ad pages, the reader) and `*://duunitori.fi/tyopaikat*` (list
  pages, the highlighter; it does nothing on a single ad). The highlighter reads only the links of the open page and
  sends their addresses to the local backend's lookup endpoint. It makes no request to the site and keeps nothing.
- Host permission for the backend (`jobs.test`).
- `activeTab` + `scripting` for manual capture on other sites (LinkedIn, generic), so those pages are
  only touched when you press the shortcut.
- A content script on an `https` page cannot call `http://jobs.test` (mixed content), so every backend
  call is relayed through the background worker.

## Layout

```
extension/
  src/
    background.js        # message routing, backend calls, save queue, badge, shortcuts
    content/duunitori.js # runs on ad pages: parse, report to background when the tab is active
    content/capture.js   # injected on demand for manual capture elsewhere
    parsers/             # jsonld.js  duunitori.js  linkedin.js  generic.js  index.js
    popup/               # popup.html  popup.js  popup.css
    options/             # backend URL, toggles, queue view, "forget viewed ads"
    lib/                 # api.js  queue.js  browser.js (shim)
  manifest.base.json
  build.mjs              # writes dist/chrome and dist/firefox manifests, copies src
  test/                  # parser tests against exported snapshots
```

No bundler, on purpose: nothing hides what the browser loads. The background worker, popup and options
page are ES modules. **Content scripts cannot be ES modules**, so the parsers are classic scripts that
attach to a shared `JH` namespace and are listed in order in the manifest's `content_scripts.js` (each
file is tested by loading it into a jsdom window the way a browser runs a content script).

## Backend additions (done, merged in `e1305e1`)

| Change | Notes |
|---|---|
| `POST /api/score-preview` (JobIn -> `{id, status, fit_score, fit_reason, cached, created}`) | Scores from the supplied text, discards it, upserts a `seen` row with metadata only. `?force=true` re-scores. A stored score is reused only while its `scored_with` stamp matches the current profile and prompt |
| `seen` status | Viewed-not-decided. Hidden from the web app's triage tabs and ignored by the batch scorer |
| `POST /api/jobs` accepts `status` | Save sets `saved` on the existing `seen` row, filling description and raw capture. Never downgrades `applied`; `seen` is rejected (422) |
| `PATCH /api/jobs/:id` (status, title, company, location, deadline, notes) | Only the fields sent change. **Undo is `status: "seen"`**, which drops the text the save stored (409 for `applied` jobs). There is no separate soft delete |
| `GET /api/jobs/:id` | New (the first version of this doc wrongly said it existed) |
| `POST /api/jobs/lookup` (up to 200 URLs) | Status and score per URL, for list highlighting and the "already known" badge |
| `notes` column | The popup note field |
| `scored_with` column, distilled profile (`/api/profile/distilled`) | Scores carry the profile version; the scoring profile is short and user-edited |

## Out of scope for now

Bulk capture, capture from result lists, background crawling, sync to other devices, auto-attached
skills (a review step stays in the web app), an on-page score panel (the badge and popup come first),
automatic scoring on LinkedIn (single-page app; needs URL-change detection and waiting for the
description).

## Build order

1. ~~Backend: `score-preview`, `seen` status, lookup, extended PATCH, notes; tests.~~ Done.
2. ~~Extension skeleton: both manifests, shim, a Duunitori ad page produces a score on the badge.~~ Done.
3. ~~Popup with Save / Reject / Re-score, shortcuts, per-tab badge states.~~ Done (plus Undo).
4. ~~Save queue with retry, offline state.~~ Done (alarm every minute, after any successful request, at startup).
5. ~~List-page highlighting on Duunitori (saved / rejected / seen, with scores) via the lookup endpoint.~~ Done.
6. Manual capture elsewhere: generic fallback, LinkedIn adapter, debug snapshot.
7. Options page; later, the on-page panel.
