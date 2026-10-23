import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, pageWith, PARSERS } from './helpers.js';

const page = (html = fixture('duunitori-ad.html')) => pageWith(html, { scripts: PARSERS });
// The capture is serialised on its way to the background worker; do the same so values compare cleanly.
const plain = (value) => JSON.parse(JSON.stringify(value));
const parse = (win, now) => plain(win.JH.parseDuunitori(win.document, win.location.href, now));
const ldPage = (obj) => page(`<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body></body></html>`);

test('parseJsonLd finds a JobPosting in a plain object, an array and an @graph, and skips malformed blocks', () => {
  const posting = { '@type': 'JobPosting', title: 'X' };
  assert.equal(ldPage(posting).JH.parseJsonLd(ldPage(posting).document).title, 'X');
  const arr = ldPage([{ '@type': 'Organization' }, posting]);
  assert.equal(arr.JH.parseJsonLd(arr.document).title, 'X');
  const graph = ldPage({ '@graph': [{ '@type': 'WebSite' }, posting] });
  assert.equal(graph.JH.parseJsonLd(graph.document).title, 'X');
  const typed = ldPage({ '@type': ['Thing', 'JobPosting'], title: 'Y' });
  assert.equal(typed.JH.parseJsonLd(typed.document).title, 'Y');

  const broken = page('<html><head><script type="application/ld+json">{nope</script><script type="application/ld+json">{"@type":"JobPosting","title":"Z"}</script></head></html>');
  assert.equal(broken.JH.parseJsonLd(broken.document).title, 'Z');
  const none = page('<html><body>nothing</body></html>');
  assert.equal(none.JH.parseJsonLd(none.document), null);
});

test('htmlToText keeps paragraph and list breaks, decodes entities, and never loads resources or runs scripts', () => {
  const win = page();
  const text = win.JH.htmlToText('<p>A &amp; B</p><ul><li>one</li><li>two</li></ul><p>x<br>y</p><img src="http://tracker.invalid/p.png" onerror="window.pwned=1"><script>window.pwned=1</script>', win.document);
  assert.equal(text, 'A & B\n\n- one\n- two\n\nx\ny');
  assert.equal(win.pwned, undefined);
});

test('parses a complete Duunitori ad', () => {
  const { job, quality, expired } = parse(page(), new Date('2026-10-24T12:00:00Z'));
  assert.equal(job.title, 'Backend Developer');
  assert.equal(job.company, 'Acme Oy'); // JSON-LD name was all lowercase, so the page's own spelling wins
  assert.equal(job.location, 'Helsinki');
  assert.equal(job.published, '2026-10-20');
  assert.equal(job.deadline, '2026-11-30');
  assert.equal(job.jobType, 'Kokopäivätyö');
  assert.equal(job.salary, '4 000 - 5 000 €/kk');
  assert.equal(job.industry, 'Ohjelmointi ja ohjelmistokehitys');
  assert.equal(job.applyUrl, 'https://careers.acme.example/apply/123');
  assert.equal(job.source, 'extension');
  assert.match(job.descriptionSnippet, /^We build logistics software & need a Go developer\.\n\n- Go and PostgreSQL\n- Kubernetes in production/);
  assert.ok(job.descriptionSnippet.length > 200, 'the full description is kept, not cut to a snippet');
  assert.deepEqual(quality.missing, []);
  assert.equal(expired, false);
  assert.equal(job.raw.site, 'duunitori');
  assert.equal(job.raw.jsonld.title, 'Backend Developer');
  assert.equal('description' in job.raw.jsonld, false, 'the HTML body is not duplicated into raw');
});

test('falls back to the page when JSON-LD is missing', () => {
  const html = fixture('duunitori-ad.html').replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '')
    .replace('</body>', '<div class="description--jobentry"><p>Plain description from the page body. </p><p>Second paragraph.</p></div></body>');
  const { job, quality } = parse(page(html));
  assert.equal(job.title, 'Backend Developer');
  assert.equal(job.company, 'Acme Oy');
  assert.equal(job.published, '20.10.2026'); // Finnish format; the backend normalises it
  assert.equal(job.deadline, '30.11.2026');
  assert.equal(job.descriptionSnippet, 'Plain description from the page body.\n\nSecond paragraph.');
  assert.deepEqual(quality.missing, ['fullDescription']); // present but shorter than 200 characters
});

test('reports what is missing instead of guessing', () => {
  const { quality } = parse(page('<html><body><p>not an ad</p></body></html>'));
  assert.deepEqual(quality.missing, ['title', 'company', 'descriptionSnippet']);
});

test('expiry: a date-only validThrough is valid through that day; a past one is expired', () => {
  const win = page();
  assert.equal(parse(win, new Date('2026-11-30T15:00:00Z')).expired, false);
  assert.equal(parse(win, new Date('2026-12-01T00:30:00Z')).expired, true);
  const withTime = page(fixture('duunitori-ad.html').replace('"2026-11-30"', '"2026-11-30T23:59:00+02:00"'));
  assert.equal(parse(withTime, new Date('2026-11-30T20:00:00Z')).expired, false);
  assert.equal(parse(withTime, new Date('2026-11-30T22:00:00Z')).expired, true);
  const noDeadline = page(fixture('duunitori-ad.html').replace('"validThrough": "2026-11-30",', ''));
  assert.equal(parse(noDeadline, new Date('2030-01-01')).expired, false);
});

test('a relative apply link is resolved against the ad URL', () => {
  const win = page(fixture('duunitori-ad.html').replace('https://careers.acme.example/apply/123', '#hae'));
  assert.equal(parse(win).job.applyUrl, 'https://duunitori.fi/tyopaikat/tyo/backend-developer-acme-123#hae');
});
