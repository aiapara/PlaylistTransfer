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

export type CandidateSourceKind = "youtube_video" | "youtube_music" | "official_artist" | "official_track";

export type CandidateThumbnail = {
  url: string;
  width?: number;
  height?: number;
};

export type CandidateArtistMetadata = {
  name: string;
  channelId?: string;
  isOfficial?: boolean;
};

export type CandidateMetadata = {
  source: CandidateSourceKind;
  sourceLabel: string;
  videoUrl?: string;
  album?: string;
  releaseYear?: number;
  artists?: CandidateArtistMetadata[];
  thumbnails?: {
    default?: CandidateThumbnail;
    medium?: CandidateThumbnail;
    high?: CandidateThumbnail;
  };
  isOfficialArtist?: boolean;
  isOfficialTrack?: boolean;
  music?: {
    catalogSource?: string;
    topicCategories?: string[];
    releaseType?: "single" | "album" | "video" | "unknown";
  };
  badges?: string[];
};

export type CandidateDiagnostics = {
  titleSimilarity: number;
  artistSimilarity: number;
  durationSimilarity?: number;
  albumSimilarity?: number;
  overallScore: number;
  confidence: "high" | "medium" | "low";
  durationDifferenceMs?: number;
  penalties: string[];
  bonuses: string[];
  reasons: string[];
};

export type CandidateMatch = {
  videoId: string;
  title: string;
  channelTitle: string;
  description?: string;
  durationMs?: number;
  score: number;
  confidence: "high" | "medium" | "low";
  metadata?: CandidateMetadata;
  diagnostics?: CandidateDiagnostics;
};

export type TransferItemStatus =
  | "matched"
  | "approved"
  | "review"
  | "unmatched"
  | "skipped"
  | "failed"
  | "transferred";

export type MatchSelectionSource = "automatic" | "manual" | "none";

export type MatchExplanation = {
  summary: string;
  reasons: string[];
  candidateCount: number;
  bestScore?: number;
};

export type MatchResult = {
  id?: string;
  track: TrackRef;
  selected?: CandidateMatch;
  candidates: CandidateMatch[];
  status: TransferItemStatus;
  selectionSource: MatchSelectionSource;
  reason?: string;
  explanation?: MatchExplanation;
  reviewedAt?: string;
};

export type TransferStatus =
  | "draft"
  | "matching"
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export type ReviewFilter = "all" | "matched" | "approved" | "review" | "unmatched" | "skipped";

export type ReviewSessionState = {
  activeFilter?: ReviewFilter;
  activeItemId?: string;
  selectedCandidateIds?: Record<string, string>;
  searchQueries?: Record<string, string>;
  updatedAt?: string;
};

export type BulkReviewAction = "approve-best" | "approve-threshold" | "skip-remaining" | "rerun-unmatched";

export type TransferValidationIssue = {
  code:
    | "unresolved_items"
    | "missing_candidate"
    | "duplicate_video"
    | "unavailable_video"
    | "availability_check_failed";
  message: string;
  itemId?: string;
  trackTitle?: string;
  videoId?: string;
  count?: number;
};

export type TransferValidationResult = {
  ok: boolean;
  errors: TransferValidationIssue[];
  warnings: TransferValidationIssue[];
  checkedAt: string;
};

export type TransferSummary = {
  id: string;
  playlistTitle: string;
  status: TransferStatus;
  destinationPlaylistId?: string;
  totalTracks: number;
  matchingCompleted: number;
  transferable: number;
  matched: number;
  approved: number;
  review: number;
  unmatched: number;
  unresolved: number;
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
  reviewState: ReviewSessionState;
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
