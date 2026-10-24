import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, pageWith } from './helpers.js';

const GENERIC = ['parsers/jsonld.js', 'parsers/generic.js'];
const plain = (v) => JSON.parse(JSON.stringify(v));
const NOW = new Date('2026-10-24T12:00:00Z');

function read(html, { url = 'https://careers.northwind.example/jobs/101', select } = {}) {
  const win = pageWith(html, { url, scripts: GENERIC });
  if (select) {
    const range = win.document.createRange();
    range.selectNodeContents(win.document.querySelector(select));
    win.getSelection().removeAllRanges();
    win.getSelection().addRange(range);
  }
  return plain(win.JH.parseGeneric(win.document, url, NOW));
}
const readFixture = (name, opts) => read(fixture(name), opts);
const page = (head = '', body = '') => `<html><head>${head}</head><body>${body}</body></html>`;
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

// --- structured data -------------------------------------------------------------------------

test('a page with JobPosting data is read from it, with high confidence and nothing guessed', () => {
  const { job, quality, expired } = readFixture('careers-jsonld.html');
  assert.equal(job.title, 'Platform Engineer');
  assert.equal(job.company, 'Northwind Oy');
  assert.equal(job.location, 'Helsinki, Uusimaa, FI (remote)');
  assert.equal(job.jobType, 'Full-time');
  assert.equal(job.salary, '4000–5000 EUR/month');
  assert.equal(job.industry, 'Software');
  assert.equal(job.published, '2026-10-01');
  assert.equal(job.deadline, '2026-12-15');
  assert.match(job.descriptionSnippet, /^Northwind builds the logistics platform/);
  assert.match(job.descriptionSnippet, /- Run and evolve our Kubernetes clusters/);
  assert.equal(job.source, 'extension');
  assert.deepEqual(quality, { missing: [], guessed: [], confidence: 'high', ambiguous: false });
  assert.equal(expired, false);
  assert.deepEqual([job.raw.site, job.raw.method, job.raw.host], ['generic', 'jsonld', 'careers.northwind.example']);
  assert.equal('description' in job.raw.jsonld, false, 'the HTML body is not duplicated into raw');
});

test('an expired posting is marked expired', () => {
  const html = fixture('careers-jsonld.html').replace('2026-12-15', '2026-10-01');
  assert.equal(readFixture('careers-jsonld.html').expired, false);
  assert.equal(read(html).expired, true);
});

test('a careers index lists several postings: the one for this address wins, otherwise it is flagged', () => {
  const second = readFixture('careers-index.html', { url: 'https://careers.northwind.example/jobs/102' });
  assert.equal(second.job.title, 'Site Reliability Engineer');
  assert.equal(second.quality.ambiguous, false);
  assert.equal(second.quality.confidence, 'high');

  const none = readFixture('careers-index.html', { url: 'https://careers.northwind.example/jobs' });
  assert.equal(none.job.title, 'Data Engineer', 'falls back to the first');
  assert.equal(none.quality.ambiguous, true);
  assert.equal(none.quality.confidence, 'medium', 'and does not claim certainty');
});

test('odd structured-data shapes degrade per field and never throw', () => {
  const cases = [
    { title: 'A', hiringOrganization: 'Plain Name Ltd' },
    { title: 'A', hiringOrganization: [{ legalName: 'Legal Co' }] },
    { title: 'A', baseSalary: 5000 },
    { title: 'A', baseSalary: { value: 4500 } },
    { title: 'A', baseSalary: { currency: 'EUR', value: { value: 60000, unitText: 'YEAR' } } },
    { title: 'A', jobLocation: [{ address: 'Tampere, Finland' }, { address: { addressLocality: 'Oulu' } }] },
    { title: 'A', jobLocation: 7 },
    { title: 'A', employmentType: ['CONTRACTOR', 'PART_TIME'] },
    { title: 'A', employmentType: 'SOMETHING_NEW' },
    { title: 'A', description: { text: 'not a string' } },
    { title: { weird: true } },
  ];
  for (const extra of cases) {
    const { job } = read(page(ld({ '@type': 'JobPosting', ...extra })));
    for (const key of ['title', 'company', 'location', 'salary', 'jobType', 'descriptionSnippet']) assert.equal(typeof job[key], 'string', `${JSON.stringify(extra)} -> ${key}`);
  }
  const f = (extra, key) => read(page(ld({ '@type': 'JobPosting', title: 'A', ...extra }))).job[key];
  assert.equal(f({ hiringOrganization: 'Plain Name Ltd' }, 'company'), 'Plain Name Ltd');
  assert.equal(f({ hiringOrganization: [{ legalName: 'Legal Co' }] }, 'company'), 'Legal Co');
  assert.equal(f({ baseSalary: { currency: 'EUR', value: { value: 60000, unitText: 'YEAR' } } }, 'salary'), '60000 EUR/year');
  assert.equal(f({ jobLocation: [{ address: 'Tampere, Finland' }, { address: { addressLocality: 'Oulu' } }] }, 'location'), 'Tampere, Finland / Oulu');
  assert.equal(f({ employmentType: ['CONTRACTOR', 'PART_TIME'] }, 'jobType'), 'Contract');
  assert.equal(f({ employmentType: 'SOMETHING_NEW' }, 'jobType'), 'SOMETHING_NEW');
});

