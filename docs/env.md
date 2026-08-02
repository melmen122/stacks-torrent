# Environment Variables

## Development

### `VITE_DEV_SERVER_URL`
Set automatically by `npm run dev` via `wait-on` + `concurrently`. Points to the Vite dev server (e.g., `http://localhost:5173`). When set, Electron loads from this URL instead of the packaged `dist/index.html`, enabling hot-reload during development.

**Set by:** concurrently / wait-on in `npm run dev`  
**Used by:** electron/main.js `createWindow()`  
**Default:** undefined (falls back to prod build)

### `NODE_ENV`
Not explicitly used in the current codebase, but Vite respects it for build optimizations.

## Build & Distribution

### `npm run dist:mac`
Builds the app for macOS (DMG format). No special env vars required; uses `electron-builder` configuration from `package.json`.

### `npm run dist:win`
Builds the app for Windows (NSIS installer). No special env vars required; uses `electron-builder` configuration from `package.json`.

## Runtime

**No runtime environment variables are required.** All configuration is persisted in `settings.json` (user data directory) and the IPC `settings:get` / `settings:set` API.

## Notes

- Environment is detected at runtime via `app.isPackaged` (true for production builds, false in dev/test)
- Electron's user data directory is managed by `app.getPath('userData')` — no env var configuration needed
- Web server (e.g., for dev server) is localhost-only; not configurable via env

---

## Build Configuration

See `package.json` and `electron-builder` settings in package.json `build` section:

```json
{
  "build": {
    "appId": "com.melvin.audiobooklibrary",
    "productName": "Audiobook Library",
    "mac": { "target": "dmg", "category": "public.app-category.utilities" },
    "win": { "target": "nsis" }
  }
}
```

These can be overridden via `electron-builder` CLI flags if needed (see `electron-builder` docs).
