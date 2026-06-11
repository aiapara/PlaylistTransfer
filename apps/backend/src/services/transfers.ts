import type {
  CandidateMatch,
  MatchResult,
  MatchSelectionSource,
  TrackRef,
  TransferDetail,
  TransferItemStatus,
  TransferLog,
  TransferSummary
} from "@playlist-transfer/shared";
import { db } from "../db/index.js";
import { env } from "../env.js";
import { randomId } from "../lib/crypto.js";
import { sleep } from "../lib/http.js";
import { matchTrack, scoreCandidate } from "./matcher.js";
import { addVideoToPlaylist, findOrCreatePlaylist, listPlaylistVideoIds, searchYoutube } from "./youtube.js";

type TransferRow = {
  id: string;
  source_playlist_id: string;
  source_kind: string;
  playlist_title: string;
  playlist_description: string;
  destination_playlist_id?: string;
  status: TransferSummary["status"];
  total_tracks: number;
  created_at: string;
  updated_at: string;
};

type TransferItemRow = {
  id: string;
  transfer_id: string;
  source_track_id: string;
  track_title: string;
  artists_json: string;
  album?: string;
  duration_ms?: number;
  selected_video_id?: string;
  selected_title?: string;
  selected_channel?: string;
  score: number;
  status: TransferItemStatus | "added";
  selection_source: MatchSelectionSource;
  reason?: string;
  attempts: number;
  added_at?: string;
  reviewed_at?: string;
  candidates_json: string;
};

type TransferCounts = Record<TransferItemStatus, number>;

export type TransferPlaylistInput = {
  id: string;
  title: string;
  description: string;
  isLikedSongs: boolean;
  totalTracks?: number;
};

export type StartedTransferJob = {
  transfer: TransferDetail;
  done: Promise<void>;
};

const runningTransfers = new Set<string>();
const matchingTransfers = new Set<string>();
const itemStatuses: TransferItemStatus[] = ["matched", "approved", "review", "unmatched", "skipped", "failed", "transferred"];

export function createTransfer(playlist: TransferPlaylistInput, loadTracks: () => Promise<TrackRef[]>): string {
  const id = randomId("tr");

  db.prepare(
    `INSERT INTO transfers (
      id, source_playlist_id, source_kind, playlist_title, playlist_description, status, total_tracks
    ) VALUES (?, ?, ?, ?, ?, 'matching', ?)`
  ).run(
    id,
    playlist.id,
    playlist.isLikedSongs ? "liked-songs" : "playlist",
    playlist.title,
    playlist.description,
    playlist.totalTracks ?? 0
  );

  logTransfer(id, "info", `Created transfer and queued matching for ${playlist.totalTracks ?? 0} tracks.`);
  void beginMatching(id, loadTracks).catch(() => undefined);
  return id;
}

export function beginMatching(id: string, loadTracks: () => Promise<TrackRef[]>): Promise<void> {
  if (matchingTransfers.has(id)) {
    return Promise.reject(httpError(409, "Transfer is already matching."));
  }

  matchingTransfers.add(id);
  return matchTransfer(id, loadTracks).finally(() => {
    matchingTransfers.delete(id);
  });
}

export function beginTransferExecution(id: string): StartedTransferJob {
  if (runningTransfers.has(id)) {
    throw httpError(409, "Transfer is already running.");
  }

  const transfer = getTransferRow(id);
  if (!transfer) throw httpError(404, "Transfer not found.");
  if (!["ready", "failed", "paused"].includes(transfer.status)) {
    throw httpError(409, `Transfer cannot start from status ${transfer.status}.`);
  }
  assertNoUnresolvedItems(id);

  runningTransfers.add(id);
  updateTransferStatus(id, "running");

  const done = executeTransfer(id).finally(() => {
    runningTransfers.delete(id);
  });

  return {
    transfer: getTransfer(id)!,
    done
  };
}

export async function runTransfer(id: string): Promise<void> {
  await beginTransferExecution(id).done;
}

