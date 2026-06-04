import { Router } from "express";
import { z } from "zod";
import { listSpotifyPlaylists, materializeLikedSongs } from "../services/spotify.js";

export const playlistsRouter = Router();

playlistsRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await listSpotifyPlaylists());
  } catch (error) {
    next(error);
  }
});

playlistsRouter.post("/liked-songs/materialize", async (_req, res, next) => {
  try {
    res.json(await materializeLikedSongs());
  } catch (error) {
    next(error);
  }
});

export const playlistSelectionSchema = z.object({
  playlistId: z.string().min(1)
});
