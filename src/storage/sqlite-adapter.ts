import Database from "better-sqlite3";
import type { ChangeEntry, DocumentEnvelope } from "../envelope.js";
import type { LiveDocumentsNarrowing, StorageAdapter } from "./adapter.js";

// Format version of the database file, stored in PRAGMA user_version.
const FORMAT_VERSION = 1;

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
  if (version !== FORMAT_VERSION) {
    throw new Error(
      `Unsupported database format version ${String(version)} in "${filename}" (expected ${FORMAT_VERSION})`,
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
  private readonly allDocumentsStatement: Database.Statement<[], BodyRow>;
  private readonly putDocumentStatement: Database.Statement<[string, string, string, number, string]>;
  private readonly appendChangeStatement: Database.Statement<[string, string]>;
  private readonly changesSinceStatement: Database.Statement<[number], ChangeRow>;
  private readonly lastSeqStatement: Database.Statement<[], unknown>;
  private readonly isEmptyStatement: Database.Statement<[], unknown>;
  private readonly getLocalStatement: Database.Statement<[string], ValueRow>;
  private readonly setLocalStatement: Database.Statement<[string, string]>;

  private constructor(db: Database.Database) {
    this.db = db;
    this.getDocumentStatement = db.prepare("SELECT body FROM documents WHERE id = ?");
    const live = "SELECT body FROM documents WHERE kind = 'document' AND deleted = 0";
    this.liveDocumentsStatement = db.prepare(live);
    this.liveChildrenStatement = db.prepare(`${live} AND parent_id = ?`);
    this.liveTopLevelStatement = db.prepare(`${live} AND parent_id = id`);
    this.allDocumentsStatement = db.prepare("SELECT body FROM documents ORDER BY id");
    this.putDocumentStatement = db.prepare(
      `INSERT INTO documents (id, parent_id, kind, deleted, body) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         parent_id = excluded.parent_id,
         kind = excluded.kind,
         deleted = excluded.deleted,
         body = excluded.body`,
    );
    this.appendChangeStatement = db.prepare("INSERT INTO change_log (doc_id, entry) VALUES (?, ?)");
    this.changesSinceStatement = db.prepare("SELECT seq, entry FROM change_log WHERE seq > ? ORDER BY seq");
    this.lastSeqStatement = db.prepare("SELECT coalesce(max(seq), 0) FROM change_log").pluck();
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

  /** Opens or creates a database file. ":memory:" opens an in-memory database. */
  static open(filename: string): SqliteAdapter {
    const db = new Database(filename);
    try {
      // Check before turning on WAL, which changes the file, so a file that
      // isn't a CromDB database is refused untouched.
      checkFormat(db, filename);

      if (!db.memory) {
        db.pragma("journal_mode = WAL");
      }

      // Checked again inside the transaction in case another connection
      // created the schema in between.
      db.transaction(() => {
        if (checkFormat(db, filename) === "new") {
          db.exec(SCHEMA);
          db.pragma(`application_id = ${APPLICATION_ID}`);
          db.pragma(`user_version = ${FORMAT_VERSION}`);
        }
      }).immediate();

      return new SqliteAdapter(db);
    } catch (error) {
      db.close();
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

  allDocuments(): DocumentEnvelope[] {
    return this.allDocumentsStatement.all().map((row) => JSON.parse(row.body) as DocumentEnvelope);
  }

  putDocument(doc: DocumentEnvelope): void {
    this.putDocumentStatement.run(doc.id, doc.parentId, doc.kind, doc.deleted ? 1 : 0, JSON.stringify(doc));
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

  getLocal(key: string): string | undefined {
    return this.getLocalStatement.get(key)?.value;
  }

  setLocal(key: string, value: string): void {
    this.setLocalStatement.run(key, value);
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
