// What the toolbar badge shows for a tab. Pure, so it is unit tested.

const GREY = '#5e6c84';
const RED = '#c62828';
const AMBER = '#b26a00';
const GREEN = '#2e7d32';

export function scoreColor(score) {
  if (score >= 70) return GREEN;
  if (score >= 40) return AMBER;
  return RED;
}

export function badgeFor(state) {
  if (!state) return { text: '', color: GREY };
  switch (state.status) {
    case 'scoring':
      return { text: '…', color: GREY };
    case 'expired':
      return { text: 'exp', color: GREY };
    case 'incomplete':
      return { text: '?', color: AMBER };
    case 'offline':
    case 'error':
      return { text: '!', color: RED };
    case 'scored': {
      const { status, fit_score: score } = state.preview;
      if (status === 'saved') return { text: '✓', color: GREEN };
      if (status === 'applied') return { text: 'A', color: GREEN };
      if (status === 'rejected') return { text: '✗', color: GREY };
      if (typeof score !== 'number') return { text: '–', color: GREY }; // seen, but no score (e.g. no API key)
      return { text: String(Math.round(score)), color: scoreColor(score) };
    }
    default: // 'idle': auto-scoring is off
      return { text: '', color: GREY };
  }
}
