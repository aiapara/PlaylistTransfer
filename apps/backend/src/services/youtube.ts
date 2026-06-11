import type { CandidateMatch, CandidateMetadata, CandidateSourceKind, CandidateThumbnail } from "@playlist-transfer/shared";
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
    publishedAt?: string;
    channelId?: string;
    channelTitle: string;
    description?: string;
    thumbnails?: YouTubeThumbnails;
  };
};

type YouTubeVideoDetails = {
  id: string;
  snippet?: {
    title?: string;
    publishedAt?: string;
    channelId?: string;
    channelTitle?: string;
    description?: string;
    thumbnails?: YouTubeThumbnails;
    tags?: string[];
  };
  contentDetails?: {
    duration?: string;
  };
  status?: {
    uploadStatus?: string;
    privacyStatus?: string;
  };
  topicDetails?: {
    topicCategories?: string[];
  };
};

type YouTubeThumbnails = {
  default?: CandidateThumbnail;
  medium?: CandidateThumbnail;
  high?: CandidateThumbnail;
};

type CandidateSearchProvider = {
  id: CandidateSourceKind;
  label: string;
  search: (query: string) => Promise<CandidateMatch[]>;
};

export type VideoAvailability = {
  videoId: string;
  available: boolean;
  title?: string;
  privacyStatus?: string;
  reason?: string;
};

export function youtubeLoginUrl(state: string): string {
  assertYoutubeConfig();
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
  assertYoutubeConfig();
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
  assertYoutubeConfig();
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

function assertYoutubeConfig(): void {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the local desktop config file.");
  }
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

const searchProviders: CandidateSearchProvider[] = [
  {
    id: "youtube_music",
    label: "YouTube Music",
    search: searchYoutubeMusicCatalog
  },
  {
    id: "youtube_video",
    label: "YouTube Video",
    search: searchYoutubeVideos
  }
];

export async function searchYoutube(query: string): Promise<CandidateMatch[]> {
  return searchCandidates(query);
}

export async function searchCandidates(query: string, providers: CandidateSearchProvider[] = searchProviders): Promise<CandidateMatch[]> {
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        return { candidates: await provider.search(query), error: undefined };
      } catch (error) {
        return { candidates: [] as CandidateMatch[], error };
      }
    })
  );

  if (results.every((result) => result.error)) {
    throw results[0].error;
  }

  const merged = new Map<string, CandidateMatch>();
  for (const candidate of results.flatMap((result) => result.candidates)) {
    const existing = merged.get(candidate.videoId);
    merged.set(candidate.videoId, existing ? mergeCandidate(existing, candidate) : candidate);
  }

  return [...merged.values()];
}

async function searchYoutubeMusicCatalog(query: string): Promise<CandidateMatch[]> {
  return searchYoutubeProvider(`${query} official song`, "youtube_music", "YouTube Music", 10);
}

async function searchYoutubeVideos(query: string): Promise<CandidateMatch[]> {
  return searchYoutubeProvider(query, "youtube_video", "YouTube Video", 8);
}

