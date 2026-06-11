import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";
import type Database from "better-sqlite3";
import type { NextFunction, Request, Response } from "express";
import type { SourcePlaylist, TrackRef, TransferDetail, TransferSummary } from "../packages/shared/src/index.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playlist-transfer-tests-"));
const dbPath = path.join(tempDir, "playlist-transfer.db");
const encryptionKey = Buffer.alloc(32, 7).toString("base64");

Object.assign(process.env, {
  NODE_ENV: "test",
  PORT: "4000",
  DESKTOP_MODE: "true",
  FRONTEND_URL: "http://127.0.0.1:4000",
  SESSION_SECRET: "test-session-secret-with-enough-length",
  TOKEN_ENCRYPTION_KEY: encryptionKey,
  DATABASE_PATH: dbPath,
  SPOTIFY_CLIENT_ID: "spotify-client",
  SPOTIFY_CLIENT_SECRET: "spotify-secret",
  SPOTIFY_REDIRECT_URI: "http://127.0.0.1:4000/api/auth/spotify/callback",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  GOOGLE_REDIRECT_URI: "http://127.0.0.1:4000/api/auth/youtube/callback",
  MATCH_CONFIDENCE_THRESHOLD: "0.72",
  TRANSFER_BATCH_SIZE: "20",
  TRANSFER_BATCH_DELAY_MS: "0",
  MAX_RETRY_ATTEMPTS: "2"
});

let matcher: typeof import("../apps/backend/src/services/matcher.js");
let settings: typeof import("../apps/backend/src/routes/settings.js");
let transferRoutes: typeof import("../apps/backend/src/routes/transfers.js");
let transfers: typeof import("../apps/backend/src/services/transfers.js");
let backendApp: typeof import("../apps/backend/src/app.js");
let db: Database.Database;
let express: typeof import("express").default;

before(async () => {
  matcher = await import("../apps/backend/src/services/matcher.js");
  settings = await import("../apps/backend/src/routes/settings.js");
  transferRoutes = await import("../apps/backend/src/routes/transfers.js");
  transfers = await import("../apps/backend/src/services/transfers.js");
  backendApp = await import("../apps/backend/src/app.js");
  db = (await import("../apps/backend/src/db/index.js")).db;
  express = (await import("express")).default;
});

test("matcher scoring prefers direct official-looking candidates over cover results", () => {
  const track: TrackRef = {
    sourceId: "spotify-track",
    title: "Midnight City",
    artists: ["M83"],
    album: "Hurry Up, We're Dreaming"
  };

  const direct = matcher.scoreCandidate(track, {
    videoId: "direct",
    title: "M83 - Midnight City",
    channelTitle: "M83",
    description: "Hurry Up, We're Dreaming",
    score: 0,
    confidence: "low"
  });
  const cover = matcher.scoreCandidate(track, {
    videoId: "cover",
    title: "Midnight City cover",
    channelTitle: "Piano Covers",
    description: "karaoke instrumental",
    score: 0,
    confidence: "low"
  });

  assert.ok(direct.score > 0.72);
  assert.ok(cover.score < direct.score);
});

test("settings config formatting round-trips quoted values and validates redirects", () => {
  const configPath = path.join(tempDir, "playlist-transfer.env");
  const trickySecret = "line one\nline=two with \"quotes\" and backslash \\";
  const formatted = settings.formatConfig({
    NODE_ENV: "development",
    PORT: "4000",
    DESKTOP_MODE: "true",
    FRONTEND_URL: "http://127.0.0.1:4000",
    SESSION_SECRET: "test-session-secret-with-enough-length",
    TOKEN_ENCRYPTION_KEY: encryptionKey,
    DATABASE_PATH: dbPath,
    SPOTIFY_CLIENT_ID: "spotify-client",
    SPOTIFY_CLIENT_SECRET: trickySecret,
    SPOTIFY_REDIRECT_URI: "http://127.0.0.1:4000/api/auth/spotify/callback",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    GOOGLE_REDIRECT_URI: "http://127.0.0.1:4000/api/auth/youtube/callback"
  });

  fs.writeFileSync(configPath, formatted, "utf8");
  const parsed = settings.readRawConfig(configPath);

  assert.equal(parsed.SPOTIFY_CLIENT_SECRET, trickySecret);
  assert.deepEqual(settings.validateConfig(parsed), []);
});

test("runtime origin updates OAuth redirect requirements to the selected desktop port", () => {
  try {
    backendApp.setDesktopRuntimeOrigin("http://127.0.0.1:49152");

    assert.equal(process.env.PORT, "49152");
    assert.deepEqual(settings.requiredRedirectUris(), {
      spotify: "http://127.0.0.1:49152/api/auth/spotify/callback",
      youtube: "http://127.0.0.1:49152/api/auth/youtube/callback"
    });
  } finally {
    backendApp.setDesktopRuntimeOrigin("http://127.0.0.1:4000");
  }
});

