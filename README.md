# Playlist Transfer

Personal-use app for transferring Spotify playlists, including Spotify Liked Songs, into YouTube playlists that are usable from YouTube Music.

## Current API Reality as of June 4, 2026

- Spotify supports OAuth 2.0 and exposes playlists plus the current user's saved tracks through the official Spotify Web API.
- Spotify Liked Songs are not a normal playlist. This app treats them as a virtual playlist and can optionally materialize them as a real private Spotify playlist.
- Google does not provide an official YouTube Music-specific public API for creating YouTube Music library playlists. The reliable official option is YouTube Data API v3: create a YouTube playlist, search for videos, and add matched videos to that playlist.
- Community projects such as `ytmusicapi` emulate YouTube Music web calls and may offer richer Music-specific behavior, but they are unofficial, can break without notice, and may conflict with platform terms depending on usage.

Recommended MVP approach: use official Spotify Web API plus official YouTube Data API v3. The destination playlist appears in YouTube and is generally accessible in YouTube Music, but exact catalog-song insertion is not guaranteed because the official API adds YouTube videos, not YouTube Music song entities.

Sources:
- Spotify authorization and PKCE guidance: https://developer.spotify.com/documentation/web-api/concepts/authorization
- Spotify playlists concept docs: https://developer.spotify.com/documentation/web-api/concepts/playlists
- YouTube Data API playlist item insertion: https://developers.google.com/youtube/v3/docs/playlistItems/insert
- YouTube Data API playlist implementation guide: https://developers.google.com/youtube/v3/guides/implementation/playlists
- ytmusicapi unofficial API docs: https://ytmusicapi.readthedocs.io/

## Features

- Spotify OAuth login.
- Google OAuth login for YouTube Data API.
- Playlist picker with a virtual "Spotify Liked Songs" source.
- Match preview with confidence scores.
- Manual review workflow for low-confidence and unmatched tracks, including candidate approval, skip decisions, search again, and persisted review progress.
- Matched, manually approved, unmatched, skipped, transferred, and low-confidence manual review states.
- Batch transfer with retry, rate-limit delays, resumable transfer records, and operation logs.
- Duplicate destination detection by video ID.
- Transfer history.
- Export unmatched tracks to CSV.
- Dark mode UI.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the desktop app:

   ```bash
   npm run desktop
   ```

3. On first launch, fill in the in-app Desktop Setup screen and click Save Settings.

4. Configure Spotify:

   - Create an app at https://developer.spotify.com/dashboard
   - Add the exact Spotify redirect URI shown in the Desktop Setup screen. The app prefers `http://127.0.0.1:4000/api/auth/spotify/callback`, but it can choose another local port if `4000` is already in use.
   - Copy the Spotify Client ID and Client Secret into the app settings screen.
   - Scopes used by the app: `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`, `playlist-modify-private`

5. Configure Google:

   - Create an OAuth client in Google Cloud Console.
   - Enable YouTube Data API v3.
   - Add the exact YouTube redirect URI shown in the Desktop Setup screen. The app prefers `http://127.0.0.1:4000/api/auth/youtube/callback`, with the same local-port fallback behavior.
   - Copy the Google Client ID and Client Secret into the app settings screen.
   - OAuth scope used by the app: `https://www.googleapis.com/auth/youtube.force-ssl`

The setup screen validates required IDs, secrets, redirect URIs, and the local token encryption key before enabling the transfer flow. Use Open Config Folder from the setup screen if you need to inspect the generated local config.

## Web Development

The web development app is still available for local development.

1. Create environment file:

   ```bash
   cp .env.example .env
   ```

2. Generate a token encryption key:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

3. Configure Spotify:

   - Create an app at https://developer.spotify.com/dashboard
   - Add redirect URI: `http://localhost:4000/api/auth/spotify/callback`
   - Scopes used: `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`, `playlist-modify-private`

