// Decides what the popup shows. Pure: the DOM code in popup.js only renders the result.
import { scoreColor } from '../lib/badge.js';

export const AD_URL = /^https?:\/\/(www\.)?duunitori\.fi\/tyopaikat\/tyo\/[^/?#]+\/?(?:[?#].*)?$/;

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

// `gaveUp` is set by the popup after it has asked the page to be read (scan-tab) and waited without an answer.
export function viewFor(state, tabUrl, { gaveUp = false } = {}) {
  if (!state) {
    if (!AD_URL.test(tabUrl || '')) return { kind: 'not-ad', message: 'Open a Duunitori job ad to see how well it fits you.' };
    return gaveUp
      ? { kind: 'waiting', message: GAVE_UP, actions: [{ id: 'scan-tab', label: 'Try again' }] }
      : { kind: 'waiting', message: 'Reading the ad…', actions: [] };
  }
  if (state.status === 'unreadable') {
    const reason = /^Could not/.test(state.error) ? state.error : `Could not read this ad: ${state.error}`;
    return { kind: 'unreadable', message: reason, actions: [{ id: 'scan-tab', label: 'Try again' }], notice: '' };
  }
  const view = { kind: state.status, heading: headingOf(state), actions: [], notice: state.notice || '' };
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
      view.message = 'Auto-scoring is off.';
      view.actions.push({ id: 'score-now', label: 'Score this ad' }, ...decisionActions(state));
      break;
  }
  return view;
}