test("CSV output escapes quotes and includes failed/review/unmatched states", () => {
  const csv = transferRoutes.unmatchedCsv([
    {
      track: {
        sourceId: "1",
        title: 'A "quoted" song',
        artists: ["Artist"],
        album: "Album"
      },
      selected: undefined,
      candidates: [],
      status: "failed",
      reason: "Could not add"
    }
  ]);

  assert.match(csv, /"status"/);
  assert.match(csv, /"failed"/);
  assert.match(csv, /"A ""quoted"" song"/);
});

test("stale matching and running transfers are normalized safely", () => {
  insertTransfer("tr_stale_running", "running");
  insertTransfer("tr_stale_matching", "matching");

  transfers.normalizeStaleTransfers();

  assert.equal(statusFor("tr_stale_running"), "paused");
  assert.equal(statusFor("tr_stale_matching"), "failed");
});

test("web mode app creation does not normalize desktop stale transfers", () => {
  insertTransfer("tr_web_running", "running");

  backendApp.createApp({ desktopMode: false });

  assert.equal(statusFor("tr_web_running"), "running");
});

test("per-transfer execution lock rejects duplicate start while a run is active", async () => {
  insertTransfer("tr_lock", "ready");
  insertMatchedItem("tr_lock", "ti_lock");

  const job = transfers.beginTransferExecution("tr_lock");
  assert.equal(job.transfer.status, "running");
  assert.throws(() => transfers.beginTransferExecution("tr_lock"), /already running/);
  await job.done.catch(() => undefined);
});

test("transfer routes create quickly and surface start conflicts", async () => {
  const playlist: SourcePlaylist = {
    id: "playlist-1",
    source: "spotify",
    title: "Playlist",
    description: "",
    totalTracks: 2,
    isLikedSongs: false
  };
  let tracksLoaded = false;
  const detail = transferDetail({
    id: "tr_api",
    status: "matching",
    totalTracks: 2,
    matchingCompleted: 0
  });

  const app = express();
  app.use(express.json());
  app.use(
    "/api/transfers",
    transferRoutes.createTransfersRouter({
      listSpotifyPlaylists: async () => [playlist],
      getPlaylistTracks: async () => {
        tracksLoaded = true;
        return [];
      },
      createTransfer: () => "tr_api",
      getTransfer: (id) => (id === "tr_api" ? detail : undefined),
      listTransfers: () => [detail],
      beginTransferExecution: () => {
        const error = new Error("Transfer is already running.") as Error & { status: number };
        error.status = 409;
        throw error;
      }
    })
  );
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Unexpected error." });
  });

  const server = await listen(app);
  try {
    const preview = await request(server, "/api/transfers/preview", {
      method: "POST",
      body: JSON.stringify({ playlistId: "playlist-1" }),
      headers: { "Content-Type": "application/json" }
    });

    assert.equal(preview.status, 202);
    assert.equal((await preview.json()).status, "matching");
    assert.equal(tracksLoaded, false);

    const start = await request(server, "/api/transfers/tr_api/start", { method: "POST" });
    assert.equal(start.status, 409);
  } finally {
    await close(server);
  }
});

function insertTransfer(id: string, status: TransferSummary["status"]): void {
  db.prepare(
    `INSERT OR REPLACE INTO transfers (
      id, source_playlist_id, source_kind, playlist_title, playlist_description, status, total_tracks
    ) VALUES (?, ?, 'playlist', 'Playlist', '', ?, 1)`
  ).run(id, id, status);
}

function insertMatchedItem(transferId: string, id: string): void {
  db.prepare(
    `INSERT INTO transfer_items (
      id, transfer_id, source_track_id, track_title, artists_json, selected_video_id,
      selected_title, selected_channel, score, status, candidates_json
    ) VALUES (?, ?, 'source-track', 'Song', '["Artist"]', 'video-1', 'Song', 'Artist', 1, 'matched', '[]')`
  ).run(id, transferId);
}

function statusFor(id: string): string {
  return (db.prepare("SELECT status FROM transfers WHERE id = ?").get(id) as { status: string }).status;
}

function transferDetail(overrides: Partial<TransferDetail>): TransferDetail {
  return {
    id: "tr_test",
    playlistTitle: "Playlist",
    status: "ready",
    destinationPlaylistId: undefined,
    totalTracks: 0,
    matchingCompleted: 0,
    transferable: 0,
    matched: 0,
    review: 0,
    unmatched: 0,
    skipped: 0,
    transferred: 0,
    added: 0,
    failed: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    playlistDescription: "",
    matches: [],
    logs: [],
    ...overrides
  };
}

function listen(app: ReturnType<typeof express>): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function request(server: Server, pathname: string, init?: RequestInit): Promise<Response> {
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return fetch(`http://127.0.0.1:${address.port}${pathname}`, init);
}
