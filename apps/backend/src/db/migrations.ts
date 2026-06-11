import type Database from "better-sqlite3";

type Migration = {
  id: number;
  name: string;
  sql: string;
};

const migrations: Migration[] = [
  {
    id: 1,
    name: "initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        provider TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at INTEGER NOT NULL,
        profile_id TEXT,
        profile_name TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS transfers (
        id TEXT PRIMARY KEY,
        source_playlist_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        playlist_title TEXT NOT NULL,
        playlist_description TEXT NOT NULL DEFAULT '',
        destination_playlist_id TEXT,
        status TEXT NOT NULL,
        total_tracks INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS transfer_items (
        id TEXT PRIMARY KEY,
        transfer_id TEXT NOT NULL,
        source_track_id TEXT NOT NULL,
        track_title TEXT NOT NULL,
        artists_json TEXT NOT NULL,
        album TEXT,
        duration_ms INTEGER,
        selected_video_id TEXT,
        selected_title TEXT,
        selected_channel TEXT,
        score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        added_at TEXT,
        candidates_json TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (transfer_id) REFERENCES transfers(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_transfer_items_transfer ON transfer_items(transfer_id);
      CREATE INDEX IF NOT EXISTS idx_transfer_items_status ON transfer_items(status);

      CREATE TABLE IF NOT EXISTS transfer_logs (
        id TEXT PRIMARY KEY,
        transfer_id TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (transfer_id) REFERENCES transfers(id) ON DELETE CASCADE
      );
    `
  },
  {
    id: 2,
    name: "rename_added_status_to_transferred",
    sql: `
      UPDATE transfer_items
      SET status = 'transferred'
      WHERE status = 'added';
    `
  },
  {
    id: 3,
    name: "manual_review_metadata",
    sql: `
      ALTER TABLE transfer_items ADD COLUMN selection_source TEXT NOT NULL DEFAULT 'automatic';
      ALTER TABLE transfer_items ADD COLUMN reviewed_at TEXT;

      UPDATE transfer_items
      SET selection_source = 'none'
      WHERE status IN ('unmatched', 'skipped');

      UPDATE transfer_items
      SET reviewed_at = CURRENT_TIMESTAMP
      WHERE status = 'skipped';
    `
  }
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const applied = new Set(
    (
      db.prepare("SELECT id FROM schema_migrations").all() as {
        id: number;
      }[]
    ).map((row) => row.id)
  );

  const apply = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations (id, name) VALUES (?, ?)").run(migration.id, migration.name);
  });

  for (const migration of migrations) {
    if (!applied.has(migration.id)) {
      apply(migration);
    }
  }
}