// --- pages without structured data ------------------------------------------------------------

test('a markup-only page is read from the heading, the site name and the main text, and says what it guessed', () => {
  const { job, quality } = readFixture('careers-markup.html');
  assert.equal(job.title, 'Platform Engineer');
  assert.equal(job.company, 'Northwind');
  assert.match(job.descriptionSnippet, /Responsibilities/);
  assert.match(job.descriptionSnippet, /- Operate Kubernetes in production/);
  assert.deepEqual(quality.guessed.sort(), ['company', 'descriptionSnippet', 'title']);
  assert.equal(quality.confidence, 'medium');
  assert.deepEqual(quality.missing, []);
  assert.equal(job.raw.method, 'heuristic');
  assert.equal(job.raw.jsonld, null);
});

test('page chrome is not part of the description: navigation, cookie banner, footer, scripts, forms', () => {
  const { job } = readFixture('careers-markup.html');
  for (const noise of ['Contact sales', 'cookies', 'Privacy policy', 'do not include this', 'Apply now']) {
    assert.equal(job.descriptionSnippet.includes(noise), false, `"${noise}" leaked into the description`);
  }
});

test('an ordinary article is recognised as low confidence', () => {
  const { quality, job } = readFixture('article.html', { url: 'https://thedaily.example/news/budget' });
  assert.equal(quality.confidence, 'low');
  assert.equal(job.title, 'Council approves budget after long debate');
});

test('text you select yourself is used as the description, and makes the read trustworthy enough to proceed', () => {
  const { job, quality } = readFixture('article.html', { url: 'https://thedaily.example/news/budget', select: 'article' });
  assert.equal(job.raw.method, 'selection');
  assert.match(job.descriptionSnippet, /^Council approves budget after long debate\nThe city council voted/);
  assert.equal(quality.confidence, 'medium', 'a deliberate selection is not "low"');
});

test('a short selection is ignored', () => {
  const html = page('<title>Dev - Acme</title>', '<h1>Dev</h1><p id="s">tiny</p><main><p>' + 'About the role: responsibilities and requirements. '.repeat(20) + '</p></main>');
  assert.notEqual(read(html, { select: '#s' }).job.raw.method, 'selection');
});

test('long pages are capped so a whole site is never sent on for scoring', () => {
  const html = page('<title>Dev</title>', '<main><h1>Dev</h1>' + '<p>' + 'Responsibilities include many things. '.repeat(1000) + '</p>'.repeat(1) + '</main>');
  const { job } = read(html);
  assert.ok(job.descriptionSnippet.length <= 12000, `length ${job.descriptionSnippet.length}`);
  assert.ok(job.descriptionSnippet.length > 8000);
});

// --- title and company guessing --------------------------------------------------------------

test('titles are split at the usual separators and the role comes first', () => {
  for (const raw of ['Backend Developer | Acme', 'Backend Developer - Acme Careers', 'Backend Developer – Acme', 'Backend Developer · Acme']) {
    const { job } = read(page(`<title>${raw}</title>`, '<main><p>' + 'Responsibilities and requirements. '.repeat(20) + '</p></main>'));
    assert.equal(job.title, 'Backend Developer', raw);
  }
});

test('the company is taken from the address on shared job boards and plain company hosts', () => {
  const body = '<main><p>' + 'About the role: responsibilities and requirements. '.repeat(20) + '</p></main>';
  const company = (url) => read(page('<title>Dev</title>', body), { url }).job.company;
  assert.equal(company('https://boards.greenhouse.io/northwind/jobs/4001234'), 'Northwind');
  assert.equal(company('https://jobs.lever.co/acme-labs/abc-123'), 'Acme Labs');
  assert.equal(company('https://apply.workable.com/mega_corp/j/ABC123/'), 'Mega Corp');
  assert.equal(company('https://acme.teamtailor.com/jobs/12345-dev'), 'Acme');
  assert.equal(company('https://careers.acme.com/jobs/1'), 'Acme');
  assert.equal(company('https://www.example.co.uk/careers/dev'), 'Example');
  assert.equal(company('https://jobs.example.org/opening?id=5'), 'Example');
  for (const url of ['https://boards.greenhouse.io/northwind/jobs/1', 'https://acme.teamtailor.com/jobs/1']) {
    assert.ok(read(page('<title>Dev</title>', body), { url }).quality.guessed.includes('company'));
  }
});

test('a page with nothing recognisable reports exactly what is missing', () => {
  const { job, quality } = read('<html><body><p>hello</p></body></html>', { url: 'https://localhost/' });
  assert.equal(job.title, '');
  assert.deepEqual(quality.missing.slice(0, 2), ['title', 'company']);
  assert.equal(quality.confidence, 'low');
});
