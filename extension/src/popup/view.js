// Decides what the popup shows. Pure: the DOM code in popup.js only renders the result.
import { scoreColor } from '../lib/badge.js';

export const AD_URL = /^https?:\/\/(www\.)?duunitori\.fi\/tyopaikat\/tyo\/[^/?#]+\/?(?:[?#].*)?$/;

const FIELD_LABELS = {
  title: 'title',
  company: 'company',
  descriptionSnippet: 'description',
  fullDescription: 'full description',
};

function headingOf(state) {
  const job = state.capture.job;
  return {
    title: job.title,
    company: job.company,
    location: job.location,
    deadline: job.deadline,
  };
}

export function viewFor(state, tabUrl) {
  if (!state) {
    return AD_URL.test(tabUrl || '')
      ? { kind: 'waiting', message: 'Reload this page so the extension can read the ad.' }
      : { kind: 'not-ad', message: 'Open a Duunitori job ad to see how well it fits you.' };
  }
  const view = { kind: state.status, heading: headingOf(state), actions: [] };
  switch (state.status) {
    case 'scoring':
      view.message = 'Scoring…';
      break;
    case 'scored': {
      const { fit_score: score, fit_reason: reason, status, cached } = state.preview;
      view.status = status; // seen | saved | rejected | applied
      view.cached = cached;
      if (typeof score === 'number') {
        view.score = score;
        view.scoreColor = scoreColor(score);
        view.reason = reason;
      } else {
        view.message = reason || 'No score available.';
      }
      view.actions.push({ id: 'rescore', label: 'Score again' });
      break;
    }
    case 'expired':
      view.message = 'This ad has expired, so it was not scored.';
      break;
    case 'incomplete': {
      const missing = state.capture.quality.missing.map((f) => FIELD_LABELS[f] || f);
      view.message = `The ad could not be read completely (missing: ${missing.join(', ')}).`;
      break;
    }
    case 'offline':
      view.message = `${state.error} Is the backend running?`;
      view.actions.push({ id: 'rescore', label: 'Try again' });
      break;
    case 'error':
      view.message = state.error;
      view.actions.push({ id: 'rescore', label: 'Try again' });
      break;
    case 'idle':
      view.message = 'Auto-scoring is off.';
      view.actions.push({ id: 'score-now', label: 'Score this ad' });
      break;
  }
  return view;
}
