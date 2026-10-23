// Classic script (see jsonld.js). Reads a Duunitori ad page: JSON-LD first, DOM for what it lacks.
// The parser only reads the page; it never clicks or changes it.
(function (root) {
  const JH = (root.JH = root.JH || {});

  const EMPLOYMENT_TYPES = {
    FULL_TIME: 'Kokopäivätyö',
    PART_TIME: 'Osa-aikatyö',
    TEMPORARY: 'Määräaikainen',
    INTERN: 'Harjoittelu',
    CONTRACTOR: 'Sopimussuhteinen',
    OTHER: 'Muu',
  };
  const JOB_TYPE_WORDS = [
    ['Kokopäivätyö', /kokopäivä/i], ['Osa-aikatyö', /osa-aika/i], ['Vakituinen', /vakituinen/i],
    ['Määräaikainen', /määräaikain/i], ['Kesätyö', /kesätyö/i], ['Harjoittelu', /harjoittel/i], ['Etätyö', /etätyö/i],
  ];
  // Without these the ad can't be scored or saved usefully.
  const REQUIRED = ['title', 'company', 'descriptionSnippet'];
  const MIN_DESCRIPTION_CHARS = 200;

  const clean = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  function domLocation(doc) {
    const container = doc.querySelector('.js-remove-leading-whitespace');
    if (!container) return '';
    const places = [];
    for (const span of container.querySelectorAll('span:not(.js-expand-toggle-wrapper)')) {
      const text = span.textContent.trim().replace(/^[-,\s]+/, '').replace(/,\s*$/, '');
      if (text && !text.includes('muuta') && text.length > 1) places.push(text);
    }
    const expanded = container.querySelector('.js-expand-content');
    if (expanded) {
      const text = expanded.textContent.trim().replace(/^,\s*/, '').replace(/ /g, ' ');
      places.push(...text.split(',').map((s) => s.trim()).filter((s) => s.length > 1));
    }
    return places.join(', ');
  }

  // True when `value` (ISO date or datetime) is before now. A bare date means "valid through that day".
  function isPast(value, now) {
    if (!value) return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value < now.toISOString().slice(0, 10);
    const t = Date.parse(value);
    return !Number.isNaN(t) && t < now.getTime();
  }

  JH.parseDuunitori = function (doc, url, now) {
    now = now || new Date();
    const ld = JH.parseJsonLd(doc) || {};

    let company = (ld.hiringOrganization && ld.hiringOrganization.name) || '';
    if (!company || company === company.toLowerCase()) {
      company = clean(doc.querySelector('p.header__info a[href*="/yritys/"]')) || company;
    }

    let location = '';
    const loc = Array.isArray(ld.jobLocation) ? ld.jobLocation[0] : ld.jobLocation;
    if (loc && loc.address) {
      location = loc.address.addressLocality || loc.address.streetAddress || loc.address.addressRegion || '';
    }
    location = domLocation(doc) || location;

    let published = ld.datePosted || '';
    let deadline = ld.validThrough || '';
    if (!published || !deadline) {
      for (const span of doc.querySelectorAll('p.header__info span')) {
        const text = span.textContent.trim();
        if (!published && text.startsWith('Julkaistu')) published = text.replace('Julkaistu', '').trim().replace(/\.$/, '');
        if (!deadline && text.startsWith('Päättyy')) deadline = text.replace('Päättyy', '').trim().replace(/\.$/, '');
      }
    }

    let jobType = '';
    const employment = Array.isArray(ld.employmentType) ? ld.employmentType[0] : ld.employmentType;
    if (employment) jobType = EMPLOYMENT_TYPES[employment] || employment;
    if (!jobType) {
      const found = [];
      const header = Array.from(doc.querySelectorAll('p.header__info, .tag--info')).map(clean).join(' ');
      for (const [label, re] of JOB_TYPE_WORDS) if (re.test(header)) found.push(label);
      jobType = found.join(', ');
    }

    let industry = '';
    for (const block of doc.querySelectorAll('.info-listing__block')) {
      const heading = block.querySelector('.info-listing__heading');
      if (heading && heading.textContent.trim() === 'Toimiala') industry = clean(block.querySelector('.info-listing__value'));
    }

    let description = ld.description ? JH.htmlToText(ld.description, doc) : '';
    if (description.length < 50) {
      const box = doc.querySelector('.description--jobentry');
      if (box) description = JH.htmlToText(box.innerHTML, doc);
    }

    let applyUrl = '';
    const apply = doc.querySelector('a.apply--button, a.js-jobentry-apply');
    const href = apply && apply.getAttribute('href');
    if (href) applyUrl = href.startsWith('http') ? href : url.split('#')[0] + (href.startsWith('#') ? href : '/' + href);

    const { description: _html, ...ldWithoutBody } = ld; // the HTML body duplicates descriptionSnippet
    const job = {
      title: ld.title || clean(doc.querySelector('h1')),
      company,
      location,
      published,
      deadline,
      descriptionSnippet: description,
      url,
      source: 'extension',
      salary: clean(doc.querySelector('.tag--salary')),
      jobType,
      industry,
      applyUrl,
      raw: { site: 'duunitori', jsonld: ldWithoutBody },
    };

    const missing = REQUIRED.filter((f) => !job[f]);
    if (job.descriptionSnippet && job.descriptionSnippet.length < MIN_DESCRIPTION_CHARS) missing.push('fullDescription');
    return { job, quality: { missing }, expired: isPast(ld.validThrough, now) };
  };
})(globalThis);