export function approveTransferItem(transferId: string, itemId: string, videoId: string): TransferDetail {
  assertTransferEditable(transferId);
  const row = getTransferItemRow(transferId, itemId);
  if (!row) throw httpError(404, "Transfer item not found.");

  const candidate = candidatesForRow(row).find((item) => item.videoId === videoId);
  if (!candidate) throw httpError(400, "Candidate is not available for this track. Search again before approving it.");

  db.prepare(
    `UPDATE transfer_items
     SET selected_video_id = ?,
         selected_title = ?,
         selected_channel = ?,
         score = ?,
         status = 'approved',
         selection_source = 'manual',
         reason = NULL,
         attempts = 0,
         reviewed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND transfer_id = ?`
  ).run(candidate.videoId, candidate.title, candidate.channelTitle, candidate.score, itemId, transferId);

  logTransfer(transferId, "info", `Approved match: ${row.track_title} -> ${candidate.title}`);
  return getTransferOrThrow(transferId);
}

export function skipTransferItem(transferId: string, itemId: string): TransferDetail {
  assertTransferEditable(transferId);
  const row = getTransferItemRow(transferId, itemId);
  if (!row) throw httpError(404, "Transfer item not found.");

  markItem(itemId, "skipped", "Skipped by user.", true);
  logTransfer(transferId, "info", `Skipped by user: ${row.track_title}`);
  return getTransferOrThrow(transferId);
}

export async function searchTransferItemCandidates(transferId: string, itemId: string, query?: string): Promise<TransferDetail> {
  assertTransferEditable(transferId);
  const row = getTransferItemRow(transferId, itemId);
  if (!row) throw httpError(404, "Transfer item not found.");

  const track = trackFromRow(row);
  const searchQuery = query?.trim() || [track.title, track.artists[0], track.album].filter(Boolean).join(" ");
  const candidates = (await searchYoutube(searchQuery))
    .map((candidate) => scoreCandidate(track, candidate))
    .sort((a, b) => b.score - a.score);
  const selected = candidates[0];
  const status: TransferItemStatus = candidates.length > 0 ? "review" : "unmatched";
  const reason =
    candidates.length > 0
      ? `Search returned ${candidates.length} candidates. Select one to approve it.`
      : "Search returned no YouTube candidates.";

  db.prepare(
    `UPDATE transfer_items
     SET selected_video_id = ?,
         selected_title = ?,
         selected_channel = ?,
         score = ?,
         status = ?,
         selection_source = 'none',
         reason = ?,
         attempts = 0,
         reviewed_at = NULL,
         candidates_json = ?
     WHERE id = ? AND transfer_id = ?`
  ).run(
    selected?.videoId ?? null,
    selected?.title ?? null,
    selected?.channelTitle ?? null,
    selected?.score ?? 0,
    status,
    reason,
    JSON.stringify(candidates),
    itemId,
    transferId
  );

  logTransfer(transferId, candidates.length > 0 ? "info" : "warn", `Searched again for ${row.track_title}.`);
  return getTransferOrThrow(transferId);
}

export function normalizeStaleTransfers(): void {
  const staleRows = db
    .prepare("SELECT id, status FROM transfers WHERE status IN ('matching', 'running')")
    .all() as Pick<TransferRow, "id" | "status">[];

  for (const row of staleRows) {
    if (row.status === "running") {
      updateTransferStatus(row.id, "paused");
      logTransfer(row.id, "warn", "Previous app session stopped during transfer; marked paused and safe to resume.");
      continue;
    }

    updateTransferStatus(row.id, "failed");
    logTransfer(row.id, "error", "Previous app session stopped during matching; create a new preview to retry matching.");
  }
}

export function listTransfers(): TransferSummary[] {
  const rows = db.prepare("SELECT * FROM transfers ORDER BY created_at DESC").all() as TransferRow[];
  const countsByTransfer = itemCountsForTransfers(rows.map((row) => row.id));
  return rows.map((row) => toSummary(row, countsByTransfer.get(row.id) ?? emptyCounts()));
}

