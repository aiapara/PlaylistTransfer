import type { AuthStatus, SourcePlaylist, TransferDetail, TransferSummary } from "@playlist-transfer/shared";

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
    throw new Error(data.error ?? response.statusText);
  }

  return response.json() as Promise<T>;
}

export const client = {
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
  materializeLiked: () =>
    api<{ id: string; name: string }>("/api/playlists/liked-songs/materialize", {
      method: "POST"
    })
};
