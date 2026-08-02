// Thin guard around the preload-exposed `window.api` bridge.
//
// The backend agent's preload script attaches `window.api` via
// contextBridge before any renderer script runs, so reading it once at
// module-init time is safe. When running the renderer outside Electron
// (e.g. plain `vite dev` in a browser) `window.api` is undefined and the
// app should show a friendly notice instead of crashing on IPC calls.

export const api = typeof window !== 'undefined' ? window.api : undefined;
export const HAS_API = !!api;