async function searchYoutubeProvider(
  query: string,
  source: CandidateSourceKind,
  sourceLabel: string,
  maxResults: number
): Promise<CandidateMatch[]> {
  const response = await youtubeRequest<{ items: YouTubeSearchItem[] }>(
    `/search?${new URLSearchParams({
      part: "snippet",
      maxResults: String(maxResults),
      q: query,
      type: "video",
      videoCategoryId: "10"
    })}`
  );

  const baseCandidates: CandidateMatch[] = response.items
    .filter((item) => item.id.videoId)
    .map((item) => ({
      videoId: item.id.videoId!,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      description: item.snippet.description,
      score: 0,
      confidence: "low",
      metadata: buildCandidateMetadata({
        source,
        sourceLabel,
        videoId: item.id.videoId!,
        title: item.snippet.title,
        channelTitle: item.snippet.channelTitle,
        channelId: item.snippet.channelId,
        description: item.snippet.description,
        publishedAt: item.snippet.publishedAt,
        thumbnails: item.snippet.thumbnails
      })
    }));

  if (baseCandidates.length === 0) return baseCandidates;

  const details = await videoDetails(baseCandidates.map((candidate) => candidate.videoId)).catch(() => new Map<string, YouTubeVideoDetails>());
  return baseCandidates.map((candidate) => hydrateCandidate(candidate, details.get(candidate.videoId)));
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

export async function checkVideoAvailability(videoIds: string[]): Promise<VideoAvailability[]> {
  const uniqueIds = [...new Set(videoIds)];
  if (uniqueIds.length === 0) return [];

  const details = await videoDetails(uniqueIds);
  return uniqueIds.map((videoId) => {
    const item = details.get(videoId);
    if (!item) {
      return {
        videoId,
        available: false,
        reason: "Video is unavailable, private, or deleted."
      };
    }

    const privacyStatus = item.status?.privacyStatus;
    const uploadStatus = item.status?.uploadStatus;
    const available = privacyStatus !== "private" && !["deleted", "failed", "rejected"].includes(uploadStatus ?? "");

    return {
      videoId,
      available,
      title: item.snippet?.title,
      privacyStatus,
      reason: available ? undefined : availabilityReason(privacyStatus, uploadStatus)
    };
  });
}

async function videoDetails(videoIds: string[]): Promise<Map<string, YouTubeVideoDetails>> {
  const response = await youtubeRequest<{ items: YouTubeVideoDetails[] }>(
    `/videos?${new URLSearchParams({
      part: "snippet,contentDetails,status,topicDetails",
      id: videoIds.join(",")
    })}`
  );

  return new Map(response.items.map((item) => [item.id, item]));
}

function hydrateCandidate(candidate: CandidateMatch, details: YouTubeVideoDetails | undefined): CandidateMatch {
  if (!details) return candidate;

  const metadata = buildCandidateMetadata({
    source: candidate.metadata?.source ?? "youtube_video",
    sourceLabel: candidate.metadata?.sourceLabel ?? "YouTube Video",
    videoId: candidate.videoId,
    title: details.snippet?.title ?? candidate.title,
    channelTitle: details.snippet?.channelTitle ?? candidate.channelTitle,
    channelId: details.snippet?.channelId,
    description: details.snippet?.description ?? candidate.description,
    publishedAt: details.snippet?.publishedAt,
    thumbnails: details.snippet?.thumbnails ?? candidate.metadata?.thumbnails,
    topicCategories: details.topicDetails?.topicCategories
  });

  return {
    ...candidate,
    title: details.snippet?.title ?? candidate.title,
    channelTitle: details.snippet?.channelTitle ?? candidate.channelTitle,
    description: details.snippet?.description ?? candidate.description,
    durationMs: parseYouTubeDuration(details.contentDetails?.duration ?? "") ?? candidate.durationMs,
    metadata: mergeCandidateMetadata(candidate.metadata, metadata)
  };
}

function buildCandidateMetadata(input: {
  source: CandidateSourceKind;
  sourceLabel: string;
  videoId: string;
  title: string;
  channelTitle: string;
  channelId?: string;
  description?: string;
  publishedAt?: string;
  thumbnails?: YouTubeThumbnails;
  topicCategories?: string[];
}): CandidateMetadata {
  const music = musicMetadataFromDescription(input.description ?? "");
  const officialTrack = isOfficialTrack(input.title, input.channelTitle, input.description);
  const officialArtist = isOfficialArtistChannel(input.channelTitle, input.description);
  const source = sourceFor(input.source, officialTrack, officialArtist);
  const badges = [
    input.source === "youtube_music" ? "YouTube Music" : undefined,
    officialTrack ? "Official Track" : undefined,
    officialArtist ? "Official Artist" : undefined,
    input.channelTitle.endsWith(" - Topic") ? "Topic Channel" : undefined
  ].filter((badge): badge is string => Boolean(badge));

  return {
    source,
    sourceLabel: sourceLabelFor(source, input.sourceLabel),
    videoUrl: `https://www.youtube.com/watch?v=${input.videoId}`,
    album: music.album,
    releaseYear: music.releaseYear ?? releaseYearFromDate(input.publishedAt),
    artists: [
      {
        name: artistNameFromChannel(input.channelTitle),
        channelId: input.channelId,
        isOfficial: officialArtist || officialTrack
      }
    ],
    thumbnails: input.thumbnails,
    isOfficialArtist: officialArtist,
    isOfficialTrack: officialTrack,
    music: {
      catalogSource: input.source === "youtube_music" || officialTrack ? "youtube-music" : undefined,
      topicCategories: input.topicCategories,
      releaseType: officialTrack ? "single" : "video"
    },
    badges
  };
}

function mergeCandidate(existing: CandidateMatch, next: CandidateMatch): CandidateMatch {
  return {
    ...existing,
    ...next,
    description: next.description ?? existing.description,
    durationMs: next.durationMs ?? existing.durationMs,
    score: Math.max(existing.score, next.score),
    confidence: confidenceRank(next.confidence) > confidenceRank(existing.confidence) ? next.confidence : existing.confidence,
    metadata: mergeCandidateMetadata(existing.metadata, next.metadata),
    diagnostics: next.diagnostics ?? existing.diagnostics
  };
}

function mergeCandidateMetadata(existing: CandidateMetadata | undefined, next: CandidateMetadata | undefined): CandidateMetadata | undefined {
  if (!existing) return next;
  if (!next) return existing;

  const source = sourcePriority(next.source) >= sourcePriority(existing.source) ? next.source : existing.source;
  return {
    ...existing,
    ...next,
    source,
    sourceLabel: sourceLabelFor(source, next.sourceLabel || existing.sourceLabel),
    album: next.album ?? existing.album,
    releaseYear: next.releaseYear ?? existing.releaseYear,
    artists: mergeArtists(existing.artists, next.artists),
    thumbnails: {
      ...existing.thumbnails,
      ...next.thumbnails
    },
    isOfficialArtist: existing.isOfficialArtist || next.isOfficialArtist,
    isOfficialTrack: existing.isOfficialTrack || next.isOfficialTrack,
    music: {
      ...existing.music,
      ...next.music,
      topicCategories: next.music?.topicCategories ?? existing.music?.topicCategories
    },
    badges: [...new Set([...(existing.badges ?? []), ...(next.badges ?? [])])]
  };
}

function mergeArtists(
  existing: CandidateMetadata["artists"] | undefined,
  next: CandidateMetadata["artists"] | undefined
): CandidateMetadata["artists"] | undefined {
  const artists = new Map<string, NonNullable<CandidateMetadata["artists"]>[number]>();
  for (const artist of [...(existing ?? []), ...(next ?? [])]) {
    artists.set(artist.name.toLowerCase(), {
      ...artists.get(artist.name.toLowerCase()),
      ...artist,
      isOfficial: artists.get(artist.name.toLowerCase())?.isOfficial || artist.isOfficial
    });
  }
  return artists.size > 0 ? [...artists.values()] : undefined;
}

function musicMetadataFromDescription(description: string): { album?: string; releaseYear?: number } {
  const lines = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const released = /Released on:\s*(\d{4})/i.exec(description);
  const copyrightIndex = lines.findIndex((line) => line.startsWith("\u2117") || /^\(P\)/i.test(line));
  const providedIndex = lines.findIndex((line) => /^Provided to YouTube by/i.test(line));
  const album =
    providedIndex >= 0 && copyrightIndex > providedIndex
      ? lines.slice(providedIndex + 1, copyrightIndex).find((line) => !line.includes(" · "))
      : undefined;

  return {
    album,
    releaseYear: released ? Number(released[1]) : undefined
  };
}

function sourceFor(source: CandidateSourceKind, officialTrack: boolean, officialArtist: boolean): CandidateSourceKind {
  if (officialTrack) return "official_track";
  if (officialArtist) return "official_artist";
  return source;
}

function sourceLabelFor(source: CandidateSourceKind, fallback: string): string {
  if (source === "official_track") return "Official Track";
  if (source === "official_artist") return "Official Artist";
  if (source === "youtube_music") return "YouTube Music";
  return fallback || "YouTube Video";
}

function sourcePriority(source: CandidateSourceKind): number {
  if (source === "official_track") return 4;
  if (source === "official_artist") return 3;
  if (source === "youtube_music") return 2;
  return 1;
}

function confidenceRank(confidence: CandidateMatch["confidence"]): number {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  return 1;
}

function isOfficialTrack(title: string, channelTitle: string, description?: string): boolean {
  return (
    channelTitle.endsWith(" - Topic") ||
    /Provided to YouTube by/i.test(description ?? "") ||
    /\bofficial\s+(audio|music video|video|visualizer)\b/i.test(title)
  );
}

function isOfficialArtistChannel(channelTitle: string, description?: string): boolean {
  return /\bvevo\b/i.test(channelTitle) || /\bofficial\b/i.test(channelTitle) || /Auto-generated by YouTube/i.test(description ?? "");
}

function artistNameFromChannel(channelTitle: string): string {
  return channelTitle.replace(/\s+-\s+Topic$/i, "").replace(/\s+VEVO$/i, "").trim();
}

function releaseYearFromDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const year = Number(value.slice(0, 4));
  return Number.isFinite(year) ? year : undefined;
}

function availabilityReason(privacyStatus: string | undefined, uploadStatus: string | undefined): string {
  if (privacyStatus === "private") return "Video is private.";
  if (uploadStatus === "deleted") return "Video was deleted.";
  if (uploadStatus === "rejected") return "Video was rejected by YouTube.";
  if (uploadStatus === "failed") return "Video upload failed.";
  return "Video is unavailable.";
}

export function parseYouTubeDuration(value: string): number | undefined {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return undefined;

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}
