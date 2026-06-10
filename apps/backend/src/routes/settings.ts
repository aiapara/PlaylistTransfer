import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { env } from "../env.js";

const REQUIRED_SPOTIFY_REDIRECT_URI = "http://127.0.0.1:4000/api/auth/spotify/callback";
const REQUIRED_GOOGLE_REDIRECT_URI = "http://127.0.0.1:4000/api/auth/youtube/callback";

type SettingsRouterOptions = {
  desktopMode: boolean;
  configDir?: string;
  configPath?: string;
  openConfigFolder?: () => Promise<void> | void;
};

type DesktopSettings = {
  desktopMode: boolean;
  configDir?: string;
  configPath?: string;
  requiredRedirectUris: {
    spotify: string;
    youtube: string;
  };
  spotify: {
    clientId: string;
    clientSecretSet: boolean;
    redirectUri: string;
  };
  youtube: {
    clientId: string;
    clientSecretSet: boolean;
    redirectUri: string;
  };
  setup: {
    ready: boolean;
    errors: string[];
  };
};

const updateSchema = z.object({
  spotify: z.object({
    clientId: z.string().trim(),
    clientSecret: z.string(),
    redirectUri: z.string().trim().url()
  }),
  youtube: z.object({
    clientId: z.string().trim(),
    clientSecret: z.string(),
    redirectUri: z.string().trim().url()
  })
});

