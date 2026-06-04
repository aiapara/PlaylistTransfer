# Desktop Migration Plan

## 1. Architecture Assessment

The existing app should be converted to Electron, not rewritten. It already has the right separation:

- `apps/frontend` is a React/Vite UI that talks through a narrow `/api/*` boundary.
- `apps/backend` is an Express API with OAuth, playlist access, token storage, matching, transfer execution, and CSV export.
- `packages/shared` contains shared transfer and playlist types.
- SQLite is already a good local persistence layer for a personal desktop app.

The original web architecture assumed a separately hosted frontend origin, CORS, and production server deployment. Those are not needed for a desktop app.

## 2. Recommended Migration Plan

Use Electron as a local shell around the existing application:

- Start the existing Express app from Electron's main process.
- Serve the built React frontend from that local Express app.
- Keep `/api/*` routes unchanged for the renderer.
- Use `127.0.0.1:4000` OAuth redirect URIs for Spotify and Google.
- Store desktop configuration in Electron's user-data directory.
- Store tokens and transfer history in the existing encrypted SQLite token store.

This keeps playlist transfer logic intact and avoids rebuilding working UI or API code.

## 3. Reusable Files

These files can be reused directly:

- `apps/frontend/src/App.tsx`
- `apps/frontend/src/api.ts`
- `apps/frontend/src/main.tsx`
- `apps/frontend/src/styles.css`
- `apps/frontend/index.html`
- `apps/frontend/vite.config.ts`
- `apps/backend/src/services/spotify.ts`
- `apps/backend/src/services/youtube.ts`
- `apps/backend/src/services/matcher.ts`
- `apps/backend/src/services/transfers.ts`
- `apps/backend/src/services/tokenStore.ts`
- `apps/backend/src/db/index.ts`
- `apps/backend/src/db/schema.sql`
- `apps/backend/src/routes/playlists.ts`
- `apps/backend/src/routes/transfers.ts`
- `packages/shared/src/index.ts`

These files are reused with small desktop-aware changes:

- `apps/backend/src/app.ts`
- `apps/backend/src/routes/auth.ts`
- `apps/backend/src/env.ts`
- `README.md`
- `.env.example`
- `package.json`

New Electron files:

- `apps/desktop/package.json`
- `apps/desktop/tsconfig.json`
- `apps/desktop/src/main.ts`

## 4. Files That Should Be Deleted

No source files need to be deleted for this conversion.

`apps/backend/src/server.ts` can stay because it is useful for web development and API-only testing. It is not used by the desktop runtime. If the project becomes desktop-only later, it can be removed with the root `start` script.

## 5. Step-by-Step Conversion Plan

1. Add an Electron workspace at `apps/desktop`.
2. Build shared, backend, frontend, then desktop.
3. Generate local desktop configuration in Electron's user-data directory.
4. Start the existing backend from Electron's main process.
5. Serve the frontend build from the local backend.
6. Redirect OAuth callbacks back to `/` in desktop mode.
7. Disable CORS and secure cookies in desktop mode because the app is same-origin localhost.
8. Keep token encryption and SQLite persistence local.
9. Keep all Spotify, YouTube, matching, and transfer services intact.
10. Remove hosted-deployment guidance from the recommended README path.

## 6. Web-Specific Code Removed Or Neutralized

- Desktop mode no longer depends on `FRONTEND_URL` for callback navigation.
- CORS is skipped in desktop mode.
- Secure cookies are disabled in desktop mode because the local app is served over HTTP loopback.
- The built frontend is served locally by the backend, removing the need for a hosted frontend server.
- Production deployment guidance was replaced with desktop usage guidance.
- Desktop config is generated with `NODE_ENV=development` because this is a local single-user runtime, not a multi-process hosted server.

## 7. Current Implementation Status

Implemented as a conversion:

- Electron desktop workspace added.
- Local config generation added.
- Backend local static serving added.
- Desktop OAuth callback redirects added.
- OAuth provider credentials now fail at login/use time instead of preventing app startup.
- Playlist transfer logic remains untouched.
