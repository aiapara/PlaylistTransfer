import { db } from "../db/index.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";

export type StoredToken = {
  provider: "spotify" | "youtube";
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  profileId?: string;
  profileName?: string;
};

export function getToken(provider: StoredToken["provider"]): StoredToken | undefined {
  const row = db.prepare("SELECT * FROM oauth_tokens WHERE provider = ?").get(provider) as
    | {
        provider: "spotify" | "youtube";
        access_token: string;
        refresh_token?: string;
        expires_at: number;
        profile_id?: string;
        profile_name?: string;
      }
    | undefined;

  if (!row) return undefined;

  return {
    provider: row.provider,
    accessToken: decryptSecret(row.access_token),
    refreshToken: row.refresh_token ? decryptSecret(row.refresh_token) : undefined,
    expiresAt: row.expires_at,
    profileId: row.profile_id,
    profileName: row.profile_name
  };
}

export function saveToken(token: StoredToken): void {
  const current = getToken(token.provider);
  const refreshToken = token.refreshToken ?? current?.refreshToken;

  db.prepare(
    `INSERT INTO oauth_tokens (
      provider, access_token, refresh_token, expires_at, profile_id, profile_name, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
      expires_at = excluded.expires_at,
      profile_id = excluded.profile_id,
      profile_name = excluded.profile_name,
      updated_at = CURRENT_TIMESTAMP`
  ).run(
    token.provider,
    encryptSecret(token.accessToken),
    refreshToken ? encryptSecret(refreshToken) : null,
    token.expiresAt,
    token.profileId ?? null,
    token.profileName ?? null
  );
}

export function hasToken(provider: StoredToken["provider"]): boolean {
  return Boolean(getToken(provider));
}
