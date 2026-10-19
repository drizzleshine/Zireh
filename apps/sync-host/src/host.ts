import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { caseTokenHash } from "@zireh/cases";
import { Envelope, type StoredEnvelope } from "@zireh/sync";
import { z } from "zod";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS_PER_PUSH = 200;
const MAX_RECORDS_PER_PULL = 500;

export function openHostDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS cases (case_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS records (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL, id TEXT NOT NULL, collection TEXT NOT NULL, sealed TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_by_case ON records (case_id, seq);
  `);
  return db;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * The sync host stores sealed envelopes in an append-only log per case. It can check that a
 * writer holds the case token, but it never sees a key or a plaintext record.
 */
export function createSyncHost(db: DatabaseSync): (req: Request) => Promise<Response> {
  const getCase = db.prepare("SELECT token_hash FROM cases WHERE case_id = ?");
  const addCase = db.prepare("INSERT INTO cases (case_id, token_hash) VALUES (?, ?)");
  const addRecord = db.prepare("INSERT INTO records (case_id, id, collection, sealed) VALUES (?, ?, ?, ?)");
  const listRecords = db.prepare("SELECT seq, id, collection, sealed FROM records WHERE case_id = ? AND seq > ? ORDER BY seq LIMIT ?");
  const lastSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM records WHERE case_id = ?");

  /** First writer registers the case; afterwards the token must match. */
  function authorize(caseId: string, token: string | null, register: boolean): Response | undefined {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return json(401, { error: "missing case token" });
    const row = getCase.get(caseId) as { token_hash: string } | undefined;
    if (!row) {
      if (!register) return json(404, { error: "unknown case" });
      addCase.run(caseId, caseTokenHash(token));
      return undefined;
    }
    return row.token_hash === caseTokenHash(token) ? undefined : json(403, { error: "wrong case token" });
  }

  return async (req) => {
    const url = new URL(req.url);
    const m = /^\/v1\/cases\/([0-9a-f]{32})\/records$/.exec(url.pathname);
    if (!m) return url.pathname === "/health" ? json(200, { ok: true }) : json(404, { error: "not found" });
    const caseId = m[1]!;
    const token = req.headers.get("x-case-token");

    if (req.method === "GET") {
      const denied = authorize(caseId, token, false);
      if (denied) return denied;
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      const rows = listRecords.all(caseId, after, MAX_RECORDS_PER_PULL) as { seq: number; id: string; collection: string; sealed: string }[];
      const records: StoredEnvelope[] = rows.map((r) => ({ seq: r.seq, id: r.id, collection: r.collection as StoredEnvelope["collection"], sealed: JSON.parse(r.sealed) }));
      return json(200, { records, cursor: records.at(-1)?.seq ?? after });
    }

    if (req.method === "POST") {
      if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json(413, { error: "too large" });
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return json(413, { error: "too large" });
      const parsed = z.object({ records: z.array(Envelope).min(1).max(MAX_RECORDS_PER_PUSH) }).safeParse(JSON.parse(text || "null"));
      if (!parsed.success) return json(400, { error: "invalid records" });
      db.exec("BEGIN IMMEDIATE");
      try {
        const denied = authorize(caseId, token, true);
        if (denied) {
          db.exec("ROLLBACK");
          return denied;
        }
        for (const r of parsed.data.records) addRecord.run(caseId, r.id, r.collection, JSON.stringify(r.sealed));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return json(200, { cursor: (lastSeq.get(caseId) as { seq: number }).seq });
    }
    return json(405, { error: "method not allowed" });
  };
}
