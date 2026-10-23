export const DEFAULT_SETTINGS = {
  backendUrl: 'http://jobs.test',
  autoScore: true, // score an ad as soon as its tab is visible; off = only when asked
};

export function createSettings(area) {
  return {
    async get() {
      const { settings } = await area.get('settings');
      return { ...DEFAULT_SETTINGS, ...(settings || {}) };
    },
    async set(patch) {
      const next = { ...(await this.get()), ...patch };
      await area.set({ settings: next });
      return next;
    },
  };
}
