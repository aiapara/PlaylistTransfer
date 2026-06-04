import type { CandidateMatch, MatchResult, TrackRef, TransferDetail, TransferLog, TransferSummary } from "@playlist-transfer/shared";
import { db } from "../db/index.js";
import { env } from "../env.js";
import { randomId } from "../lib/crypto.js";
import { sleep } from "../lib/http.js";
import { matchTrack } from "./matcher.js";
import { addVideoToPlaylist, findOrCreatePlaylist, listPlaylistVideoIds } from "./youtube.js";

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
  status: MatchResult["status"] | "added" | "failed";
  reason?: string;
  attempts: number;
  candidates_json: string;
};

export async function createTransfer(
  playlist: { id: string; title: string; description: string; isLikedSongs: boolean },
  tracks: TrackRef[]
): Promise<string> {
  const id = randomId("tr");

  db.prepare(
    `INSERT INTO transfers (
      id, source_playlist_id, source_kind, playlist_title, playlist_description, status, total_tracks
    ) VALUES (?, ?, ?, ?, ?, 'matching', ?)`
  ).run(id, playlist.id, playlist.isLikedSongs ? "liked-songs" : "playlist", playlist.title, playlist.description, tracks.length);

  logTransfer(id, "info", `Created transfer draft for ${tracks.length} tracks.`);

  for (let i = 0; i < tracks.length; i += 1) {
    const result = await matchTrack(tracks[i]);
    saveMatch(id, result);
    logTransfer(id, result.status === "matched" ? "info" : "warn", `${result.status}: ${tracks[i].title}`);
  }

  updateTransferStatus(id, "ready");
  return id;
}

export async function runTransfer(id: string): Promise<void> {
  try {
    const transfer = getTransferRow(id);
    if (!transfer) throw new Error("Transfer not found.");
    if (!["ready", "running", "failed", "paused"].includes(transfer.status)) {
      throw new Error(`Transfer cannot start from status ${transfer.status}.`);
    }

    updateTransferStatus(id, "running");
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
           AND status IN ('matched', 'failed')
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
          markItem(item.id, "added");
          logTransfer(id, "info", `Added: ${item.track_title}`);
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
    logTransfer(id, failed > 0 ? "error" : "info", failed > 0 ? `Transfer finished with ${failed} failures.` : "Transfer completed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected transfer failure.";
    updateTransferStatus(id, "failed");
    logTransfer(id, "error", message);
    throw error;
  }
}

export function listTransfers(): TransferSummary[] {
  const rows = db.prepare("SELECT * FROM transfers ORDER BY created_at DESC").all() as TransferRow[];
  return rows.map(toSummary);
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
    ...toSummary(row),
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

function saveMatch(transferId: string, result: MatchResult): void {
  db.prepare(
    `INSERT INTO transfer_items (
      id, transfer_id, source_track_id, track_title, artists_json, album, duration_ms,
      selected_video_id, selected_title, selected_channel, score, status, reason, candidates_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

function markItem(id: string, status: TransferItemRow["status"], reason?: string): void {
  db.prepare("UPDATE transfer_items SET status = ?, reason = COALESCE(?, reason), added_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    status,
    reason ?? null,
    id
  );
}

function incrementAttempts(id: string): void {
  db.prepare("UPDATE transfer_items SET attempts = attempts + 1 WHERE id = ?").run(id);
}

function countItems(transferId: string, status: string): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM transfer_items WHERE transfer_id = ? AND status = ?").get(transferId, status) as { count: number })
    .count;
}

function logTransfer(transferId: string, level: TransferLog["level"], message: string): void {
  db.prepare("INSERT INTO transfer_logs (id, transfer_id, level, message) VALUES (?, ?, ?, ?)").run(
    randomId("log"),
    transferId,
    level,
    message
  );
}

function toSummary(row: TransferRow): TransferSummary {
  return {
    id: row.id,
    playlistTitle: row.playlist_title,
    status: row.status,
    destinationPlaylistId: row.destination_playlist_id,
    totalTracks: row.total_tracks,
    matched: countItems(row.id, "matched") + countItems(row.id, "added"),
    review: countItems(row.id, "review"),
    unmatched: countItems(row.id, "unmatched"),
    skipped: countItems(row.id, "skipped"),
    added: countItems(row.id, "added"),
    failed: countItems(row.id, "failed"),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMatchResult(row: TransferItemRow): MatchResult {
  const candidates = JSON.parse(row.candidates_json) as CandidateMatch[];
  return {
    track: {
      sourceId: row.source_track_id,
      title: row.track_title,
      artists: JSON.parse(row.artists_json) as string[],
      album: row.album,
      durationMs: row.duration_ms
    },
    selected: row.selected_video_id
      ? {
          videoId: row.selected_video_id,
          title: row.selected_title ?? "",
          channelTitle: row.selected_channel ?? "",
          score: row.score,
          confidence: row.score >= env.MATCH_CONFIDENCE_THRESHOLD ? "high" : row.score >= 0.52 ? "medium" : "low"
        }
      : undefined,
    candidates,
    status: row.status === "added" ? "matched" : row.status === "failed" ? "matched" : row.status,
    reason: row.reason
  };
}
