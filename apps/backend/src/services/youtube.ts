import type { CandidateMatch } from "@playlist-transfer/shared";
import { env } from "../env.js";
import { fetchJson, formBody } from "../lib/http.js";
import { getToken, saveToken } from "./tokenStore.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

type GoogleTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

type YouTubePlaylist = {
  id: string;
  snippet: {
    title: string;
    description?: string;
  };
};

type YouTubeSearchItem = {
  id: { videoId?: string };
  snippet: {
    title: string;
    channelTitle: string;
    description?: string;
  };
};

export function youtubeLoginUrl(state: string): string {
  return `${GOOGLE_AUTH}?${new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube.force-ssl",
    access_type: "offline",
    prompt: "consent",
    state
  })}`;
}

export async function exchangeYoutubeCode(code: string): Promise<void> {
  const token = await fetchJson<GoogleTokenResponse>(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: env.GOOGLE_REDIRECT_URI
    })
  });

  saveToken({
    provider: "youtube",
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000
  });
}

export async function getYoutubeAccessToken(): Promise<string> {
  const token = getToken("youtube");
  if (!token) throw new Error("YouTube is not connected.");
  if (token.expiresAt > Date.now() + 60_000) return token.accessToken;
  if (!token.refreshToken) throw new Error("Google refresh token is unavailable.");

  const refreshed = await fetchJson<GoogleTokenResponse>(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
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

async function youtubeRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return fetchJson<T>(`${YOUTUBE_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await getYoutubeAccessToken()}`,
      "Content-Type": "application/json",
      ...init?.headers
    }
  });
}

export async function searchYoutube(query: string): Promise<CandidateMatch[]> {
  const response = await youtubeRequest<{ items: YouTubeSearchItem[] }>(
    `/search?${new URLSearchParams({
      part: "snippet",
      maxResults: "8",
      q: query,
      type: "video",
      videoCategoryId: "10"
    })}`
  );

  return response.items
    .filter((item) => item.id.videoId)
    .map((item) => ({
      videoId: item.id.videoId!,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      description: item.snippet.description,
      score: 0,
      confidence: "low"
    }));
}

export async function findOrCreatePlaylist(title: string, description: string): Promise<string> {
  const existing = await listMyPlaylists();
  const match = existing.find((playlist) => playlist.snippet.title.trim().toLowerCase() === title.trim().toLowerCase());
  if (match) return match.id;

  const created = await youtubeRequest<YouTubePlaylist>("/playlists?part=snippet,status", {
    method: "POST",
    body: JSON.stringify({
      snippet: { title, description },
      status: { privacyStatus: "private" }
    })
  });

  return created.id;
}

export async function listPlaylistVideoIds(playlistId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let pageToken = "";

  do {
    const response = await youtubeRequest<{
      nextPageToken?: string;
      items: { snippet: { resourceId: { videoId?: string } } }[];
    }>(
      `/playlistItems?${new URLSearchParams({
        part: "snippet",
        playlistId,
        maxResults: "50",
        ...(pageToken ? { pageToken } : {})
      })}`
    );

    for (const item of response.items) {
      if (item.snippet.resourceId.videoId) ids.add(item.snippet.resourceId.videoId);
    }

    pageToken = response.nextPageToken ?? "";
  } while (pageToken);

  return ids;
}

export async function addVideoToPlaylist(playlistId: string, videoId: string): Promise<void> {
  await youtubeRequest("/playlistItems?part=snippet", {
    method: "POST",
    body: JSON.stringify({
      snippet: {
        playlistId,
        resourceId: {
          kind: "youtube#video",
          videoId
        }
      }
    })
  });
}

async function listMyPlaylists(): Promise<YouTubePlaylist[]> {
  const playlists: YouTubePlaylist[] = [];
  let pageToken = "";

  do {
    const response = await youtubeRequest<{ nextPageToken?: string; items: YouTubePlaylist[] }>(
      `/playlists?${new URLSearchParams({
        part: "snippet",
        mine: "true",
        maxResults: "50",
        ...(pageToken ? { pageToken } : {})
      })}`
    );
    playlists.push(...response.items);
    pageToken = response.nextPageToken ?? "";
  } while (pageToken);

  return playlists;
}
