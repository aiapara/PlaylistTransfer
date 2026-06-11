import type { AuthStatus, SourcePlaylist, TransferDetail, TransferSummary } from "@playlist-transfer/shared";

export type DesktopSettings = {
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

export type SettingsUpdate = {
  spotify: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  youtube: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    },
    ...init
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const details = Array.isArray(data.details) ? ` ${data.details.join(" ")}` : "";
    throw new Error(`${data.error ?? response.statusText}${details}`);
  }

  return response.json() as Promise<T>;
}

export const client = {
  settings: () => api<DesktopSettings>("/api/settings"),
  saveSettings: (settings: SettingsUpdate) =>
    api<DesktopSettings>("/api/settings", {
      method: "POST",
      body: JSON.stringify(settings)
    }),
  openConfigFolder: () =>
    api<{ ok: true }>("/api/settings/open-config-folder", {
      method: "POST"
    }),
  status: () => api<AuthStatus>("/api/auth/status"),
  playlists: () => api<SourcePlaylist[]>("/api/playlists"),
  transfers: () => api<TransferSummary[]>("/api/transfers"),
  transfer: (id: string) => api<TransferDetail>(`/api/transfers/${id}`),
  preview: (playlistId: string) =>
    api<TransferDetail>("/api/transfers/preview", {
      method: "POST",
      body: JSON.stringify({ playlistId })
    }),
  start: (id: string) =>
    api<TransferDetail>(`/api/transfers/${id}/start`, {
      method: "POST"
    }),
  approveMatch: (transferId: string, itemId: string, videoId: string) =>
    api<TransferDetail>(`/api/transfers/${transferId}/items/${itemId}/approve`, {
      method: "POST",
      body: JSON.stringify({ videoId })
    }),
  skipMatch: (transferId: string, itemId: string) =>
    api<TransferDetail>(`/api/transfers/${transferId}/items/${itemId}/skip`, {
      method: "POST"
    }),
  searchMatch: (transferId: string, itemId: string, query: string) =>
    api<TransferDetail>(`/api/transfers/${transferId}/items/${itemId}/search`, {
      method: "POST",
      body: JSON.stringify({ query })
    }),
  materializeLiked: () =>
    api<{ id: string; name: string }>("/api/playlists/liked-songs/materialize", {
      method: "POST"
    })
};
