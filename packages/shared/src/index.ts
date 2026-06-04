export type AuthProvider = "spotify" | "youtube";

export type AuthStatus = {
  spotify: boolean;
  youtube: boolean;
};

export type SourcePlaylist = {
  id: string;
  source: "spotify";
  title: string;
  description: string;
  totalTracks: number;
  imageUrl?: string;
  owner?: string;
  isLikedSongs: boolean;
};

export type TrackRef = {
  sourceId: string;
  title: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  isrc?: string;
};

export type CandidateMatch = {
  videoId: string;
  title: string;
  channelTitle: string;
  description?: string;
  score: number;
  confidence: "high" | "medium" | "low";
};

export type MatchResult = {
  track: TrackRef;
  selected?: CandidateMatch;
  candidates: CandidateMatch[];
  status: "matched" | "review" | "unmatched" | "skipped";
  reason?: string;
};

export type TransferStatus =
  | "draft"
  | "matching"
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export type TransferSummary = {
  id: string;
  playlistTitle: string;
  status: TransferStatus;
  destinationPlaylistId?: string;
  totalTracks: number;
  matched: number;
  review: number;
  unmatched: number;
  skipped: number;
  added: number;
  failed: number;
  createdAt: string;
  updatedAt: string;
};

export type TransferDetail = TransferSummary & {
  playlistDescription: string;
  matches: MatchResult[];
  logs: TransferLog[];
};

export type TransferLog = {
  id: string;
  transferId: string;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
};
