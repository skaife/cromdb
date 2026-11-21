import Database from "better-sqlite3";
import type { ChangeEntry, DocumentEnvelope } from "../envelope.js";
import { CromDBError } from "../errors.js";
import type { LiveDocumentsNarrowing, StorageAdapter } from "./adapter.js";

// Format version of the database file, stored in PRAGMA user_version. A new
// file starts at 1. markLevel sets 2 for a database at level 2 or higher, so
// engines that don't know levels (0.3.0 and earlier) refuse the file; the
// level itself is in the database document. markBackup sets 3 for a backup,
// so engines that don't know backups (0.7.0 and earlier) refuse it, and back
// to 2 when it is adopted. All three formats have the same tables.
const FORMAT_VERSION = 1;
const LEVELS_FORMAT_VERSION = 2;
const BACKUP_FORMAT_VERSION = 3;

// Marks a file as a CromDB database, stored in PRAGMA application_id.
const APPLICATION_ID = 0x43524f4d; // "CROM" in ASCII

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('document', 'system')),
    deleted INTEGER NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS documents_parent_id ON documents (parent_id);

  CREATE TABLE IF NOT EXISTS change_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    entry TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS change_log_doc_id ON change_log (doc_id);

  CREATE TABLE IF NOT EXISTS local_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// Indexes added after format 1 was fixed. Created on every open, so files
// made by earlier versions get them too. An index doesn't change the format:
// engines that don't use it still open the file, and SQLite keeps it up to
// date on their writes as well.
const INDEXES = `
  CREATE INDEX IF NOT EXISTS documents_created ON documents (json_extract(body, '$.createdAt'), id);
`;

// better-sqlite3's default wait for a lock, restored after an exclusive open.
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** Whether an error is SQLite saying another connection holds the lock. */
function isLockError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"));
}

interface BodyRow {
  body: string;
}

interface ChangeRow {
  seq: number;
  entry: string;
}

interface ValueRow {
  value: string;
}

/**
 * Returns "new" for an empty file that needs the schema, or "current" for a
 * CromDB database in the supported format. Throws for anything else.
 */
