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
- Matched, unmatched, skipped, and low-confidence manual review states.
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
   - Add this exact redirect URI: `http://127.0.0.1:4000/api/auth/spotify/callback`
   - Copy the Spotify Client ID and Client Secret into the app settings screen.
   - Scopes used by the app: `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`, `playlist-modify-private`

5. Configure Google:

   - Create an OAuth client in Google Cloud Console.
   - Enable YouTube Data API v3.
   - Add this exact redirect URI: `http://127.0.0.1:4000/api/auth/youtube/callback`
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

This repo now favors a local Electron desktop app over hosted deployment. The desktop app starts the existing Node backend on `127.0.0.1:4000`, serves the built React frontend from that local backend, stores OAuth tokens in a local SQLite database, and stores desktop configuration in Electron's user-data directory.

Run it with:

```bash
npm run desktop
```

On first launch, the app creates a local `playlist-transfer.env` file in Electron's user-data directory and opens the in-app setup screen. Save Spotify and Google OAuth credentials there, using these redirect URIs:

- `http://127.0.0.1:4000/api/auth/spotify/callback`
- `http://127.0.0.1:4000/api/auth/youtube/callback`

The generated local config includes stable `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, and `DATABASE_PATH` values. Keep those values if you want previously stored tokens to remain readable.

## Architecture Notes

- The React frontend is reused as-is and continues to call same-origin `/api/*` routes.
- The Node backend is reused inside Electron and still owns OAuth callbacks, playlist reads, matching, transfer execution, and CSV export.
- The SQLite token and transfer store remains local-only.
- Hosted-server deployment, remote secret managers, and multi-user infrastructure are no longer part of the recommended path.

## MVP Limitations

- Destination insertion uses YouTube video IDs, because the official API does not insert YouTube Music song IDs.
- YouTube API quota is significant: `playlistItems.insert` costs quota units per track.
- Search quality depends on YouTube results. Low-confidence results are held for review and skipped unless manually selected in a future enhancement.
- Resume is implemented at transfer-item level; a killed process can continue from pending/failed items when transfer is started again.

## Future Improvements

- Manual candidate override UI for low-confidence matches.
- True sync mode that removes destination items no longer present in Spotify.
- Optional unofficial `ytmusicapi` bridge for users who explicitly accept the tradeoffs.
- Postgres migrations and multi-user deployment hardening.
- Background worker queue with scheduled retries.