export function getTransfer(id: string): TransferDetail | undefined {
  const row = getTransferRow(id);
  if (!row) return undefined;

  const itemRows = db.prepare("SELECT * FROM transfer_items WHERE transfer_id = ? ORDER BY rowid").all(id) as TransferItemRow[];
  const logs = db.prepare("SELECT * FROM transfer_logs WHERE transfer_id = ? ORDER BY created_at ASC").all(id) as {
    id: string;
    transfer_id: string;
    level: TransferLog["level"];
    message: string;
    created_at: string;
  }[];

  return {
    ...toSummary(row, countsFromRows(itemRows)),
    playlistDescription: row.playlist_description,
    matches: itemRows.map(toMatchResult),
    logs: logs.map((log) => ({
      id: log.id,
      transferId: log.transfer_id,
      level: log.level,
      message: log.message,
      createdAt: log.created_at
    }))
  };
}

async function matchTransfer(id: string, loadTracks: () => Promise<TrackRef[]>): Promise<void> {
  try {
    const transfer = getTransferRow(id);
    if (!transfer) throw httpError(404, "Transfer not found.");
    if (transfer.status !== "matching") {
      throw httpError(409, `Transfer cannot match from status ${transfer.status}.`);
    }

    const tracks = await loadTracks();
    db.prepare("UPDATE transfers SET total_tracks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(tracks.length, id);

    for (const track of tracks) {
      const result = await matchTrack(track);
      saveMatch(id, result);
      logTransfer(id, result.status === "matched" ? "info" : "warn", `${result.status}: ${track.title}`);
    }

    updateTransferStatus(id, "ready");
    logTransfer(id, "info", `Matching completed for ${tracks.length} tracks.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected matching failure.";
    updateTransferStatus(id, "failed");
    logTransfer(id, "error", message);
    throw error;
  }
}

async function executeTransfer(id: string): Promise<void> {
  try {
    const transfer = getTransferRow(id);
    if (!transfer) throw httpError(404, "Transfer not found.");

    const destinationPlaylistId =
      transfer.destination_playlist_id ?? (await findOrCreatePlaylist(transfer.playlist_title, transfer.playlist_description));

    db.prepare("UPDATE transfers SET destination_playlist_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      destinationPlaylistId,
      id
    );

    const existingVideos = await listPlaylistVideoIds(destinationPlaylistId);
    const items = db
      .prepare(
        `SELECT * FROM transfer_items
         WHERE transfer_id = ?
           AND status IN ('matched', 'approved', 'failed')
           AND selected_video_id IS NOT NULL
           AND attempts < ?
         ORDER BY rowid`
      )
      .all(id, env.MAX_RETRY_ATTEMPTS) as TransferItemRow[];

    logTransfer(id, "info", `Starting transfer to destination playlist ${destinationPlaylistId}.`);

    for (let i = 0; i < items.length; i += env.TRANSFER_BATCH_SIZE) {
      const batch = items.slice(i, i + env.TRANSFER_BATCH_SIZE);

      for (const item of batch) {
        const videoId = item.selected_video_id;
        if (!videoId) continue;

        if (existingVideos.has(videoId)) {
          markItem(item.id, "skipped", "Video already exists in destination playlist.");
          logTransfer(id, "info", `Skipped duplicate: ${item.track_title}`);
          continue;
        }

        try {
          incrementAttempts(item.id);
          await retry(() => addVideoToPlaylist(destinationPlaylistId, videoId));
          existingVideos.add(videoId);
          markItem(item.id, "transferred");
          logTransfer(id, "info", `Transferred: ${item.track_title}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown transfer failure.";
          markItem(item.id, "failed", message);
          logTransfer(id, "error", `Failed: ${item.track_title} - ${message}`);
        }
      }

      await sleep(env.TRANSFER_BATCH_DELAY_MS);
    }

    const failed = countItems(id, "failed");
    updateTransferStatus(id, failed > 0 ? "failed" : "completed");
    logTransfer(
      id,
      failed > 0 ? "error" : "info",
      failed > 0 ? `Transfer finished with ${failed} failures.` : "Transfer completed."
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected transfer failure.";
    updateTransferStatus(id, "failed");
    logTransfer(id, "error", message);
    throw error;
  }
}

