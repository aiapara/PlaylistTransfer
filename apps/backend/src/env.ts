import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  SESSION_SECRET: z.string().min(24),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  DATABASE_PATH: z.string().default("./data/playlist-transfer.db"),
  SPOTIFY_CLIENT_ID: z.string().min(1),
  SPOTIFY_CLIENT_SECRET: z.string().min(1),
  SPOTIFY_REDIRECT_URI: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),
  MATCH_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
  TRANSFER_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  TRANSFER_BATCH_DELAY_MS: z.coerce.number().int().nonnegative().default(1200),
  MAX_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(4)
});

export const env = schema.parse(process.env);
