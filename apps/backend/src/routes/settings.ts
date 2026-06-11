import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { Router } from "express";
import { z } from "zod";
import { applyRuntimeEnv, env } from "../env.js";

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

    const required = requiredRedirectUris();
    const input = updateSchema.parse(req.body);
    const current = readRawConfig(options.configPath);
    const next = {
      FRONTEND_URL: env.FRONTEND_URL,
      SPOTIFY_CLIENT_ID: input.spotify.clientId,
      SPOTIFY_CLIENT_SECRET: input.spotify.clientSecret || current.SPOTIFY_CLIENT_SECRET || "",
      SPOTIFY_REDIRECT_URI: input.spotify.redirectUri,
      GOOGLE_CLIENT_ID: input.youtube.clientId,
      GOOGLE_CLIENT_SECRET: input.youtube.clientSecret || current.GOOGLE_CLIENT_SECRET || "",
      GOOGLE_REDIRECT_URI: input.youtube.redirectUri
    };

    const candidate = { ...current, ...next };
    const errors = validateConfig(candidate, required);
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
  const required = requiredRedirectUris();
  const errors = validateConfig(raw, required);

  return {
    desktopMode: options.desktopMode,
    configDir: options.configDir,
    configPath: options.configPath,
    requiredRedirectUris: required,
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

export function requiredRedirectUris(origin = env.FRONTEND_URL): { spotify: string; youtube: string } {
  const base = new URL(origin).origin;
  return {
    spotify: `${base}/api/auth/spotify/callback`,
    youtube: `${base}/api/auth/youtube/callback`
  };
}

export function validateConfig(
  config: NodeJS.ProcessEnv,
  required: { spotify: string; youtube: string } = requiredRedirectUris()
): string[] {
  const errors: string[] = [];

  if (!config.SESSION_SECRET || config.SESSION_SECRET.length < 24) {
    errors.push("SESSION_SECRET is missing or too short.");
  }

  if (!isValidEncryptionKey(config.TOKEN_ENCRYPTION_KEY)) {
    errors.push("TOKEN_ENCRYPTION_KEY must be a 32-byte base64 value.");
  }

  if (!config.SPOTIFY_CLIENT_ID) errors.push("SPOTIFY_CLIENT_ID is missing.");
  if (!config.SPOTIFY_CLIENT_SECRET) errors.push("SPOTIFY_CLIENT_SECRET is missing.");
  if (config.SPOTIFY_REDIRECT_URI !== required.spotify) {
    errors.push(`SPOTIFY_REDIRECT_URI must be ${required.spotify}.`);
  }

  if (!config.GOOGLE_CLIENT_ID) errors.push("GOOGLE_CLIENT_ID is missing.");
  if (!config.GOOGLE_CLIENT_SECRET) errors.push("GOOGLE_CLIENT_SECRET is missing.");
  if (config.GOOGLE_REDIRECT_URI !== required.youtube) {
    errors.push(`GOOGLE_REDIRECT_URI must be ${required.youtube}.`);
  }

  return errors;
}

export function readRawConfig(configPath: string): NodeJS.ProcessEnv {
  if (!fs.existsSync(configPath)) return {};
  return parseConfigText(fs.readFileSync(configPath, "utf8"));
}

export function parseConfigText(text: string): NodeJS.ProcessEnv {
  const parsed = dotenv.parse(text);

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;

    const key = trimmed.slice(0, separator);
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!rawValue.startsWith('"')) continue;

    try {
      parsed[key] = JSON.parse(rawValue) as string;
    } catch {
      // Keep dotenv's legacy parsing for hand-edited values that are not JSON strings.
    }
  }

  return parsed;
}

export function writeConfig(configPath: string, values: NodeJS.ProcessEnv): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = formatConfig(values);
  fs.writeFileSync(configPath, config, { encoding: "utf8", mode: 0o600 });
  secureConfigFile(configPath);
}

export function formatConfig(values: NodeJS.ProcessEnv): string {
  const required = requiredRedirectUris();
  const lines = [
    ["NODE_ENV", values.NODE_ENV ?? "development"],
    ["PORT", "4000"],
    ["DESKTOP_MODE", "true"],
    ["FRONTEND_URL", values.FRONTEND_URL ?? env.FRONTEND_URL],
    ["SESSION_SECRET", values.SESSION_SECRET ?? ""],
    ["TOKEN_ENCRYPTION_KEY", values.TOKEN_ENCRYPTION_KEY ?? ""],
    ["DATABASE_PATH", values.DATABASE_PATH ?? ""],
    "",
    "# Spotify app settings",
    ["SPOTIFY_CLIENT_ID", values.SPOTIFY_CLIENT_ID ?? ""],
    ["SPOTIFY_CLIENT_SECRET", values.SPOTIFY_CLIENT_SECRET ?? ""],
    ["SPOTIFY_REDIRECT_URI", values.SPOTIFY_REDIRECT_URI ?? required.spotify],
    "",
    "# Google OAuth client for YouTube Data API v3",
    ["GOOGLE_CLIENT_ID", values.GOOGLE_CLIENT_ID ?? ""],
    ["GOOGLE_CLIENT_SECRET", values.GOOGLE_CLIENT_SECRET ?? ""],
    ["GOOGLE_REDIRECT_URI", values.GOOGLE_REDIRECT_URI ?? required.youtube],
    "",
    "# Transfer tuning",
    ["MATCH_CONFIDENCE_THRESHOLD", values.MATCH_CONFIDENCE_THRESHOLD ?? String(env.MATCH_CONFIDENCE_THRESHOLD)],
    ["TRANSFER_BATCH_SIZE", values.TRANSFER_BATCH_SIZE ?? String(env.TRANSFER_BATCH_SIZE)],
    ["TRANSFER_BATCH_DELAY_MS", values.TRANSFER_BATCH_DELAY_MS ?? String(env.TRANSFER_BATCH_DELAY_MS)],
    ["MAX_RETRY_ATTEMPTS", values.MAX_RETRY_ATTEMPTS ?? String(env.MAX_RETRY_ATTEMPTS)],
    ""
  ];

  return lines.map((line) => (Array.isArray(line) ? `${line[0]}=${formatEnvValue(line[1])}` : line)).join("\n");
}

export function formatEnvValue(value: string): string {
  if (value === "") return "";
  return JSON.stringify(value);
}

export function secureConfigFile(configPath: string): void {
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // chmod is best-effort on Windows, but POSIX-like installs get owner-only permissions.
  }
}

function isValidEncryptionKey(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}

function applyRuntimeConfig(values: NodeJS.ProcessEnv): void {
  applyRuntimeEnv(values);
}
