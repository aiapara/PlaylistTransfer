import { Router } from "express";
import { z } from "zod";
import { listSpotifyPlaylists, getPlaylistTracks } from "../services/spotify.js";
import { createTransfer, getTransfer, listTransfers, runTransfer } from "../services/transfers.js";

export const transfersRouter = Router();

const createSchema = z.object({
  playlistId: z.string().min(1)
});

transfersRouter.get("/", (_req, res) => {
  res.json(listTransfers());
});

transfersRouter.get("/:id", (req, res) => {
  const transfer = getTransfer(req.params.id);
  if (!transfer) return res.status(404).json({ error: "Transfer not found." });
  return res.json(transfer);
});

transfersRouter.post("/preview", async (req, res, next) => {
  try {
    const { playlistId } = createSchema.parse(req.body);
    const playlists = await listSpotifyPlaylists();
    const playlist = playlists.find((item) => item.id === playlistId);
    if (!playlist) return res.status(404).json({ error: "Playlist not found." });

    const tracks = await getPlaylistTracks(playlistId);
    const id = await createTransfer(playlist, tracks);
    return res.status(201).json(getTransfer(id));
  } catch (error) {
    next(error);
  }
});

transfersRouter.post("/:id/start", async (req, res, next) => {
  try {
    const current = getTransfer(req.params.id);
    if (!current) return res.status(404).json({ error: "Transfer not found." });

    void runTransfer(req.params.id).catch(() => undefined);
    res.json(getTransfer(req.params.id));
  } catch (error) {
    next(error);
  }
});

transfersRouter.get("/:id/unmatched.csv", (req, res) => {
  const transfer = getTransfer(req.params.id);
  if (!transfer) return res.status(404).json({ error: "Transfer not found." });

  const rows = transfer.matches
    .filter((match) => match.status === "unmatched" || match.status === "review")
    .map((match) => [
      match.track.title,
      match.track.artists.join("; "),
      match.track.album ?? "",
      match.reason ?? "",
      match.selected?.title ?? "",
      match.selected?.score.toFixed(3) ?? ""
    ]);

  const csv = [["title", "artists", "album", "reason", "best_candidate", "score"], ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");

  res.header("Content-Type", "text/csv");
  res.attachment(`${transfer.playlistTitle}-unmatched.csv`);
  res.send(csv);
});

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
