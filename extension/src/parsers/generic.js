// Classic script (see jsonld.js). Reads a job ad on a site we have no dedicated reader for. It is only ever
// injected on request (popup button or shortcut), never automatically, and only reads the page.
//
// Order of trust: schema.org JobPosting data > page markup and the site name > text you selected yourself.
// Whatever is not read from structured data is listed in quality.guessed so the popup can say so, and
// quality.confidence says how much the page looks like a job ad at all.
(function (root) {
  const JH = (root.JH = root.JH || {});
  const { first, str, attempt } = JH.util;

  const MAX_DESCRIPTION_CHARS = 12000; // bounds what is sent on to the scorer from a long page
  const MIN_SELECTION_CHARS = 200;
  const MIN_DESCRIPTION_CHARS = 200;
  const REQUIRED = ['title', 'company', 'descriptionSnippet'];

  const EMPLOYMENT = {
    FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACTOR: 'Contract', TEMPORARY: 'Temporary',
    INTERN: 'Internship', VOLUNTEER: 'Volunteer', PER_DIEM: 'Per diem', OTHER: 'Other',
  };

  // Words that suggest a job ad (English, Finnish, Swedish). Several distinct ones together are a good sign.
  const JOB_WORDS = [
    /responsibilit/i, /requirements?\b/i, /qualifications?/i, /we offer/i, /\bapply\b/i, /about the (role|job|position)/i,
    /what you('ll| will)/i, /experience (in|with|of)/i, /salary|compensation|benefits/i, /full[- ]time|part[- ]time|permanent/i,
    /työtehtävä|tehtävänä/i, /vaatimu|edellytyks|osaaminen/i, /\bhae\b|hakemus|hakuaika/i, /kokemus/i, /palkka|edut\b/i,
    /arbetsuppgift|\bkrav\b|ansök|erfarenhet/i,
  ];

  // Job boards that host many companies: the company is in the address, not the host name.
  const ATS_PATH_COMPANY = /^(boards|job-boards)\.greenhouse\.io$|^jobs\.lever\.co$|^apply\.workable\.com$|^jobs\.ashbyhq\.com$|^jobs\.smartrecruiters\.com$|^careers\.smartrecruiters\.com$/;
  const ATS_SUBDOMAIN_COMPANY = /\.(teamtailor|recruitee|bamboohr|personio|breezy|workable|myworkdayjobs|jobylon|homerun|join)\.(com|de|co|hr|io)$/;
  const GENERIC_PART = /^(careers?|jobs?|hiring|vacanc\w*|open positions|work with us|join us|apply|recruit\w*|linkedin|indeed|home)$/i;
  const NOISE = 'script, style, noscript, template, nav, header, footer, aside, form, button, select, svg, iframe, dialog, ' +
    '[hidden], [aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"], ' +
    '[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"], [class*="breadcrumb"]';
  const DESCRIPTION_SELECTORS = [
    '[itemprop="description"]', '.job-description', '#job-description', '[class*="job-description"]',
    '[class*="jobDescription"]', '[data-testid*="description"]', 'article', 'main', '[role="main"]', '#content', '.content',
  ];

  const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  const meta = (doc, selector) => attempt(() => doc.querySelector(selector).getAttribute('content').trim());

  function salaryOf(base) {
    const b = first(base);
    if (!b || typeof b !== 'object') return '';
    const currency = str(b.currency);
    const v = b.value;
    let amount = '';
    let unit = '';
    if (v && typeof v === 'object') {
      const lo = str(v.minValue);
      const hi = str(v.maxValue);
      amount = lo && hi ? `${lo}–${hi}` : lo || hi || str(v.value);
      unit = str(v.unitText);
    } else {
      amount = str(v);
    }
    if (!amount) return '';
    return `${amount}${currency ? ' ' + currency : ''}${unit ? '/' + unit.toLowerCase() : ''}`;
  }

  function locationOf(ld) {
    const places = [].concat(ld.jobLocation || []);
    const names = places.map((p) => {
      const address = p && p.address;
      if (typeof address === 'string') return address;
      if (!address || typeof address !== 'object') return '';
      const country = typeof address.addressCountry === 'object' ? str(address.addressCountry.name) : str(address.addressCountry);
      return [str(address.addressLocality), str(address.addressRegion), country].filter(Boolean).join(', ');
    }).filter(Boolean);
    let location = Array.from(new Set(names)).slice(0, 3).join(' / ');
    if (str(ld.jobLocationType) === 'TELECOMMUTE') location = location ? `${location} (remote)` : 'Remote';
    return location;
  }

  function companyFromAddress(url) {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (ATS_PATH_COMPANY.test(host)) {
      const segment = u.pathname.split('/').filter(Boolean)[0];
      return segment ? titleCase(decodeURIComponent(segment)) : '';
    }
    if (ATS_SUBDOMAIN_COMPANY.test(host)) return titleCase(host.split('.')[0]);
    const labels = host.split('.').filter((l) => !/^(careers?|jobs?|apply|work|hire|recruit\w*|join|talent)$/i.test(l));
    if (labels.length < 2) return '';
    const secondLevel = ['co', 'com', 'org', 'net', 'gov', 'ac'].includes(labels[labels.length - 2]) && labels[labels.length - 1].length === 2;
    return titleCase(labels[labels.length - (secondLevel ? 3 : 2)] || '');
  }

  // "Senior Developer | Acme Careers" -> parts. Titles on job pages almost always put the role first.
  const titleParts = (raw) => raw.split(/\s+[|–—·•]\s+|\s+-\s+/).map((p) => p.trim()).filter(Boolean);

  function cleanedText(doc, element) {
    const copy = element.cloneNode(true);
    for (const el of Array.from(copy.querySelectorAll(NOISE))) el.remove();
    return JH.htmlToText(copy.innerHTML, doc);
  }

  function pageDescription(doc) {
    for (const selector of DESCRIPTION_SELECTORS) {
      const text = attempt(() => cleanedText(doc, doc.querySelector(selector)));
      if (text.length >= 400) return text;
    }
    return attempt(() => cleanedText(doc, doc.body));
  }

  function cap(text) {
    if (text.length <= MAX_DESCRIPTION_CHARS) return text;
    const cut = text.slice(0, MAX_DESCRIPTION_CHARS);
    return cut.slice(0, Math.max(cut.lastIndexOf('\n'), MAX_DESCRIPTION_CHARS * 0.8)).trim();
  }

  const jobWordHits = (text) => JOB_WORDS.filter((re) => re.test(text.slice(0, 20000))).length;

  // The posting that belongs to this page when the page's data lists several.
  function choosePosting(postings, url) {
    if (postings.length <= 1) return { posting: postings[0] || null, ambiguous: false };
    const here = attempt(() => new URL(url).pathname.replace(/\/+$/, ''));
    const match = postings.find((p) => typeof p.url === 'string' && attempt(() => new URL(p.url, url).pathname.replace(/\/+$/, '')) === here);
    return match ? { posting: match, ambiguous: false } : { posting: postings[0], ambiguous: true };
  }

  JH.parseGeneric = function (doc, url, now) {
    now = now || new Date();
    const guessed = [];
    const { posting: ld, ambiguous } = choosePosting(attempt(() => JH.parseAllJsonLd(doc), []), url);
    const data = ld || {};

    const selection = attempt(() => String(doc.defaultView.getSelection().toString()).trim());
    const usesSelection = selection.length >= MIN_SELECTION_CHARS;

    // title: structured data, then the page heading, then the document title
    const headline = attempt(() => doc.querySelector('h1').textContent.replace(/\s+/g, ' ').trim());
    const docTitle = meta(doc, 'meta[property="og:title"]') || attempt(() => doc.title.trim());
    const parts = titleParts(docTitle);
    let title = str(data.title) || str(data.name);
    if (!title) {
      title = headline && headline.length <= 200 ? headline : parts[0] || '';
      if (title) guessed.push('title');
    }

    // company: structured data, then the site name, then the rest of the title, then the address
    let company = attempt(() => {
      const org = first(data.hiringOrganization);
      return typeof org === 'string' ? org : str(org.name) || str(org.legalName);
    });
    if (!company) {
      const rest = parts.slice(1).filter((p) => !GENERIC_PART.test(p) && !/careers|jobs\b/i.test(p));
      company = meta(doc, 'meta[property="og:site_name"]') || rest[rest.length - 1] || attempt(() => companyFromAddress(url));
      if (company) guessed.push('company');
    }

    // description: structured data, then what the user selected, then the page's main text
    let description = attempt(() => (typeof data.description === 'string' ? JH.htmlToText(data.description, doc) : ''));
    let method = ld ? 'jsonld' : 'heuristic';
    if (description.length < 50 || usesSelection) {
      description = usesSelection ? selection : pageDescription(doc);
      method = usesSelection ? 'selection' : method;
      if (description) guessed.push('descriptionSnippet');
    }
    description = cap(description);

    const hits = jobWordHits(`${title}\n${description}`);
    let confidence = ld ? 'high' : hits >= 3 ? 'medium' : 'low';
    if (usesSelection && confidence === 'low') confidence = 'medium'; // you chose this text on purpose
    if (ambiguous) confidence = 'medium';

    const { description: _body, ...ldWithoutBody } = data;
    const job = {
      title,
      company,
      location: attempt(() => locationOf(data)),
      published: str(data.datePosted),
      deadline: str(data.validThrough),
      descriptionSnippet: description,
      url,
      source: 'extension',
      salary: attempt(() => salaryOf(data.baseSalary)),
      jobType: attempt(() => EMPLOYMENT[str(first(data.employmentType))] || str(first(data.employmentType))),
      industry: str(data.industry),
      applyUrl: '',
      raw: { site: 'generic', host: attempt(() => new URL(url).hostname), method, confidence, jsonld: ld ? ldWithoutBody : null },
    };

    const missing = REQUIRED.filter((f) => !job[f]);
    if (job.descriptionSnippet && job.descriptionSnippet.length < MIN_DESCRIPTION_CHARS) missing.push('fullDescription');
    return {
      job,
      quality: { missing, guessed: Array.from(new Set(guessed)), confidence, ambiguous },
      expired: JH.util.isPast(str(data.validThrough), now),
    };
  };
})(globalThis);
