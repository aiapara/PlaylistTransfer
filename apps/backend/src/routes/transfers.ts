import { Router } from "express";
import { z } from "zod";
import { listSpotifyPlaylists, getPlaylistTracks } from "../services/spotify.js";
import {
  approveTransferItem,
  beginTransferExecution,
  bulkReviewTransferItems,
  createTransfer,
  getTransfer,
  listTransfers,
  searchTransferItemCandidates,
  skipTransferItem,
  updateReviewState,
  validateTransferSafety
} from "../services/transfers.js";

type TransferRouteDeps = {
  listSpotifyPlaylists: typeof listSpotifyPlaylists;
  getPlaylistTracks: typeof getPlaylistTracks;
  createTransfer: typeof createTransfer;
  getTransfer: typeof getTransfer;
  listTransfers: typeof listTransfers;
  beginTransferExecution: typeof beginTransferExecution;
  approveTransferItem: typeof approveTransferItem;
  skipTransferItem: typeof skipTransferItem;
  searchTransferItemCandidates: typeof searchTransferItemCandidates;
  bulkReviewTransferItems: typeof bulkReviewTransferItems;
  updateReviewState: typeof updateReviewState;
  validateTransferSafety: typeof validateTransferSafety;
};

const createSchema = z.object({
  playlistId: z.string().min(1)
});
const approveSchema = z.object({
  videoId: z.string().min(1)
});
const searchSchema = z.object({
  query: z.string().trim().optional()
});
const bulkReviewSchema = z.object({
  action: z.enum(["approve-best", "approve-threshold", "skip-remaining", "rerun-unmatched"]),
  threshold: z.number().min(0).max(1).optional()
});
const reviewStateSchema = z.object({
  activeFilter: z.enum(["all", "matched", "approved", "review", "unmatched", "skipped"]).optional(),
  activeItemId: z.string().optional(),
  selectedCandidateIds: z.record(z.string()).optional(),
  searchQueries: z.record(z.string()).optional()
});

export function createTransfersRouter(deps: TransferRouteDeps = defaultDeps): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(deps.listTransfers());
  });

  router.get("/:id", (req, res) => {
    const transfer = deps.getTransfer(req.params.id);
    if (!transfer) return res.status(404).json({ error: "Transfer not found." });
    return res.json(transfer);
  });

  router.post("/preview", async (req, res, next) => {
    try {
      const { playlistId } = createSchema.parse(req.body);
      const playlists = await deps.listSpotifyPlaylists();
      const playlist = playlists.find((item) => item.id === playlistId);
      if (!playlist) return res.status(404).json({ error: "Playlist not found." });

      const id = deps.createTransfer(playlist, () => deps.getPlaylistTracks(playlistId));
      return res.status(202).json(deps.getTransfer(id));
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id/validation", async (req, res, next) => {
    try {
      return res.json(await deps.validateTransferSafety(req.params.id, { includeAvailability: true }));
    } catch (error) {
      return next(error);
    }
  });

  router.post("/:id/start", async (req, res, next) => {
    try {
      const job = await deps.beginTransferExecution(req.params.id);
      void job.done.catch(() => undefined);
      return res.json(job.transfer);
    } catch (error) {
      return next(error);
    }
  });

  router.put("/:id/review-state", (req, res, next) => {
    try {
      const state = reviewStateSchema.parse(req.body);
      return res.json(deps.updateReviewState(req.params.id, state));
    } catch (error) {
      return next(error);
    }
  });

  router.post("/:id/items/bulk", async (req, res, next) => {
    try {
      const input = bulkReviewSchema.parse(req.body);
      return res.json(await deps.bulkReviewTransferItems(req.params.id, input));
    } catch (error) {
      return next(error);
    }
  });

  router.post("/:id/items/:itemId/approve", (req, res, next) => {
    try {
      const { videoId } = approveSchema.parse(req.body);
      return res.json(deps.approveTransferItem(req.params.id, req.params.itemId, videoId));
    } catch (error) {
      return next(error);
    }
  });

  router.post("/:id/items/:itemId/skip", (req, res, next) => {
    try {
      return res.json(deps.skipTransferItem(req.params.id, req.params.itemId));
    } catch (error) {
      return next(error);
    }
  });

  router.post("/:id/items/:itemId/search", async (req, res, next) => {
    try {
      const { query } = searchSchema.parse(req.body);
      return res.json(await deps.searchTransferItemCandidates(req.params.id, req.params.itemId, query));
    } catch (error) {
      return next(error);
    }
  });

  router.get("/:id/unmatched.csv", (req, res) => {
    const transfer = deps.getTransfer(req.params.id);
    if (!transfer) return res.status(404).json({ error: "Transfer not found." });

    const csv = unmatchedCsv(transfer.matches);

    res.header("Content-Type", "text/csv");
    res.attachment(`${transfer.playlistTitle}-unmatched.csv`);
    return res.send(csv);
  });

  return router;
}

export function unmatchedCsv(matches: NonNullable<ReturnType<typeof getTransfer>>["matches"]): string {
  const rows = matches
    .filter((match) => match.status === "unmatched" || match.status === "review" || match.status === "failed")
    .map((match) => [
      match.track.title,
      match.track.artists.join("; "),
      match.track.album ?? "",
      match.status,
      match.reason ?? "",
      match.selected?.title ?? "",
      match.selected?.score.toFixed(3) ?? ""
    ]);

  return [["title", "artists", "album", "status", "reason", "best_candidate", "score"], ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");
}

export function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const defaultDeps: TransferRouteDeps = {
  listSpotifyPlaylists,
  getPlaylistTracks,
  createTransfer,
  getTransfer,
  listTransfers,
  beginTransferExecution,
  approveTransferItem,
  skipTransferItem,
  searchTransferItemCandidates,
  bulkReviewTransferItems,
  updateReviewState,
  validateTransferSafety
};

export const transfersRouter = createTransfersRouter();
