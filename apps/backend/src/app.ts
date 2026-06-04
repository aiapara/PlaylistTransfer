import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";
import { env } from "./env.js";
import "./db/index.js";
import { authRouter } from "./routes/auth.js";
import { playlistsRouter } from "./routes/playlists.js";
import { transfersRouter } from "./routes/transfers.js";

export const logger = pino({ level: env.NODE_ENV === "production" ? "info" : "debug" });

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.FRONTEND_URL,
      credentials: true
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(
    session({
      name: "playlist_transfer.sid",
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 1000 * 60 * 60
      }
    })
  );
  app.use(pinoHttp({ logger }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/auth", authRouter);
  app.use("/api/playlists", playlistsRouter);
  app.use("/api/transfers", transfersRouter);

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) {
      return res.status(400).json({ error: "Invalid request.", details: error.flatten() });
    }

    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    logger.error({ error }, message);
    return res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
  });

  return app;
}
