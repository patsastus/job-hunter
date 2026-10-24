// Decides what the popup shows. Pure: the DOM code in popup.js only renders the result.
import { scoreColor } from '../lib/badge.js';

import { AD_URL, readerFor, WHY } from '../lib/sites.js';

export { AD_URL };

const FIELD_LABELS = {
  title: 'title',
  company: 'company',
  descriptionSnippet: 'description',
  fullDescription: 'full description',
};

// Which decisions make sense from each stored status. Applied jobs are changed in the web app only.
const DECISIONS = {
  seen: ['save', 'reject'],
  new: ['save', 'reject'],
  saved: ['reject'],
  rejected: ['save'],
  applied: [],
};
const LABELS = { save: 'Save', reject: 'Reject', undo: 'Undo', rescore: 'Score again' };

const GAVE_UP =
  'Nothing came back from the page. In Firefox, open about:addons → Job Hunter → Permissions and allow ' +
  'access to duunitori.fi, then try again.';

function headingOf(state) {
  const job = state.capture.job;
  return { title: job.title, company: job.company, location: job.location, deadline: job.deadline };
}

function canDecide(state) {
  return !state.capture.quality.missing.some((f) => f === 'title' || f === 'company');
}

function decisionActions(state) {
  if (!canDecide(state)) return [];
  const current = (state.preview && state.preview.status) || 'seen';
  return (DECISIONS[current] || []).map((id) => ({ id, label: LABELS[id] }));
}

function bannerFor(state) {
  const status = state.preview && state.preview.status;
  if (state.decision) return state.decision.action === 'save' ? 'Saved' : 'Rejected';
  if (status === 'saved' || status === 'rejected' || status === 'applied') return `Already ${status}`;
  return '';
}

// Turn the background's reply to get-state into something to render. A reply with `failure` means the
// background itself broke; any other object is a state, including ones that carry an `error` of their own
// (offline, error, unreadable), which must be shown rather than mistaken for a failed request.
export function readReply(reply) {
  if (reply && reply.failure) return { state: null, failure: reply.failure };
  return { state: reply || null, failure: null };
}

const GAVE_UP_GENERIC =
  'Nothing came back from the page. Browser pages and some sites cannot be read by extensions; ' +
  'if this is a normal page, try again.';
const UNKNOWN_SITE =
  'Job Hunter does not know this site. If the page is a job ad, it can be read once. ' +
  'If the page is cluttered, select the ad text first.';
const FIELD_NAMES = { title: 'title', company: 'company', descriptionSnippet: 'description' };

// Things the reader was unsure about, in plain words.
function hintsFor(state) {
  const q = state.capture.quality;
  const hints = [];
  if (q.confidence === 'low') hints.push('This page does not look much like a job ad.');
  if (q.ambiguous) hints.push('This page lists several jobs. Check this is the right one.');
  const guessed = (q.guessed || []).map((f) => FIELD_NAMES[f] || f);
  if (guessed.length) hints.push(`Guessed from the page, not stated by it: ${guessed.join(', ')}. Check before saving.`);
  return hints;
}

// The title/company form: shown while either is a guess or missing, until a decision has been made.
function editFor(state) {
  if (state.decision) return null;
  const q = state.capture.quality;
  const unsure = (f) => (q.guessed || []).includes(f) || q.missing.includes(f);
  if (!unsure('title') && !unsure('company')) return null;
  return { title: state.capture.job.title || '', company: state.capture.job.company || '' };
}

// `reading` is set once the popup has asked for the page to be read; `gaveUp` once that has waited without an answer.
export function viewFor(state, tabUrl, { gaveUp = false, reading = false } = {}) {
  if (!state) {
    const reader = readerFor(tabUrl || '');
    if (reader.kind === 'duunitori') {
      return gaveUp
        ? { kind: 'waiting', message: GAVE_UP, actions: [{ id: 'scan-tab', label: 'Try again' }] }
        : { kind: 'waiting', message: 'Reading the ad…', actions: [] };
    }
    if (!reader.kind) return { kind: 'not-ad', message: WHY[reader.why] || 'This page cannot be read.' };
    if (reading) {
      return gaveUp
        ? { kind: 'waiting', message: GAVE_UP_GENERIC, actions: [{ id: 'scan-tab', label: 'Try again' }] }
        : { kind: 'waiting', message: 'Reading the page…', actions: [] };
    }
    return { kind: 'unknown-page', message: UNKNOWN_SITE, actions: [{ id: 'scan-tab', label: 'Read this page' }] };
  }
  if (state.status === 'unreadable') {
    const reason = /^Could not/.test(state.error) ? state.error : `Could not read this ad: ${state.error}`;
    return { kind: 'unreadable', message: reason, actions: [{ id: 'scan-tab', label: 'Try again' }], notice: '' };
  }
  const view = { kind: state.status, heading: headingOf(state), actions: [], notice: state.notice || '', hints: hintsFor(state), edit: editFor(state) };
  switch (state.status) {
    case 'scoring':
      view.message = 'Scoring…';
      view.actions.push(...decisionActions(state));
      break;
    case 'saving':
      view.message = 'Saving…';
      break;
    case 'scored': {
      const { fit_score: score, fit_reason: reason, cached } = state.preview;
      view.banner = bannerFor(state);
      view.cached = cached;
      if (typeof score === 'number') {
        view.score = score;
        view.scoreColor = scoreColor(score);
        view.reason = reason;
      } else {
        view.message = reason || 'No score available.';
      }
      if (state.decision) view.actions.push({ id: 'undo', label: LABELS.undo });
      else view.actions.push(...decisionActions(state));
      view.actions.push({ id: 'rescore', label: LABELS.rescore });
      break;
    }
    case 'queued': {
      const waiting = state.queueSize || 1;
      view.banner = state.decision.action === 'save' ? 'Saved locally' : 'Rejected locally';
      view.message = `Waiting for the backend (${waiting} queued). It will be sent automatically.`;
      view.actions.push({ id: 'flush', label: 'Try now' });
      break;
    }
    case 'expired':
      view.message = 'This ad has expired, so it was not scored.';
      view.actions.push(...decisionActions(state));
      break;
    case 'incomplete': {
      const missing = state.capture.quality.missing.map((f) => FIELD_LABELS[f] || f);
      view.message = `The ad could not be read completely (missing: ${missing.join(', ')}).`;
      if (state.capture.quality.missing.some((f) => f === 'descriptionSnippet' || f === 'fullDescription')) {
        view.hints.push('Select the ad text on the page and read it again.');
      }
      view.actions.push(...decisionActions(state));
      break;
    }
    case 'offline':
      view.message = `${state.error} Is the backend running? In Firefox, also check that the extension is allowed to access it (about:addons → Job Hunter → Permissions).`;
      view.actions.push(...decisionActions(state), { id: 'rescore', label: 'Try again' });
      break;
    case 'error':
      view.message = state.error;
      view.actions.push(...decisionActions(state), { id: 'rescore', label: 'Try again' });
      break;
    case 'idle':
      view.message = state.why === 'low-confidence'
        ? 'This page does not look much like a job ad, so it was not scored.'
        : 'Auto-scoring is off.';
      view.actions.push({ id: 'score-now', label: state.why === 'low-confidence' ? 'Score anyway' : 'Score this ad' }, ...decisionActions(state));
      break;
  }
  return view;
}
