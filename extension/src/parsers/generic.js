// Classic script (see jsonld.js). Reads a job ad on a site we have no dedicated reader for. It is only ever
// injected on request (popup button or shortcut), never automatically, and only reads the page.
//
// Order of trust for each field:
//   stated    schema.org JobPosting data, itemprop markup, a labelled fact ("Location: Helsinki"), the page's h1
//   inferred  a class name such as "...-company", the site name, a part of the document title, the address
//   selected  text you selected yourself (a deliberate choice)
// Inferred fields are listed in quality.guessed so the popup can say so; quality.confidence says how much the
// page looks like a job ad at all.
(function (root) {
  const JH = (root.JH = root.JH || {});
  const { first, str, attempt } = JH.util;

  const MAX_DESCRIPTION_CHARS = 12000; // bounds what is sent on to the scorer from a long page
  const MIN_SELECTION_CHARS = 200;
  const MIN_DESCRIPTION_CHARS = 200;
  const MAX_FACTS = 12;
  const REQUIRED = ['title', 'company', 'descriptionSnippet'];

  const EMPLOYMENT = {
    FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACTOR: 'Contract', TEMPORARY: 'Temporary',
    INTERN: 'Internship', VOLUNTEER: 'Volunteer', PER_DIEM: 'Per diem', OTHER: 'Other',
  };

  // Words that suggest a job ad (English, Finnish, Swedish). Several distinct ones together are a good sign.
  const JOB_WORDS = [
    /responsibilit/i, /requirements?\b/i, /qualifications?/i, /we offer/i, /\bapply\b/i, /about the (role|job|position)/i,
    /what you('ll| will)/i, /experience (in|with|of)/i, /salary|compensation|benefits/i, /full[- ]time|part[- ]time|permanent/i,
    /we are looking for|looking for (a|an|someone|candidates?)/i, /\bcandidate\b/i, /\binternship\b|\bintern\b|\btrainee\b/i,
    /join (us|our team)|we('re| are) hiring/i,
    /työtehtävä|tehtävänä/i, /vaatimu|edellytyks|osaaminen/i, /\bhae\b|hakemus|hakuaika/i, /kokemus/i, /palkka|edut\b/i,
    /arbetsuppgift|\bkrav\b|ansök|erfarenhet/i,
  ];
  // The address and the title say "job" even when the prose is short and plain.
  const JOB_PATH = /\/(jobs?|careers?|hire|offers?|vacanc\w*|positions?|openings?|rekry\w*|tyopaikat|tyopaikka|avoimet[-\w]*|lediga[-\w]*)(\/|$)/i;
  const ROLE_WORDS = /\b(engineer|developer|coder|tester|designer|manager|analyst|specialist|consultant|architect|scientist|intern(ship)?|trainee|assistant|officer|technician|director|kehittäjä|suunnittelija|asiantuntija|harjoittelija|päällikkö|ohjelmoija|utvecklare)\b/i;

  // Labels of "Label: value" facts (definition lists, two-column tables), by the field they describe.
  const FACT_FIELDS = [
    ['company', /^(company|employer|organi[sz]ation|hiring organi[sz]ation|työnantaja|yritys|organisaatio|arbetsgivare|företag)$/i],
    ['location', /^(location|work location|place of work|city|sijainti|työpaikan sijainti|paikkakunta|kaupunki|plats|arbetsort|ort)$/i],
    ['jobType', /^(role type|job type|employment type|type of employment|contract type|työsuhteen laatu|työsuhde|anställningsform)$/i],
    ['workplace', /^(workplace type|work arrangement|työskentelytapa|arbetsplatstyp)$/i],
    ['deadline', /^(application period|application deadline|deadline|apply by|closing date|hakuaika|viimeinen hakupäivä|haku päättyy|sista ansökningsdag)$/i],
    ['published', /^(posted|published|date posted|julkaistu|julkaisupäivä|publicerad)$/i],
  ];
  const factField = (label) => (FACT_FIELDS.find(([, re]) => re.test(label)) || [])[0] || null;
  const DATE = /\d{1,2}\.\d{1,2}\.\d{4}|\d{4}-\d{2}-\d{2}/g;
  const lastDate = (text) => (text.match(DATE) || []).pop() || '';

  // Job boards that host many companies: the company is in the address, not the host name.
  const ATS_PATH_COMPANY = /^(boards|job-boards)\.greenhouse\.io$|^jobs\.lever\.co$|^apply\.workable\.com$|^jobs\.ashbyhq\.com$|^jobs\.smartrecruiters\.com$|^careers\.smartrecruiters\.com$/;
  const ATS_SUBDOMAIN_COMPANY = /\.(teamtailor|recruitee|bamboohr|personio|breezy|workable|myworkdayjobs|jobylon|homerun|join)\.(com|de|co|hr|io)$/;
  const GENERIC_PART = /^(careers?|jobs?|hiring|vacanc\w*|open positions|work with us|join us|apply|recruit\w*|linkedin|indeed|home)$/i;
  const NOISE = 'script, style, noscript, template, nav, header, footer, aside, form, button, select, svg, iframe, dialog, ' +
    '[hidden], [aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"], ' +
    '[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"], [class*="breadcrumb"]';
  const SITE_CHROME = 'footer, nav, [role="contentinfo"], [role="navigation"]';
  const DESCRIPTION_SELECTORS = [
    '[itemprop="description"]', '.job-description', '#job-description', '[class*="job-description"]',
    '[class*="jobs-description"]', '[class*="jobDescription"]', '[data-testid*="description"]', 'article', 'main',
    '[role="main"]', '#content', '.content',
  ];
  const COMPANY_CLASS = /(^|[\s_-])(company|employer|organi[sz]ation|hiring)([\s_-]|$)/i;
  const NOT_A_VALUE_CLASS = /logo|menu|nav|footer|link|list|filter|search|button|icon|image|img|banner|cookie|description|about/i;

  const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  const squash = (s) => s.replace(/\s+/g, ' ').trim();
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

  // The element holding the job's text, and the larger region around it that also holds its details (a sidebar,
  // a header with the company and place). `source` says how it was found; 'body' is the weakest.
  function pageContainer(doc) {
    for (const selector of DESCRIPTION_SELECTORS) {
      const el = attempt(() => doc.querySelector(selector), null);
      const text = el ? attempt(() => cleanedText(doc, el)) : '';
      if (text.length >= 400) return { el, text, source: selector, scope: el.closest('main, article, [role="main"]') || el };
    }
    return { el: doc.body, text: attempt(() => cleanedText(doc, doc.body)), source: 'body', scope: doc.body };
  }

  // "Label: value" facts from definition lists and two-column tables, outside menus and footers.
  function readFacts(scope) {
    const facts = [];
    const add = (labelEl, valueEl) => {
      if (labelEl.closest(SITE_CHROME)) return;
      const label = squash(labelEl.textContent).replace(/[:：]\s*$/, '');
      const value = squash(valueEl.textContent);
      if (label && value && label.length <= 40 && value.length <= 200) facts.push({ label, value });
    };
    for (const dt of scope.querySelectorAll('dl dt')) {
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD') add(dt, dd);
    }
    for (const tr of scope.querySelectorAll('table tr')) {
      if (tr.children.length === 2) add(tr.children[0], tr.children[1]);
    }
    return facts;
  }

  // A short leaf element whose class names it ("...-company"), outside logos, menus and long text.
  function classHint(scope, pattern) {
    for (const el of scope.querySelectorAll('[class]')) {
      const cls = typeof el.className === 'string' ? el.className : '';
      if (!pattern.test(cls) || NOT_A_VALUE_CLASS.test(cls) || el.closest(SITE_CHROME)) continue;
      if (el.querySelector('div, p, ul, ol, table, section, article, h1, h2, h3')) continue;
      const text = squash(el.textContent);
      if (text && text.length <= 80) return text;
    }
    return '';
  }

  const itempropText = (doc, name) => attempt(() => {
    const el = doc.querySelector(`[itemprop="${name}"]`);
    const inner = el.querySelector('[itemprop="name"]');
    return squash((inner || el).textContent);
  });

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
    const sources = {};
    const { posting: ld, ambiguous } = choosePosting(attempt(() => JH.parseAllJsonLd(doc), []), url);
    const data = ld || {};

    const selection = attempt(() => String(doc.defaultView.getSelection().toString()).trim());
    const usesSelection = selection.length >= MIN_SELECTION_CHARS;
    const container = pageContainer(doc);
    const facts = attempt(() => readFacts(container.scope), []);
    const fact = (field) => (facts.find((f) => factField(f.label) === field) || {}).value || '';
    const labelled = FACT_FIELDS.filter(([field]) => fact(field)).length;

    // title: structured data, then the page heading (stated), then the document title (inferred)
    const headline = attempt(() => squash(doc.querySelector('h1').textContent));
    const docTitle = meta(doc, 'meta[property="og:title"]') || attempt(() => doc.title.trim());
    const parts = titleParts(docTitle);
    let title = str(data.title) || str(data.name);
    sources.title = title ? 'jsonld' : '';
    if (!title && headline && headline.length <= 200) [title, sources.title] = [headline, 'h1'];
    if (!title) {
      title = parts[0] || '';
      if (title) [sources.title] = ['document-title', guessed.push('title')];
    }

    // company: stated (structured data, itemprop, a labelled fact), then inferred (class name, site name, title, address)
    let company = attempt(() => {
      const org = first(data.hiringOrganization);
      return typeof org === 'string' ? org : str(org.name) || str(org.legalName);
    });
    sources.company = company ? 'jsonld' : '';
    if (!company && (company = itempropText(doc, 'hiringOrganization'))) sources.company = 'itemprop';
    if (!company && (company = fact('company'))) sources.company = 'label';
    if (!company) {
      const rest = parts.slice(1).filter((p) => !GENERIC_PART.test(p) && !/careers|jobs\b/i.test(p));
      const inferred = [
        ['class', () => classHint(container.scope, COMPANY_CLASS)],
        ['site-name', () => meta(doc, 'meta[property="og:site_name"]')],
        ['document-title', () => rest[rest.length - 1]],
        ['address', () => companyFromAddress(url)],
      ];
      for (const [how, get] of inferred) {
        company = attempt(get);
        if (company) { sources.company = how; guessed.push('company'); break; }
      }
    }

    // description: structured data, then what you selected, then the page's job text; details are added for the scorer
    let description = attempt(() => (typeof data.description === 'string' ? JH.htmlToText(data.description, doc) : ''));
    let method = ld ? 'jsonld' : 'heuristic';
    if (description.length < 50 || usesSelection) {
      description = usesSelection ? selection : container.text;
      method = usesSelection ? 'selection' : method;
      sources.description = usesSelection ? 'selection' : container.source;
      if (!usesSelection && container.source === 'body') guessed.push('descriptionSnippet');
      description = cap(description);
      // The sidebar's details (type, hours, duration) matter for fit and are not part of the prose.
      if (!usesSelection && container.source !== 'body' && facts.length) {
        description += '\n\nDetails:\n' + facts.slice(0, MAX_FACTS).map((f) => `${f.label}: ${f.value}`).join('\n');
      }
    } else {
      sources.description = 'jsonld';
      description = cap(description);
    }

    // the rest: structured data first, then labelled facts and class hints
    const workplace = fact('workplace');
    const jobTypeText = attempt(() => EMPLOYMENT[str(first(data.employmentType))] || str(first(data.employmentType)));
    const jobType = jobTypeText || [fact('jobType'), workplace].filter(Boolean).join(', ');
    const location = attempt(() => locationOf(data)) || fact('location') || attempt(() => classHint(container.scope, /(^|[\s_-])(location|city)([\s_-]|$)/i));
    const posted = attempt(() => (squash(container.scope.textContent).match(/\b(?:posted|published|julkaistu)\s*:?\s*(\d{1,2}\.\d{1,2}\.\d{4}|\d{4}-\d{2}-\d{2})/i) || [])[1] || '');
    const published = str(data.datePosted) || lastDate(fact('published')) || posted;
    const deadline = str(data.validThrough) || lastDate(fact('deadline'));

    // how much does this look like a job ad? Words, the address, the title and the labelled facts all count.
    const path = attempt(() => new URL(url).pathname);
    const evidence = jobWordHits(`${title}\n${description}`) + (JOB_PATH.test(path) ? 2 : 0) + (ROLE_WORDS.test(title) ? 1 : 0) +
      (labelled >= 2 ? 2 : labelled === 1 ? 1 : 0);
    let confidence = ld ? 'high' : evidence >= 3 ? 'medium' : 'low';
    if (usesSelection && confidence === 'low') confidence = 'medium'; // you chose this text on purpose
    if (ambiguous) confidence = 'medium';

    const { description: _body, ...ldWithoutBody } = data;
    const job = {
      title,
      company,
      location,
      published,
      deadline,
      descriptionSnippet: description,
      url,
      source: 'extension',
      salary: attempt(() => salaryOf(data.baseSalary)),
      jobType,
      industry: str(data.industry),
      applyUrl: '',
      raw: { site: 'generic', host: attempt(() => new URL(url).hostname), method, confidence, sources, jsonld: ld ? ldWithoutBody : null },
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
