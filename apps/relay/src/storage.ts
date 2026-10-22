import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QuoteRecord, QuoteStore } from "@zireh/zcash";
import { DatabaseSync } from "node:sqlite";
import { generateMintKeys, type MintKeys, type SpentStore } from "@zireh/wallet";
import { settlementOnly, type ResponseStore, type StoredResponse } from "@zireh/relay-core";

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
  const file = join(dataDir, "relay.db");
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
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
    markSpent(secrets, commit) {
      if (new Set(secrets).size !== secrets.length) return false;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (secrets.some((s) => exists.get(s))) {
          db.exec("ROLLBACK");
          return false;
        }
        for (const s of secrets) insert.run(s);
        commit?.();
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
 * Answers stop being served after 15 minutes or acknowledgement. Financial recovery
 * responses and crash markers persist indefinitely. Prompts are never stored.
 */
export function sqliteResponseStore(db: DatabaseSync, ttlMs = 15 * 60 * 1000): ResponseStore {
  const get = db.prepare("SELECT status, body, at FROM responses WHERE request_id = ?");
  const put = db.prepare("INSERT OR REPLACE INTO responses (request_id, at, status, body) VALUES (?, ?, ?, ?)");
  const redact = db.prepare("UPDATE responses SET body = ? WHERE request_id = ?");
  return {
    get(id) {
      const row = get.get(id) as { status: number; body: string; at: number } | undefined;
      if (!row) return undefined;
      const response = { status: row.status, body: JSON.parse(row.body) } satisfies StoredResponse;
      if (Date.now() - row.at <= ttlMs) return response;
      const financial = settlementOnly(response);
      if (financial) redact.run(JSON.stringify(financial.body), id);
      return financial;
    },
    put(id, response) {
      put.run(id, Date.now(), response.status, JSON.stringify(response.body));
    },
    acknowledge(id) {
      const row = get.get(id) as { status: number; body: string } | undefined;
      if (!row) return;
      const financial = settlementOnly({ status: row.status, body: JSON.parse(row.body) });
      if (financial) redact.run(JSON.stringify(financial.body), id);
    },
  };
}

/** Shares the relay connection with minted responses, so mint state and signatures commit together. */
export function sqliteQuoteStore(db: DatabaseSync): QuoteStore {
  const get = db.prepare("SELECT body FROM quotes WHERE id = ?");
  const put = db.prepare("INSERT OR REPLACE INTO quotes (id, body) VALUES (?, ?)");
  return {
    get(id) { const row = get.get(id) as { body: string } | undefined; return row ? JSON.parse(row.body) as QuoteRecord : undefined; },
    put(id, record) { put.run(id, JSON.stringify(record)); },
    atomically(work) {
      db.exec("BEGIN IMMEDIATE");
      try { const result = work(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}
