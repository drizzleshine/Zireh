import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateMintKeys, type MintKeys, type SpentStore } from "@zireh/wallet";
import type { ResponseStore, StoredResponse } from "@zireh/relay-core";

/** Mint keys live in one owner-only file. Losing it invalidates all outstanding coins. */
export function loadOrCreateMintKeys(dataDir: string): MintKeys {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "mint-keys.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as MintKeys;
  const keys = generateMintKeys();
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  chmodSync(file, 0o600);
  return keys;
}

export function openRelayDb(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, "relay.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS spent (secret TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS responses (request_id TEXT PRIMARY KEY, at INTEGER NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL);
  `);
  return db;
}

/** Atomic all-or-nothing double-spend check backed by SQLite. */
export function sqliteSpentStore(db: DatabaseSync): SpentStore {
  const exists = db.prepare("SELECT 1 FROM spent WHERE secret = ?");
  const insert = db.prepare("INSERT INTO spent (secret) VALUES (?)");
  return {
    markSpent(secrets) {
      if (new Set(secrets).size !== secrets.length) return false;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (secrets.some((s) => exists.get(s))) {
          db.exec("ROLLBACK");
          return false;
        }
        for (const s of secrets) insert.run(s);
        db.exec("COMMIT");
        return true;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

/**
 * Replies are kept only long enough to recover a dropped connection (default 15 min),
 * because they contain answers. Prompts are never stored.
 */
export function sqliteResponseStore(db: DatabaseSync, ttlMs = 15 * 60 * 1000): ResponseStore {
  const get = db.prepare("SELECT status, body, at FROM responses WHERE request_id = ?");
  const put = db.prepare("INSERT OR REPLACE INTO responses (request_id, at, status, body) VALUES (?, ?, ?, ?)");
  const sweep = db.prepare("DELETE FROM responses WHERE at < ?");
  return {
    get(id) {
      const row = get.get(id) as { status: number; body: string; at: number } | undefined;
      if (!row || Date.now() - row.at > ttlMs) return undefined;
      return { status: row.status, body: JSON.parse(row.body) } satisfies StoredResponse;
    },
    put(id, response) {
      sweep.run(Date.now() - ttlMs);
      put.run(id, Date.now(), response.status, JSON.stringify(response.body));
    },
  };
}
