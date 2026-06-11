import crypto from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, session, shell } from "electron";
import type { Event } from "electron";
import dotenv from "dotenv";

let mainWindow: BrowserWindow | undefined;
let server: Server | undefined;
let localUrl = "";

type BackendModule = {
  createApp: (options: {
    desktopMode: boolean;
    staticDir: string;
    configDir: string;
    configPath: string;
    openConfigFolder: () => Promise<void>;
  }) => {
    listen: (port: number, hostname: string) => Server;
  };
  setDesktopRuntimeOrigin: (origin: string) => void;
  logger: {
    info: (message: string) => void;
    warn?: (message: string) => void;
  };
};

app.setName("Playlist Transfer");

async function start() {
  const userDataPath = app.getPath("userData");
  const configPath = configureLocalEnvironment(userDataPath);
  const preferredPort = 4000;

  const backendUrl = pathToFileURL(path.resolve(__dirname, "../../backend/dist/app.js")).href;
  const importModule = new Function("specifier", "return import(specifier)") as <T>(specifier: string) => Promise<T>;
  const { createApp, logger, setDesktopRuntimeOrigin } = await importModule<BackendModule>(backendUrl);
  const expressApp = createApp({
    desktopMode: true,
    staticDir: path.resolve(__dirname, "../../frontend/dist"),
    configDir: userDataPath,
    configPath,
    openConfigFolder: async () => {
      const error = await shell.openPath(userDataPath);
      if (error) throw new Error(error);
    }
  });

  const listening = await listenWithFallback(expressApp, preferredPort);
  server = listening.server;
  localUrl = `http://127.0.0.1:${listening.port}`;
  setDesktopRuntimeOrigin(localUrl);

  if (listening.port !== preferredPort) {
    logger.warn?.(`Preferred port ${preferredPort} was unavailable; using ${localUrl}.`);
  }
  logger.info(`Desktop backend listening on ${localUrl}`);

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  await createWindow();
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: "Playlist Transfer",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  wireNavigationSecurity(mainWindow);

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  await mainWindow.loadURL(localUrl);
}

function configureLocalEnvironment(userDataPath: string): string {
  fs.mkdirSync(userDataPath, { recursive: true });
  const configPath = path.join(userDataPath, "playlist-transfer.env");
  ensureConfigFile(configPath, userDataPath);

  const parsed = dotenv.parse(fs.readFileSync(configPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] = process.env[key] ?? value;
  }

  process.env.DESKTOP_MODE = "true";
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.PORT = "4000";
  process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? `http://127.0.0.1:${process.env.PORT}`;
  process.env.SPOTIFY_REDIRECT_URI =
    process.env.SPOTIFY_REDIRECT_URI ?? `http://127.0.0.1:${process.env.PORT}/api/auth/spotify/callback`;
  process.env.GOOGLE_REDIRECT_URI =
    process.env.GOOGLE_REDIRECT_URI ?? `http://127.0.0.1:${process.env.PORT}/api/auth/youtube/callback`;
  process.env.DATABASE_PATH = process.env.DATABASE_PATH ?? path.join(userDataPath, "playlist-transfer.db");
  process.env.DESKTOP_CONFIG_DIR = userDataPath;
  process.env.DESKTOP_CONFIG_PATH = configPath;

  secureConfigFile(configPath);
  return configPath;
}

function ensureConfigFile(configPath: string, userDataPath: string): void {
  if (fs.existsSync(configPath)) {
    secureConfigFile(configPath);
    return;
  }

  const defaultConfig = [
    "NODE_ENV=development",
    "PORT=4000",
    "DESKTOP_MODE=true",
    "FRONTEND_URL=http://127.0.0.1:4000",
    `SESSION_SECRET=${crypto.randomBytes(48).toString("hex")}`,
    `TOKEN_ENCRYPTION_KEY=${crypto.randomBytes(32).toString("base64")}`,
    `DATABASE_PATH=${toEnvPath(path.join(userDataPath, "playlist-transfer.db"))}`,
    "",
    "# Spotify app settings",
    "SPOTIFY_CLIENT_ID=",
    "SPOTIFY_CLIENT_SECRET=",
    "SPOTIFY_REDIRECT_URI=http://127.0.0.1:4000/api/auth/spotify/callback",
    "",
    "# Google OAuth client for YouTube Data API v3",
    "GOOGLE_CLIENT_ID=",
    "GOOGLE_CLIENT_SECRET=",
    "GOOGLE_REDIRECT_URI=http://127.0.0.1:4000/api/auth/youtube/callback",
    "",
    "# Transfer tuning",
    "MATCH_CONFIDENCE_THRESHOLD=0.72",
    "TRANSFER_BATCH_SIZE=20",
    "TRANSFER_BATCH_DELAY_MS=1200",
    "MAX_RETRY_ATTEMPTS=4",
    ""
  ].join("\n");

  fs.writeFileSync(configPath, defaultConfig, { encoding: "utf8", mode: 0o600 });
  secureConfigFile(configPath);
}

function listenWithFallback(
  expressApp: { listen: (port: number, hostname: string) => Server },
  preferredPort: number
): Promise<{ server: Server; port: number }> {
  return listenOn(expressApp, preferredPort).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE") throw error;
    return listenOn(expressApp, 0);
  });
}

function listenOn(
  expressApp: { listen: (port: number, hostname: string) => Server },
  port: number
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const candidate = expressApp.listen(port, "127.0.0.1");
    candidate.once("error", (error) => {
      candidate.close();
      reject(error);
    });
    candidate.once("listening", () => {
      const address = candidate.address() as AddressInfo;
      resolve({ server: candidate, port: address.port });
    });
  });
}

function wireNavigationSecurity(window: BrowserWindow): void {
  const guard = (event: Event, targetUrl: string) => {
    if (isOAuthStartUrl(targetUrl)) {
      event.preventDefault();
      void shell.openExternal(targetUrl);
      return;
    }

    if (!isAllowedAppUrl(targetUrl)) {
      event.preventDefault();
    }
  };

  window.webContents.on("will-navigate", guard);
  window.webContents.on("will-redirect", guard);
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }

    return { action: "deny" };
  });
}

function isOAuthStartUrl(targetUrl: string): boolean {
  try {
    const url = new URL(targetUrl);
    return url.origin === localUrl && /^\/api\/auth\/(?:spotify|youtube)\/login$/.test(url.pathname);
  } catch {
    return false;
  }
}

function isAllowedAppUrl(targetUrl: string): boolean {
  try {
    const url = new URL(targetUrl);
    return url.origin === localUrl;
  } catch {
    return false;
  }
}

function isAllowedExternalUrl(targetUrl: string): boolean {
  try {
    const url = new URL(targetUrl);
    return ["https://accounts.spotify.com", "https://accounts.google.com"].includes(url.origin);
  } catch {
    return false;
  }
}

function secureConfigFile(configPath: string): void {
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // chmod is best-effort on Windows, but POSIX-like installs get owner-only permissions.
  }
}

function toEnvPath(value: string): string {
  return value.replaceAll("\\", "/");
}

app.whenReady().then(() => {
  void start().catch((error) => {
    console.error(error);
    app.quit();
  });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  server?.close();
});