export function createSettingsRouter(options: SettingsRouterOptions): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(readSettings(options));
  });

  router.post("/", (req, res) => {
    if (!options.desktopMode || !options.configPath) {
      return res.status(404).json({ error: "Desktop settings are only available in the Electron app." });
    }

    const input = updateSchema.parse(req.body);
    const current = readRawConfig(options.configPath);
    const next = {
      SPOTIFY_CLIENT_ID: input.spotify.clientId,
      SPOTIFY_CLIENT_SECRET: input.spotify.clientSecret || current.SPOTIFY_CLIENT_SECRET || "",
      SPOTIFY_REDIRECT_URI: input.spotify.redirectUri,
      GOOGLE_CLIENT_ID: input.youtube.clientId,
      GOOGLE_CLIENT_SECRET: input.youtube.clientSecret || current.GOOGLE_CLIENT_SECRET || "",
      GOOGLE_REDIRECT_URI: input.youtube.redirectUri
    };

    const candidate = { ...current, ...next };
    const errors = validateConfig(candidate);
    if (errors.length > 0) {
      return res.status(400).json({ error: "Settings are incomplete.", details: errors });
    }

    writeConfig(options.configPath, candidate);
    applyRuntimeConfig(next);

    return res.json(readSettings(options));
  });

  router.post("/open-config-folder", async (_req, res, next) => {
    try {
      if (!options.desktopMode || !options.openConfigFolder) {
        return res.status(404).json({ error: "Config folder opening is only available in the Electron app." });
      }

      await options.openConfigFolder();
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

function readSettings(options: SettingsRouterOptions): DesktopSettings {
  const raw = options.configPath ? readRawConfig(options.configPath) : process.env;
  const errors = validateConfig(raw);

  return {
    desktopMode: options.desktopMode,
    configDir: options.configDir,
    configPath: options.configPath,
    requiredRedirectUris: {
      spotify: REQUIRED_SPOTIFY_REDIRECT_URI,
      youtube: REQUIRED_GOOGLE_REDIRECT_URI
    },
    spotify: {
      clientId: raw.SPOTIFY_CLIENT_ID ?? "",
      clientSecretSet: Boolean(raw.SPOTIFY_CLIENT_SECRET),
      redirectUri: raw.SPOTIFY_REDIRECT_URI ?? ""
    },
    youtube: {
      clientId: raw.GOOGLE_CLIENT_ID ?? "",
      clientSecretSet: Boolean(raw.GOOGLE_CLIENT_SECRET),
      redirectUri: raw.GOOGLE_REDIRECT_URI ?? ""
    },
    setup: {
      ready: errors.length === 0,
      errors
    }
  };
}

function validateConfig(config: NodeJS.ProcessEnv): string[] {
  const errors: string[] = [];

  if (!config.SESSION_SECRET || config.SESSION_SECRET.length < 24) {
    errors.push("SESSION_SECRET is missing or too short.");
  }

  if (!isValidEncryptionKey(config.TOKEN_ENCRYPTION_KEY)) {
    errors.push("TOKEN_ENCRYPTION_KEY must be a 32-byte base64 value.");
  }

  if (!config.SPOTIFY_CLIENT_ID) errors.push("SPOTIFY_CLIENT_ID is missing.");
  if (!config.SPOTIFY_CLIENT_SECRET) errors.push("SPOTIFY_CLIENT_SECRET is missing.");
  if (config.SPOTIFY_REDIRECT_URI !== REQUIRED_SPOTIFY_REDIRECT_URI) {
    errors.push(`SPOTIFY_REDIRECT_URI must be ${REQUIRED_SPOTIFY_REDIRECT_URI}.`);
  }

  if (!config.GOOGLE_CLIENT_ID) errors.push("GOOGLE_CLIENT_ID is missing.");
  if (!config.GOOGLE_CLIENT_SECRET) errors.push("GOOGLE_CLIENT_SECRET is missing.");
  if (config.GOOGLE_REDIRECT_URI !== REQUIRED_GOOGLE_REDIRECT_URI) {
    errors.push(`GOOGLE_REDIRECT_URI must be ${REQUIRED_GOOGLE_REDIRECT_URI}.`);
  }

  return errors;
}

function isValidEncryptionKey(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}

function readRawConfig(configPath: string): NodeJS.ProcessEnv {
  if (!fs.existsSync(configPath)) return {};

  const config: NodeJS.ProcessEnv = {};
  const lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    config[key] = value;
  }

  return config;
}

function writeConfig(configPath: string, values: NodeJS.ProcessEnv): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = [
    `NODE_ENV=${values.NODE_ENV ?? "development"}`,
    `PORT=${values.PORT ?? "4000"}`,
    "DESKTOP_MODE=true",
    `FRONTEND_URL=${values.FRONTEND_URL ?? "http://127.0.0.1:4000"}`,
    `SESSION_SECRET=${values.SESSION_SECRET ?? ""}`,
    `TOKEN_ENCRYPTION_KEY=${values.TOKEN_ENCRYPTION_KEY ?? ""}`,
    `DATABASE_PATH=${values.DATABASE_PATH ?? ""}`,
    "",
    "# Spotify app settings",
    `SPOTIFY_CLIENT_ID=${values.SPOTIFY_CLIENT_ID ?? ""}`,
    `SPOTIFY_CLIENT_SECRET=${values.SPOTIFY_CLIENT_SECRET ?? ""}`,
    `SPOTIFY_REDIRECT_URI=${values.SPOTIFY_REDIRECT_URI ?? REQUIRED_SPOTIFY_REDIRECT_URI}`,
    "",
    "# Google OAuth client for YouTube Data API v3",
    `GOOGLE_CLIENT_ID=${values.GOOGLE_CLIENT_ID ?? ""}`,
    `GOOGLE_CLIENT_SECRET=${values.GOOGLE_CLIENT_SECRET ?? ""}`,
    `GOOGLE_REDIRECT_URI=${values.GOOGLE_REDIRECT_URI ?? REQUIRED_GOOGLE_REDIRECT_URI}`,
    "",
    "# Transfer tuning",
    `MATCH_CONFIDENCE_THRESHOLD=${values.MATCH_CONFIDENCE_THRESHOLD ?? String(env.MATCH_CONFIDENCE_THRESHOLD)}`,
    `TRANSFER_BATCH_SIZE=${values.TRANSFER_BATCH_SIZE ?? String(env.TRANSFER_BATCH_SIZE)}`,
    `TRANSFER_BATCH_DELAY_MS=${values.TRANSFER_BATCH_DELAY_MS ?? String(env.TRANSFER_BATCH_DELAY_MS)}`,
    `MAX_RETRY_ATTEMPTS=${values.MAX_RETRY_ATTEMPTS ?? String(env.MAX_RETRY_ATTEMPTS)}`,
    ""
  ].join("\n");

  fs.writeFileSync(configPath, config, "utf8");
}

function applyRuntimeConfig(values: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }

  env.SPOTIFY_CLIENT_ID = values.SPOTIFY_CLIENT_ID ?? env.SPOTIFY_CLIENT_ID;
  env.SPOTIFY_CLIENT_SECRET = values.SPOTIFY_CLIENT_SECRET ?? env.SPOTIFY_CLIENT_SECRET;
  env.SPOTIFY_REDIRECT_URI = values.SPOTIFY_REDIRECT_URI ?? env.SPOTIFY_REDIRECT_URI;
  env.GOOGLE_CLIENT_ID = values.GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID;
  env.GOOGLE_CLIENT_SECRET = values.GOOGLE_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET;
  env.GOOGLE_REDIRECT_URI = values.GOOGLE_REDIRECT_URI ?? env.GOOGLE_REDIRECT_URI;
}
