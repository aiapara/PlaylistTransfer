import type { SourcePlaylist, TrackRef } from "@playlist-transfer/shared";
import { env } from "../env.js";
import { fetchJson, formBody } from "../lib/http.js";
import { getToken, saveToken } from "./tokenStore.js";

const SPOTIFY_API = "https://api.spotify.com/v1";
const SPOTIFY_ACCOUNTS = "https://accounts.spotify.com";

type SpotifyTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

type SpotifyUser = {
  id: string;
  display_name?: string;
};

type SpotifyPlaylist = {
  id: string;
  name: string;
  description?: string;
  owner?: { display_name?: string };
  tracks: { total: number };
  images?: { url: string }[];
};

type SpotifyPage<T> = {
  items: T[];
  next: string | null;
};

type SpotifyTrack = {
  id: string;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  album?: { name: string };
  external_ids?: { isrc?: string };
};

async function spotifyRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getSpotifyAccessToken();
  return fetchJson<T>(`${SPOTIFY_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers
    }
  });
}

export function spotifyLoginUrl(state: string): string {
  assertSpotifyConfig();
  const scopes = [
    "playlist-read-private",
    "playlist-read-collaborative",
    "playlist-modify-private",
    "user-library-read"
  ].join(" ");

  return `${SPOTIFY_ACCOUNTS}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: env.SPOTIFY_CLIENT_ID,
    scope: scopes,
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
    state
  })}`;
}

export async function exchangeSpotifyCode(code: string): Promise<void> {
  assertSpotifyConfig();
  const basic = Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString("base64");
  const token = await fetchJson<SpotifyTokenResponse>(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: env.SPOTIFY_REDIRECT_URI
    })
  });

  const user = await fetchJson<SpotifyUser>(`${SPOTIFY_API}/me`, {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });

  saveToken({
    provider: "spotify",
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    profileId: user.id,
    profileName: user.display_name ?? user.id
  });
}

export async function getSpotifyAccessToken(): Promise<string> {
  assertSpotifyConfig();
  const token = getToken("spotify");
  if (!token) throw new Error("Spotify is not connected.");
  if (token.expiresAt > Date.now() + 60_000) return token.accessToken;
  if (!token.refreshToken) throw new Error("Spotify refresh token is unavailable.");

  const basic = Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString("base64");
  const refreshed = await fetchJson<SpotifyTokenResponse>(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formBody({
      grant_type: "refresh_token",
      refresh_token: token.refreshToken
    })
  });

  saveToken({
    ...token,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? token.refreshToken,
    expiresAt: Date.now() + refreshed.expires_in * 1000
  });

  return refreshed.access_token;
}

function assertSpotifyConfig(): void {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    throw new Error("Configure SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the local desktop config file.");
  }
}

export async function listSpotifyPlaylists(): Promise<SourcePlaylist[]> {
  const playlists: SourcePlaylist[] = [
    {
      id: "liked-songs",
      source: "spotify",
      title: "Spotify Liked Songs",
      description: "Virtual playlist generated from your Spotify saved tracks.",
      totalTracks: await countLikedSongs(),
      isLikedSongs: true
    }
  ];

  let next: string | null = `${SPOTIFY_API}/me/playlists?limit=50`;

  while (next) {
    const page: SpotifyPage<SpotifyPlaylist> = await fetchJson(next, {
      headers: { Authorization: `Bearer ${await getSpotifyAccessToken()}` }
    });

    playlists.push(
      ...page.items.map((playlist) => ({
        id: playlist.id,
        source: "spotify" as const,
        title: playlist.name,
        description: playlist.description ?? "",
        totalTracks: playlist.tracks.total,
        imageUrl: playlist.images?.[0]?.url,
        owner: playlist.owner?.display_name,
        isLikedSongs: false
      }))
    );
    next = page.next;
  }

  return playlists;
}

export async function getPlaylistTracks(playlistId: string): Promise<TrackRef[]> {
  if (playlistId === "liked-songs") return getLikedSongs();

  const tracks: TrackRef[] = [];
  let next: string | null = `${SPOTIFY_API}/playlists/${playlistId}/tracks?limit=100&fields=items(track(id,name,duration_ms,artists(name),album(name),external_ids(isrc))),next`;

  while (next) {
    const page: SpotifyPage<{ track: SpotifyTrack | null }> = await fetchJson(next, {
      headers: { Authorization: `Bearer ${await getSpotifyAccessToken()}` }
    });
    tracks.push(...page.items.flatMap((item) => (item.track ? [toTrackRef(item.track)] : [])));
    next = page.next;
  }

  return tracks;
}

export async function getLikedSongs(): Promise<TrackRef[]> {
  const tracks: TrackRef[] = [];
  let next: string | null = `${SPOTIFY_API}/me/tracks?limit=50`;

  while (next) {
    const page: SpotifyPage<{ track: SpotifyTrack }> = await fetchJson(next, {
      headers: { Authorization: `Bearer ${await getSpotifyAccessToken()}` }
    });
    tracks.push(...page.items.map((item) => toTrackRef(item.track)));
    next = page.next;
  }

  return tracks;
}

export async function materializeLikedSongs(): Promise<{ id: string; name: string }> {
  const token = getToken("spotify");
  if (!token?.profileId) throw new Error("Spotify profile is unavailable.");

  const tracks = await getLikedSongs();
  const playlist = await spotifyRequest<{ id: string; name: string }>(`/users/${token.profileId}/playlists`, {
    method: "POST",
    body: JSON.stringify({
      name: `Liked Songs Transfer ${new Date().toISOString().slice(0, 10)}`,
      description: "Temporary private playlist created by Playlist Transfer from Spotify Liked Songs.",
      public: false
    })
  });

  for (let i = 0; i < tracks.length; i += 100) {
    const uris = tracks.slice(i, i + 100).map((track) => `spotify:track:${track.sourceId}`);
    await spotifyRequest(`/playlists/${playlist.id}/tracks`, {
      method: "POST",
      body: JSON.stringify({ uris })
    });
  }

  return playlist;
}

async function countLikedSongs(): Promise<number> {
  const page = await spotifyRequest<{ total: number }>("/me/tracks?limit=1");
  return page.total;
}

function toTrackRef(track: SpotifyTrack): TrackRef {
  return {
    sourceId: track.id,
    title: track.name,
    artists: track.artists.map((artist) => artist.name),
    album: track.album?.name,
    durationMs: track.duration_ms,
    isrc: track.external_ids?.isrc
  };
}
