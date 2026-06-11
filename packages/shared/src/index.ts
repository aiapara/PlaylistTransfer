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

export type TransferItemStatus =
  | "matched"
  | "review"
  | "unmatched"
  | "skipped"
  | "failed"
  | "transferred";

export type MatchResult = {
  track: TrackRef;
  selected?: CandidateMatch;
  candidates: CandidateMatch[];
  status: TransferItemStatus;
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
  matchingCompleted: number;
  transferable: number;
  matched: number;
  review: number;
  unmatched: number;
  skipped: number;
  transferred: number;
  /** @deprecated Use transferred. Kept for older UI/API consumers. */
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

export type TransferProgress = {
  phase: "matching" | "transfer";
  completed: number;
  total: number;
  percent: number;
};

export function calculateTransferProgress(
  transfer: Pick<
    TransferSummary,
    "status" | "totalTracks" | "matchingCompleted" | "transferable" | "transferred" | "skipped" | "failed"
  >
): TransferProgress {
  if (transfer.status === "matching") {
    return {
      phase: "matching",
      completed: clampProgressValue(transfer.matchingCompleted, transfer.totalTracks),
      total: transfer.totalTracks,
      percent: percent(transfer.matchingCompleted, transfer.totalTracks)
    };
  }

  const completed = transfer.transferred + transfer.skipped + transfer.failed;
  const total = Math.max(transfer.transferable, completed);

  return {
    phase: "transfer",
    completed: clampProgressValue(completed, total),
    total,
    percent: transfer.status === "completed" && total === 0 ? 100 : percent(completed, total)
  };
}

function percent(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
}

function clampProgressValue(value: number, total: number): number {
  if (total <= 0) return Math.max(0, value);
  return Math.min(Math.max(0, value), total);
}