4. Configure Google:

   - Create an OAuth client in Google Cloud Console.
   - Enable YouTube Data API v3.
   - Add redirect URI: `http://localhost:4000/api/auth/youtube/callback`
   - OAuth scope used: `https://www.googleapis.com/auth/youtube.force-ssl`

5. Run the web development app:

   ```bash
   npm run dev
   ```

   Frontend: http://localhost:5173  
   Backend: http://localhost:4000

## Desktop App

This repo now favors a local Electron desktop app over hosted deployment. The desktop app starts the existing Node backend on loopback, serves the built React frontend from that local backend, stores OAuth tokens in a local SQLite database, and stores desktop configuration in Electron's user-data directory.

Run it with:

```bash
npm run desktop
```

On first launch, the app creates a local `playlist-transfer.env` file in Electron's user-data directory and opens the in-app setup screen. The app tries `127.0.0.1:4000` first. If that port is occupied, it binds a safe dynamic loopback port and updates the required OAuth redirect URIs for the current run.

Use the exact redirect URIs displayed in the setup screen when configuring Spotify and Google. If the fallback port changes later, the setup screen will show the new required values.

The generated local config includes stable `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, and `DATABASE_PATH` values. Keep those values if you want previously stored tokens to remain readable. The app writes and rewrites this file with owner-only permissions where the operating system supports them.

Desktop OAuth starts in the system browser instead of navigating the main Electron window away from the app. After the provider callback succeeds, return to Playlist Transfer; the app refreshes connection status when the window regains focus.

## Architecture Notes

- The React frontend is reused as-is and continues to call same-origin `/api/*` routes.
- The Node backend is reused inside Electron and still owns OAuth callbacks, playlist reads, matching, manual review decisions, transfer execution, and CSV export.
- The SQLite token and transfer store remains local-only.
- SQLite schema changes are applied through ordered startup migrations recorded in `schema_migrations`. Manual review metadata lives on `transfer_items` with the selected candidate, item status, `selection_source`, and `reviewed_at`.
- Hosted-server deployment, remote secret managers, and multi-user infrastructure are no longer part of the recommended path.

## Manual Review Flow

After matching finishes, the transfer screen shows a Match Review workspace. Use the filters for matched, approved, review, unmatched, and skipped tracks. Tracks in review or unmatched must be approved or skipped before transfer starts.

Review actions are persisted immediately:

- Approve stores the selected YouTube candidate as the official match and marks the item `approved`.
- Skip marks the item `skipped`, excluding it from transfer.
- Search Again updates the stored candidate list for that track and keeps the item unresolved until a candidate is approved or the track is skipped.

The backend routes are:

- `POST /api/transfers/:id/items/:itemId/approve`
- `POST /api/transfers/:id/items/:itemId/skip`
- `POST /api/transfers/:id/items/:itemId/search`

Transfer start is blocked while unresolved `review` or `unmatched` items remain, so users do not accidentally omit uncertain tracks.

## Development Checks

Run the main validation commands from the repository root:

```bash
npm run typecheck
npm run build
npm run lint
npm test
```

`npm run lint` uses ESLint 9 flat config. `npm test` uses Node's test runner through `tsx` and mocks service boundaries instead of calling Spotify or YouTube.

## MVP Limitations

- Destination insertion uses YouTube video IDs, because the official API does not insert YouTube Music song IDs.
- YouTube API quota is significant: `playlistItems.insert` costs quota units per track.
- Search quality depends on YouTube results. Low-confidence results are held for review and can be approved, skipped, or searched again.
- Resume is implemented at transfer-item level; a killed process can continue from pending/failed items when transfer is started again.

## Future Improvements

- True sync mode that removes destination items no longer present in Spotify.
- Optional unofficial `ytmusicapi` bridge for users who explicitly accept the tradeoffs.
- Postgres migrations and multi-user deployment hardening.
- Durable background worker queue with scheduled retries.
