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

2. Create environment file:

   ```bash
   cp .env.example .env
   ```

3. Generate a token encryption key:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

4. Configure Spotify:

   - Create an app at https://developer.spotify.com/dashboard
   - Add redirect URI: `http://localhost:4000/api/auth/spotify/callback`
   - Scopes used: `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`, `playlist-modify-private`

5. Configure Google:

   - Create an OAuth client in Google Cloud Console.
   - Enable YouTube Data API v3.
   - Add redirect URI: `http://localhost:4000/api/auth/youtube/callback`
   - OAuth scope used: `https://www.googleapis.com/auth/youtube.force-ssl`

6. Run locally:

   ```bash
   npm run dev
   ```

   Frontend: http://localhost:5173  
   Backend: http://localhost:4000

## Production Deployment

- Use HTTPS only.
- Set `NODE_ENV=production`.
- Use strong `SESSION_SECRET` and a stable 32-byte `TOKEN_ENCRYPTION_KEY`.
- Store `.env` in a secret manager.
- Use a persistent database path or replace SQLite with Postgres.
- Restrict OAuth redirect URIs to your production domain.
- Review Google OAuth verification requirements if the app is used beyond personal/internal use.
- Keep logs free of tokens and personally sensitive data.

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
