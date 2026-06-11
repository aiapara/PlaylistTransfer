import { Router } from "express";
import type { Request } from "express";
import { env } from "../env.js";
import { randomState } from "../lib/crypto.js";
import { exchangeSpotifyCode, spotifyLoginUrl } from "../services/spotify.js";
import { hasToken } from "../services/tokenStore.js";
import { exchangeYoutubeCode, youtubeLoginUrl } from "../services/youtube.js";

declare module "express-session" {
  interface SessionData {
    oauthState?: string;
  }
}

export const authRouter = Router();

authRouter.get("/status", (_req, res) => {
  res.json({ spotify: hasToken("spotify"), youtube: hasToken("youtube") });
});

authRouter.get("/spotify/login", (req, res) => {
  const state = setState(req);
  res.redirect(spotifyLoginUrl(state));
});

authRouter.get("/spotify/callback", async (req, res, next) => {
  try {
    assertState(req, String(req.query.state ?? ""));
    await exchangeSpotifyCode(String(req.query.code ?? ""));
    completeCallback(res, "spotify");
  } catch (error) {
    next(error);
  }
});

authRouter.get("/youtube/login", (req, res) => {
  const state = setState(req);
  res.redirect(youtubeLoginUrl(state));
});

authRouter.get("/youtube/callback", async (req, res, next) => {
  try {
    assertState(req, String(req.query.state ?? ""));
    await exchangeYoutubeCode(String(req.query.code ?? ""));
    completeCallback(res, "youtube");
  } catch (error) {
    next(error);
  }
});

function setState(req: Request): string {
  const state = randomState();
  req.session.oauthState = state;
  return state;
}

function assertState(req: Request, actual: string): void {
  if (!actual || actual !== req.session.oauthState) {
    throw new Error("OAuth state validation failed.");
  }
  req.session.oauthState = undefined;
}

function completeCallback(res: import("express").Response, provider: "spotify" | "youtube"): void {
  if (!env.DESKTOP_MODE) {
    res.redirect(`${env.FRONTEND_URL}/?connected=${provider}`);
    return;
  }

  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Playlist Transfer</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
    <style>
      body { font-family: system-ui, sans-serif; margin: 40px; color: #151916; }
      p { color: #526158; }
    </style>
  </head>
  <body>
    <h1>${provider === "spotify" ? "Spotify" : "YouTube"} connected</h1>
    <p>You can return to Playlist Transfer.</p>
    <script>window.close();</script>
  </body>
</html>`);
}
