// Chrome exposes `chrome.*`, Firefox exposes `browser.*` (and `chrome.*` as a callback-style alias).
// Both return promises from MV3 `chrome.*` calls, so one name is enough.
export const api = globalThis.browser ?? globalThis.chrome;