function checkFormat(db: Database.Database, filename: string): "new" | "current" {
  const version: unknown = db.pragma("user_version", { simple: true });
  if (version === 0) {
    const objects: unknown = db.prepare("SELECT count(*) FROM sqlite_master").pluck().get();
    if (objects !== 0) {
      throw new Error(`"${filename}" is not a CromDB database (it already contains other tables)`);
    }
    // APPLICATION_ID here means an earlier open was interrupted before commit.
    const applicationId: unknown = db.pragma("application_id", { simple: true });
    if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
      throw new Error(`"${filename}" is not a CromDB database (application_id ${String(applicationId)})`);
    }
    return "new";
  }

  const applicationId: unknown = db.pragma("application_id", { simple: true });
  if (applicationId !== APPLICATION_ID) {
    throw new Error(`"${filename}" is not a CromDB database (application_id ${String(applicationId)})`);
  }
  if (version !== FORMAT_VERSION && version !== LEVELS_FORMAT_VERSION && version !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Unsupported database format version ${String(version)} in "${filename}" (expected ${FORMAT_VERSION}, ${LEVELS_FORMAT_VERSION} or ${BACKUP_FORMAT_VERSION})`,
    );
  }
  return "current";
}

export class SqliteAdapter implements StorageAdapter {
  private readonly db: Database.Database;
  private readonly getDocumentStatement: Database.Statement<[string], BodyRow>;
  private readonly liveDocumentsStatement: Database.Statement<[], BodyRow>;
  private readonly liveChildrenStatement: Database.Statement<[string], BodyRow>;
  private readonly liveTopLevelStatement: Database.Statement<[], BodyRow>;
  private readonly primaryDocumentsStatement: Database.Statement<[], BodyRow>;
  private readonly primaryChildrenStatement: Database.Statement<[string], BodyRow>;
  private readonly primaryTopLevelStatement: Database.Statement<[], BodyRow>;
  private readonly allDocumentsStatement: Database.Statement<[], BodyRow>;
  private readonly conflictRowsStatement: Database.Statement<[string, string], BodyRow>;
  private readonly documentsAfterStatements = new Map<string, Database.Statement<unknown[], BodyRow>>();
  private readonly putDocumentStatement: Database.Statement<[string, string, string, number, string]>;
  private readonly removeDocumentStatement: Database.Statement<[string]>;
  private readonly appendChangeStatement: Database.Statement<[string, string]>;
  private readonly changesSinceStatement: Database.Statement<[number], ChangeRow>;
  private readonly changesForStatement: Database.Statement<[string], ChangeRow>;
  private readonly removeChangeStatement: Database.Statement<[number]>;
  private readonly lastSeqStatement: Database.Statement<[], unknown>;
  private readonly isEmptyStatement: Database.Statement<[], unknown>;
  private readonly getLocalStatement: Database.Statement<[string], ValueRow>;
  private readonly setLocalStatement: Database.Statement<[string, string]>;

  private constructor(db: Database.Database) {
    this.db = db;
    this.getDocumentStatement = db.prepare("SELECT body FROM documents WHERE id = ?");
    const primary = "SELECT body FROM documents WHERE kind = 'document' AND json_extract(body, '$.conflictOf') IS NULL";
    this.primaryDocumentsStatement = db.prepare(primary);
    this.primaryChildrenStatement = db.prepare(`${primary} AND parent_id = ?`);
    this.primaryTopLevelStatement = db.prepare(`${primary} AND parent_id = id`);
    const live = `${primary} AND deleted = 0`;
    this.liveDocumentsStatement = db.prepare(live);
    this.liveChildrenStatement = db.prepare(`${live} AND parent_id = ?`);
    this.liveTopLevelStatement = db.prepare(`${live} AND parent_id = id`);
    this.allDocumentsStatement = db.prepare("SELECT body FROM documents ORDER BY id");
    // A conflict row's parent_id is its primary's id, so the index narrows it.
    this.conflictRowsStatement = db.prepare(
      "SELECT body FROM documents WHERE parent_id = ? AND json_extract(body, '$.conflictOf') = ? ORDER BY id",
    );
    this.putDocumentStatement = db.prepare(
      `INSERT INTO documents (id, parent_id, kind, deleted, body) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         parent_id = excluded.parent_id,
         kind = excluded.kind,
         deleted = excluded.deleted,
         body = excluded.body`,
    );
    this.removeDocumentStatement = db.prepare("DELETE FROM documents WHERE id = ?");
    this.appendChangeStatement = db.prepare("INSERT INTO change_log (doc_id, entry) VALUES (?, ?)");
    this.changesSinceStatement = db.prepare("SELECT seq, entry FROM change_log WHERE seq > ? ORDER BY seq");
    this.changesForStatement = db.prepare("SELECT seq, entry FROM change_log WHERE doc_id = ? ORDER BY seq");
    this.removeChangeStatement = db.prepare("DELETE FROM change_log WHERE seq = ?");
    // change_log uses AUTOINCREMENT, so SQLite keeps the highest number it has
    // assigned, which removing entries never lowers. max(seq) would go back
    // when the newest entries are removed.
    this.lastSeqStatement = db.prepare("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'change_log'), 0)").pluck();
    this.isEmptyStatement = db
      .prepare(
        `SELECT NOT EXISTS (SELECT 1 FROM documents)
           AND NOT EXISTS (SELECT 1 FROM change_log)
           AND NOT EXISTS (SELECT 1 FROM local_state)`,
      )
      .pluck();
    this.getLocalStatement = db.prepare("SELECT value FROM local_state WHERE key = ?");
    this.setLocalStatement = db.prepare(
      "INSERT INTO local_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
  }

  /**
   * Opens or creates a database file. ":memory:" opens an in-memory database.
   *
   * With exclusive, this connection takes the file's write lock at open and
   * keeps it until close, so no other connection or process can open the
   * file meanwhile: they get STORAGE_LOCKED. The lock is SQLite's own, so the
   * operating system releases it if the process dies; no lock file is left
   * behind. An open of a file an exclusive adapter holds fails with
   * STORAGE_LOCKED: at once with exclusive, after SQLite's usual wait of a
   * few seconds without it. SQLite's locks aren't reliable on
   * network file systems, so keep exclusive files on a local disk. The option
   * is ignored for ":memory:".
   */
  static open(filename: string, options: { exclusive?: boolean } = {}): SqliteAdapter {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("SqliteAdapter.open takes options { exclusive? }");
    }
    const exclusive = options.exclusive ?? false;
    if (typeof exclusive !== "boolean") {
      throw new TypeError(`exclusive must be a boolean, got ${typeof exclusive}`);
    }
    // timeout 0: an exclusive open fails at once rather than waiting for a
    // lock another process will keep until it closes.
    const db = new Database(filename, exclusive ? { timeout: 0 } : {});
    try {
      if (exclusive && !db.memory) {
        // Set before WAL is turned on, so WAL keeps its index in this
        // connection's memory and never makes a -shm file other processes
        // could use.
        db.pragma("locking_mode = EXCLUSIVE");
      }

      // Check before turning on WAL, which changes the file, so a file that
      // isn't a CromDB database is refused untouched.
      checkFormat(db, filename);

      if (!db.memory) {
        db.pragma("journal_mode = WAL");
      }

      // Checked again inside the transaction in case another connection
      // created the schema in between. BEGIN IMMEDIATE takes the write lock,
      // which an exclusive connection then keeps.
      db.transaction(() => {
        if (checkFormat(db, filename) === "new") {
          db.exec(SCHEMA);
          db.pragma(`application_id = ${APPLICATION_ID}`);
          db.pragma(`user_version = ${FORMAT_VERSION}`);
        }
        db.exec(INDEXES);
      }).immediate();

      if (exclusive) {
        db.pragma(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
      }
      return new SqliteAdapter(db);
    } catch (error) {
      db.close();
      if (isLockError(error)) {
        throw new CromDBError("STORAGE_LOCKED", `"${filename}" is in use by another connection or process`);
      }
      throw error;
    }
  }

  getDocument(id: string): DocumentEnvelope | undefined {
    const row = this.getDocumentStatement.get(id);
    return row === undefined ? undefined : (JSON.parse(row.body) as DocumentEnvelope);
  }

  liveDocuments(narrow?: LiveDocumentsNarrowing): DocumentEnvelope[] {
    let rows: BodyRow[];
    if (narrow === undefined) {
      rows = this.liveDocumentsStatement.all();
    } else if ("parentId" in narrow) {
      rows = this.liveChildrenStatement.all(narrow.parentId);
    } else {
      rows = this.liveTopLevelStatement.all();
    }
    return rows.map((row) => JSON.parse(row.body) as DocumentEnvelope);
  }

  primaryDocuments(narrow?: LiveDocumentsNarrowing): DocumentEnvelope[] {
    let rows: BodyRow[];
    if (narrow === undefined) {
      rows = this.primaryDocumentsStatement.all();
    } else if ("parentId" in narrow) {
      rows = this.primaryChildrenStatement.all(narrow.parentId);
    } else {
      rows = this.primaryTopLevelStatement.all();
    }
    return rows.map((row) => JSON.parse(row.body) as DocumentEnvelope);
  }

  // SQLite compares text by its UTF-8 bytes, which orders as JavaScript does
  // for createdAt and document IDs, both ASCII.
  documentsAfter(
    narrow: LiveDocumentsNarrowing | undefined,
    includeDeleted: boolean,
    after: { readonly createdAt: string; readonly id: string } | undefined,
    limit: number,
  ): DocumentEnvelope[] {
    const narrowing = narrow === undefined ? "all" : "parentId" in narrow ? "children" : "topLevel";
    const key = `${narrowing}:${includeDeleted}:${after !== undefined}`;
    let statement = this.documentsAfterStatements.get(key);
    if (statement === undefined) {
      const conditions = ["kind = 'document'", "json_extract(body, '$.conflictOf') IS NULL"];
      if (!includeDeleted) {
        conditions.push("deleted = 0");
      }
      if (narrowing === "children") {
        conditions.push("parent_id = @parentId");
      } else if (narrowing === "topLevel") {
        conditions.push("parent_id = id");
      }
      if (after !== undefined) {
        conditions.push("(json_extract(body, '$.createdAt'), id) > (@createdAt, @id)");
      }
      statement = this.db.prepare<unknown[], BodyRow>(
        `SELECT body FROM documents WHERE ${conditions.join(" AND ")}
         ORDER BY json_extract(body, '$.createdAt'), id LIMIT @limit`,
      );
      this.documentsAfterStatements.set(key, statement);
    }
    const parameters: Record<string, string | number> = { limit };
    if (narrow !== undefined && "parentId" in narrow) {
      parameters["parentId"] = narrow.parentId;
    }
    if (after !== undefined) {
      parameters["createdAt"] = after.createdAt;
      parameters["id"] = after.id;
    }
    return statement.all(parameters).map((row) => JSON.parse(row.body) as DocumentEnvelope);
  }

  allDocuments(): DocumentEnvelope[] {
    return this.allDocumentsStatement.all().map((row) => JSON.parse(row.body) as DocumentEnvelope);
  }

  conflictRows(primaryId: string): DocumentEnvelope[] {
    return this.conflictRowsStatement.all(primaryId, primaryId).map((row) => JSON.parse(row.body) as DocumentEnvelope);
  }

  putDocument(doc: DocumentEnvelope): void {
    this.putDocumentStatement.run(doc.id, doc.parentId, doc.kind, doc.deleted ? 1 : 0, JSON.stringify(doc));
  }

  removeDocument(id: string): void {
    this.removeDocumentStatement.run(id);
  }

  appendChange(entry: Omit<ChangeEntry, "seq">): number {
    const stored: Omit<ChangeEntry, "seq"> = {
      docId: entry.docId,
      vectorClock: entry.vectorClock,
      op: entry.op,
      instanceId: entry.instanceId,
      updatedBy: entry.updatedBy,
      timestamp: entry.timestamp,
      suspect: entry.suspect,
      suspectReason: entry.suspectReason,
    };
    const result = this.appendChangeStatement.run(entry.docId, JSON.stringify(stored));
    return Number(result.lastInsertRowid);
  }

  changesSince(seq: number): ChangeEntry[] {
    return this.changesSinceStatement.all(seq).map((row) => ({
      ...(JSON.parse(row.entry) as Omit<ChangeEntry, "seq">),
      seq: row.seq,
    }));
  }

  lastSeq(): number {
    return Number(this.lastSeqStatement.get());
  }

  changesFor(docId: string): ChangeEntry[] {
    return this.changesForStatement.all(docId).map((row) => ({
      ...(JSON.parse(row.entry) as Omit<ChangeEntry, "seq">),
      seq: row.seq,
    }));
  }

  changeAt(seq: number): ChangeEntry | undefined {
    const row = this.db.prepare<[number], ChangeRow>("SELECT seq, entry FROM change_log WHERE seq = ?").get(seq);
    return row === undefined ? undefined : { ...(JSON.parse(row.entry) as Omit<ChangeEntry, "seq">), seq: row.seq };
  }

  removeChanges(seqs: readonly number[]): void {
    for (const seq of seqs) {
      this.removeChangeStatement.run(seq);
    }
  }

  /** Rewrites the file without the space removed rows left (SQLite's VACUUM). Not inside a transaction. */
  compact(): void {
    if (this.db.inTransaction) {
      throw new Error("compact can't run inside a transaction");
    }
    this.db.exec("VACUUM");
  }

  getLocal(key: string): string | undefined {
    return this.getLocalStatement.get(key)?.value;
  }

  setLocal(key: string, value: string): void {
    this.setLocalStatement.run(key, value);
  }

  /** Marks the file as a backup (format 3), or as an ordinary database at level 2 or higher again (format 2). */
  markBackup(backup: boolean): void {
    this.db.pragma(`user_version = ${backup ? BACKUP_FORMAT_VERSION : LEVELS_FORMAT_VERSION}`);
  }

  /** Marks the file for a database at level 2 or higher. Never lowers the mark. */
  markLevel(level: number): void {
    if (level >= 2 && this.db.pragma("user_version", { simple: true }) === FORMAT_VERSION) {
      this.db.pragma(`user_version = ${LEVELS_FORMAT_VERSION}`);
    }
  }

  isEmpty(): boolean {
    return this.isEmptyStatement.get() === 1;
  }

  // better-sqlite3 turns a nested transaction into a savepoint, so an inner
  // failure rolls back only the inner work if the outer call catches it.
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