function saveMatch(transferId: string, result: MatchResult): void {
  db.prepare(
    `INSERT INTO transfer_items (
      id, transfer_id, source_track_id, track_title, artists_json, album, duration_ms,
      selected_video_id, selected_title, selected_channel, score, status, selection_source, reason, candidates_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomId("ti"),
    transferId,
    result.track.sourceId,
    result.track.title,
    JSON.stringify(result.track.artists),
    result.track.album ?? null,
    result.track.durationMs ?? null,
    result.selected?.videoId ?? null,
    result.selected?.title ?? null,
    result.selected?.channelTitle ?? null,
    result.selected?.score ?? 0,
    result.status,
    result.selectionSource,
    result.reason ?? null,
    JSON.stringify(result.candidates)
  );
}

function retry<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch(async (error) => {
    let lastError = error;
    for (let attempt = 1; attempt < env.MAX_RETRY_ATTEMPTS; attempt += 1) {
      await sleep(500 * 2 ** attempt);
      try {
        return await operation();
      } catch (nextError) {
        lastError = nextError;
      }
    }
    throw lastError;
  });
}

function getTransferRow(id: string): TransferRow | undefined {
  return db.prepare("SELECT * FROM transfers WHERE id = ?").get(id) as TransferRow | undefined;
}

function updateTransferStatus(id: string, status: TransferSummary["status"]): void {
  db.prepare("UPDATE transfers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, id);
}

function markItem(id: string, status: TransferItemStatus, reason?: string, reviewed = false): void {
  db.prepare(
    `UPDATE transfer_items
     SET status = ?,
         reason = COALESCE(?, reason),
         added_at = CASE WHEN ? IN ('transferred', 'skipped') THEN CURRENT_TIMESTAMP ELSE added_at END,
         reviewed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE reviewed_at END,
         selection_source = CASE WHEN ? = 'skipped' THEN 'none' ELSE selection_source END
     WHERE id = ?`
  ).run(
    status,
    reason ?? null,
    status,
    reviewed ? 1 : 0,
    status,
    id
  );
}

function incrementAttempts(id: string): void {
  db.prepare("UPDATE transfer_items SET attempts = attempts + 1 WHERE id = ?").run(id);
}

function countItems(transferId: string, status: TransferItemStatus): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM transfer_items WHERE transfer_id = ? AND status = ?").get(transferId, status) as { count: number })
    .count;
}

function assertNoUnresolvedItems(transferId: string): void {
  const unresolved = countItems(transferId, "review") + countItems(transferId, "unmatched");
  if (unresolved > 0) {
    throw httpError(409, `${unresolved} tracks still need review. Approve or skip them before starting transfer.`);
  }
}

function assertTransferEditable(transferId: string): void {
  if (runningTransfers.has(transferId) || matchingTransfers.has(transferId)) {
    throw httpError(409, "Transfer is busy. Wait for matching or transfer execution to finish before editing review decisions.");
  }

  const transfer = getTransferRow(transferId);
  if (!transfer) throw httpError(404, "Transfer not found.");
  if (transfer.status === "running" || transfer.status === "matching") {
    throw httpError(409, `Transfer cannot be edited while ${transfer.status}.`);
  }
}

function getTransferItemRow(transferId: string, itemId: string): TransferItemRow | undefined {
  return db.prepare("SELECT * FROM transfer_items WHERE transfer_id = ? AND id = ?").get(transferId, itemId) as TransferItemRow | undefined;
}

function getTransferOrThrow(id: string): TransferDetail {
  const transfer = getTransfer(id);
  if (!transfer) throw httpError(404, "Transfer not found.");
  return transfer;
}

function itemCountsForTransfers(ids: string[]): Map<string, TransferCounts> {
  const counts = new Map<string, TransferCounts>();
  if (ids.length === 0) return counts;

  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT transfer_id, status, COUNT(*) AS count
       FROM transfer_items
       WHERE transfer_id IN (${placeholders})
       GROUP BY transfer_id, status`
    )
    .all(...ids) as { transfer_id: string; status: TransferItemRow["status"]; count: number }[];

  for (const row of rows) {
    const current = counts.get(row.transfer_id) ?? emptyCounts();
    current[normalizeItemStatus(row.status)] += row.count;
    counts.set(row.transfer_id, current);
  }

  return counts;
}

