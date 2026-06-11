import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { env } from "../env.js";
import { runMigrations } from "./migrations.js";

const dbPath = path.resolve(env.DATABASE_PATH);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

runMigrations(db);
