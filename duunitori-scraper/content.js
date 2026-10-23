function scrapeJob() {
  const result = {
    title: '',
    company: '',
    location: '',
    published: '',
    deadline: '',
    salary: '',
    jobType: '',
    employmentType: '',
    industry: '',
    descriptionSnippet: '',
    url: window.location.href,
    applyUrl: ''
  };

  const isLinkedIn = window.location.hostname.includes('linkedin.com');
  const isDuunitori = window.location.hostname.includes('duunitori.fi');

  try {
    // === PRIMARY SOURCE: JSON-LD structured data ===
    // Both Duunitori and LinkedIn often embed schema.org/JobPosting
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    let jsonLd = null;
    for (const script of ldScripts) {
      try {
        const parsed = JSON.parse(script.textContent);
        // LinkedIn sometimes wraps it in an array or a graph
        if (parsed['@type'] === 'JobPosting') {
          jsonLd = parsed;
          break;
        } else if (parsed['@graph']) {
           const jobPosting = parsed['@graph'].find(item => item['@type'] === 'JobPosting');
           if (jobPosting) {
             jsonLd = jobPosting;
             break;
           }
        }
      } catch (e) { /* skip malformed JSON */ }
    }

    if (jsonLd) {
      if (jsonLd.title) result.title = jsonLd.title;
      
      if (jsonLd.employmentType) {
        const typeMap = {
          'FULL_TIME': 'Kokopäivätyö',
          'PART_TIME': 'Osa-aikatyö',
          'TEMPORARY': 'Määräaikainen',
          'INTERN': 'Harjoittelu',
          'CONTRACTOR': 'Sopimussuhteinen',
          'OTHER': 'Muu'
        };
        // It could be an array on LinkedIn
        const eType = Array.isArray(jsonLd.employmentType) ? jsonLd.employmentType[0] : jsonLd.employmentType;
        result.employmentType = typeMap[eType] || eType;
      }

      if (jsonLd.datePosted) {
        result.published = new Date(jsonLd.datePosted).toLocaleDateString('fi-FI');
      }
      if (jsonLd.validThrough) {
        result.deadline = new Date(jsonLd.validThrough).toLocaleDateString('fi-FI');
      }

      if (jsonLd.hiringOrganization && jsonLd.hiringOrganization.name) {
        result.company = jsonLd.hiringOrganization.name;
      }

      if (jsonLd.jobLocation) {
        // Could be an array
        const loc = Array.isArray(jsonLd.jobLocation) ? jsonLd.jobLocation[0] : jsonLd.jobLocation;
        if (loc && loc.address) {
          result.location = loc.address.addressLocality || loc.address.streetAddress || loc.address.addressRegion || '';
        }
      }

      if (jsonLd.description) {
        const plainText = jsonLd.description
          .replace(/<[^>]*>/g, '') 
          .replace(/\s+/g, ' ')
          .trim();
        result.descriptionSnippet = plainText.substring(0, 800);
        if (plainText.length > 800) result.descriptionSnippet += '...';
      }
    }

    // === DOM FALLBACKS & ENRICHMENTS ===
    
    // Title fallback
    if (!result.title) {
        const h1 = document.querySelector('h1');
        if (h1) result.title = h1.textContent.trim();
    }

    if (isDuunitori) {
      if (!result.company || result.company === result.company.toLowerCase()) {
        const companyLink = document.querySelector('p.header__info a[href*="/yritys/"]');
        if (companyLink) result.company = companyLink.textContent.trim();
      }

      const locationContainer = document.querySelector('.js-remove-leading-whitespace');
      if (locationContainer) {
        const spans = locationContainer.querySelectorAll('span:not(.js-expand-toggle-wrapper)');
        const locations = [];
        for (const span of spans) {
          const text = span.textContent.trim().replace(/^[-,\s]+/, '').replace(/,\s*$/, '');
          if (text && !text.includes('muuta') && text.length > 1) locations.push(text);
        }
        const expandedSpan = locationContainer.querySelector('.js-expand-content');
        if (expandedSpan) {
          const expandedText = expandedSpan.textContent.trim().replace(/^,\s*/, '').replace(/\u00a0/g, ' ');
          if (expandedText) {
            const extraLocations = expandedText.split(',').map(s => s.trim()).filter(s => s.length > 1);
            locations.push(...extraLocations);
          }
        }
        if (locations.length > 0) result.location = locations.join(', ');
      }

      if (!result.published) {
        const allSpans = document.querySelectorAll('p.header__info span');
        for (const span of allSpans) {
          const text = span.textContent.trim();
          if (text.startsWith('Julkaistu')) result.published = text.replace('Julkaistu', '').trim().replace(/\.$/, '');
          if (text.startsWith('Päättyy')) result.deadline = text.replace('Päättyy', '').trim().replace(/\.$/, '');
        }
      }

      const salaryTag = document.querySelector('.tag--salary');
      if (salaryTag) result.salary = salaryTag.textContent.trim();

      if (!result.salary) {
        const descBox = document.querySelector('.description--jobentry');
        if (descBox) {
          const text = descBox.textContent;
          const salaryMatch = text.match(/(\d[\d\s]*[-–]\s*\d[\d\s]*\s*[€e](?:\/kk|\/h|uroa)?|\d[\d\s]*\s*[€e](?:\/kk|\/h|uroa)?)/i);
          if (salaryMatch) result.salary = salaryMatch[1].trim();
        }
      }

      if (!result.jobType) {
        const headerInfos = document.querySelectorAll('p.header__info, .tag--info, .description--jobentry');
        const typeKeywords = [
          ['Kokopäivätyö', /kokopäivä/i], ['Osa-aikatyö', /osa-aika/i], ['Vakituinen', /vakituinen/i],
          ['Määräaikainen', /määräaikain/i], ['Kesätyö', /kesätyö/i], ['Harjoittelu', /harjoittel/i], ['Etätyö', /etätyö/i]
        ];
        for (const el of headerInfos) {
          const text = el.textContent;
          for (const [label, regex] of typeKeywords) {
            if (regex.test(text) && (!result.jobType || !result.jobType.includes(label))) {
              result.jobType = result.jobType ? result.jobType + ', ' + label : label;
            }
          }
        }
      }

      const infoBlocks = document.querySelectorAll('.info-listing__block');
      for (const block of infoBlocks) {
        const heading = block.querySelector('.info-listing__heading');
        const value = block.querySelector('.info-listing__value');
        if (heading && value && heading.textContent.trim() === 'Toimiala') {
          result.industry = value.textContent.trim();
        }
      }

      if (!result.descriptionSnippet || result.descriptionSnippet.length < 50) {
        const descBox = document.querySelector('.description--jobentry');
        if (descBox) {
          const text = descBox.textContent.replace(/\s+/g, ' ').trim();
          result.descriptionSnippet = text.substring(0, 800) + (text.length > 800 ? '...' : '');
        }
      }

      const applyBtn = document.querySelector('a.apply--button, a.js-jobentry-apply');
      if (applyBtn) {
        const href = applyBtn.getAttribute('href');
        if (href && href.startsWith('http')) result.applyUrl = href;
        else if (href) result.applyUrl = window.location.origin + window.location.pathname + (href.startsWith('#') ? href : '/' + href);
      }
    } else if (isLinkedIn) {
      // === LINKEDIN ROBUST HEURISTICS ===
      // LinkedIn aggressively hashes CSS classes and hides data, so we avoid classes completely.

      // 1. Title and Company from document.title (Format: "Job Title | Company | LinkedIn")
      if (document.title) {
        const parts = document.title.split('|').map(p => p.trim());
        if (!result.title && parts.length > 0) result.title = parts[0];
        if (!result.company && parts.length > 1) result.company = parts[1];
      }

      // 2. Fallback for Location and Published Date using visual text scanning
      // We look for the dot separator '·' which LinkedIn uses (e.g. "Helsinki, Finland · 3 hours ago")
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walk.nextNode())) {
        const text = node.nodeValue.trim();
        if (text.includes('·') && text.length < 100) {
          const parts = text.split('·').map(p => p.trim());
          if (!result.location && parts[0] && parts[0].length > 2) {
            // Often the first part is location or company
            if (parts[0] !== result.company) result.location = parts[0];
          }
          if (!result.published && parts[1] && (parts[1].includes('ago') || parts[1].includes('päivä') || parts[1].includes('tunti'))) {
            result.published = parts[1];
          }
        }
      }

      // 3. Job Type scanning
      if (!result.jobType && !result.employmentType) {
        const keywords = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Hybrid', 'Remote', 'On-site'];
        const allSpans = document.querySelectorAll('span');
        for (const span of allSpans) {
          const text = span.textContent.trim();
          if (keywords.includes(text)) {
            result.jobType = result.jobType ? result.jobType + ', ' + text : text;
          }
        }
      }

      // 4. Description Snippet
      // LinkedIn truncates the description until "See more" is clicked.
      // We will try to find and click the "Show more" button first.
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const btnText = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        if (btnText.includes('see more') || btnText.includes('show more') || btnText.includes('näytä lisää') || btnText.includes('lue lisää')) {
          try { btn.click(); } catch (e) {}
        }
      }

      // LinkedIn puts the description under "About the job" or similar headers.
      // We'll find the largest block of text inside a main/article container.
      if (!result.descriptionSnippet || result.descriptionSnippet.length < 50) {
        let bestText = '';
        const containers = document.querySelectorAll('article, main, #job-details, .jobs-description__content');
        
        if (containers.length > 0) {
          // Use textContent instead of innerText to grab text even if it's visually hidden
          bestText = containers[0].textContent;
        } else {
          // If no obvious container, find the div with the most text
          const divs = document.querySelectorAll('div');
          let maxLen = 0;
          for (const div of divs) {
            // Skip huge wrapper divs by ensuring it doesn't contain too many links
            if (div.querySelectorAll('a').length > 20) continue;
            const text = div.textContent || '';
            if (text.length > maxLen && text.length < 15000) {
              maxLen = text.length;
              bestText = text;
            }
          }
        }
        
        if (bestText) {
          const cleanText = bestText.replace(/\s+/g, ' ').trim();
          // Try to strip out generic UI text that might have been caught
          const descStart = cleanText.indexOf('About the job');
          const snippet = descStart !== -1 ? cleanText.substring(descStart) : cleanText;
          result.descriptionSnippet = snippet.substring(0, 800) + (snippet.length > 800 ? '...' : '');
        }
      }

      result.applyUrl = window.location.href.split('?')[0]; 
    }

    if (!result.jobType && result.employmentType) {
      result.jobType = result.employmentType;
    }

  } catch (e) {
    console.error('Job Scraper Error:', e);
  }

  return result;
}

scrapeJob();