function countsFromRows(rows: TransferItemRow[]): TransferCounts {
  const counts = emptyCounts();
  for (const row of rows) {
    counts[normalizeItemStatus(row.status)] += 1;
  }
  return counts;
}

function emptyCounts(): TransferCounts {
  return Object.fromEntries(itemStatuses.map((status) => [status, 0])) as TransferCounts;
}

function logTransfer(transferId: string, level: TransferLog["level"], message: string): void {
  db.prepare("INSERT INTO transfer_logs (id, transfer_id, level, message) VALUES (?, ?, ?, ?)").run(
    randomId("log"),
    transferId,
    level,
    message
  );
}

function toSummary(row: TransferRow, counts: TransferCounts): TransferSummary {
  const matchingCompleted = itemStatuses.reduce((total, status) => total + counts[status], 0);
  const transferred = counts.transferred;
  const transferable = counts.matched + counts.approved + counts.failed + counts.skipped + counts.transferred;
  const unresolved = counts.review + counts.unmatched;

  return {
    id: row.id,
    playlistTitle: row.playlist_title,
    status: row.status,
    destinationPlaylistId: row.destination_playlist_id,
    totalTracks: row.total_tracks,
    matchingCompleted,
    transferable,
    matched: counts.matched,
    approved: counts.approved,
    review: counts.review,
    unmatched: counts.unmatched,
    unresolved,
    skipped: counts.skipped,
    transferred,
    added: transferred,
    failed: counts.failed,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMatchResult(row: TransferItemRow): MatchResult {
  const candidates = JSON.parse(row.candidates_json) as CandidateMatch[];
  const selected = selectedCandidateFromRow(row, candidates);
  return {
    id: row.id,
    track: {
      sourceId: row.source_track_id,
      title: row.track_title,
      artists: JSON.parse(row.artists_json) as string[],
      album: row.album,
      durationMs: row.duration_ms
    },
    selected,
    candidates,
    status: normalizeItemStatus(row.status),
    selectionSource: row.selection_source,
    reason: row.reason,
    reviewedAt: row.reviewed_at
  };
}

function candidatesForRow(row: TransferItemRow): CandidateMatch[] {
  return JSON.parse(row.candidates_json) as CandidateMatch[];
}

function selectedCandidateFromRow(row: TransferItemRow, candidates: CandidateMatch[]): CandidateMatch | undefined {
  if (!row.selected_video_id) return undefined;

  const existing = candidates.find((candidate) => candidate.videoId === row.selected_video_id);
  return {
    ...existing,
    videoId: row.selected_video_id,
    title: row.selected_title ?? existing?.title ?? "",
    channelTitle: row.selected_channel ?? existing?.channelTitle ?? "",
    description: existing?.description,
    durationMs: existing?.durationMs,
    score: row.score,
    confidence: row.score >= env.MATCH_CONFIDENCE_THRESHOLD ? "high" : row.score >= 0.52 ? "medium" : "low"
  };
}

function trackFromRow(row: TransferItemRow): TrackRef {
  return {
    sourceId: row.source_track_id,
    title: row.track_title,
    artists: JSON.parse(row.artists_json) as string[],
    album: row.album,
    durationMs: row.duration_ms
  };
}

function normalizeItemStatus(status: TransferItemRow["status"]): TransferItemStatus {
  return status === "added" ? "transferred" : status;
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
