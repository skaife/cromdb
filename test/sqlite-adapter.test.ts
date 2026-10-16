import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { ChangeEntry, DocumentEnvelope } from "../src/envelope.js";
import { SqliteAdapter } from "../src/storage/sqlite-adapter.js";

function envelope(overrides: Partial<DocumentEnvelope> = {}): DocumentEnvelope {
  return {
    id: "doc-1",
    parentId: "doc-1",
    kind: "document",
    vectorClock: { "replica-a": 2, "replica-b": 1 },
    deleted: false,
    updatedAt: "2026-10-10T12:00:00.000Z",
    updatedBy: "alice",
    updatedOn: "replica-a",
    readers: ["alice", "bob"],
    writers: ["alice"],
    content: { title: "Hello", due: "2026-11-01T00:00:00.000Z", tags: ["a", "b"], nested: { n: 1.5, ok: true, x: null } },
    fieldTypes: { "/due": "datetime" },
    ...overrides,
  };
}

function change(overrides: Partial<Omit<ChangeEntry, "seq">> = {}): Omit<ChangeEntry, "seq"> {
  return {
    docId: "doc-1",
    vectorClock: { "replica-a": 1 },
    op: "put",
    instanceId: "replica-a",
    updatedBy: "alice",
    timestamp: "2026-10-10T12:00:00.000Z",
    suspect: false,
    suspectReason: null,
    ...overrides,
  };
}

describe("SqliteAdapter", () => {
  let adapter: SqliteAdapter;

  beforeEach(() => {
    adapter = SqliteAdapter.open(":memory:");
  });

  afterEach(() => {
    adapter.close();
  });

  describe("documents", () => {
    it("returns what was put", () => {
      const doc = envelope();
      adapter.putDocument(doc);
      expect(adapter.getDocument("doc-1")).toEqual(doc);
    });

    it("keeps optional fields", () => {
      const doc = envelope({ deleted: true, deletedAt: "2026-10-11T00:00:00.000Z", conflictOf: "doc-0" });
      adapter.putDocument(doc);
      expect(adapter.getDocument("doc-1")).toEqual(doc);
    });

    it("returns undefined for a missing id", () => {
      expect(adapter.getDocument("missing")).toBeUndefined();
    });

    it("replaces a document with the same id", () => {
      adapter.putDocument(envelope());
      const replacement = envelope({ parentId: "doc-0", kind: "system", content: { other: 1 }, fieldTypes: {} });
      adapter.putDocument(replacement);
      expect(adapter.getDocument("doc-1")).toEqual(replacement);
    });

    it("round-trips a __proto__ content key intact", () => {
      const content = JSON.parse('{"__proto__": {"x": 1}, "constructor": "c", "toString": 2}') as DocumentEnvelope["content"];
      const doc = envelope({ content, vectorClock: JSON.parse('{"__proto__": 3}') as Record<string, number> });
      adapter.putDocument(doc);

      const stored = adapter.getDocument("doc-1");
      expect(stored).toEqual(doc);
      expect(Object.hasOwn(stored?.content ?? {}, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(stored?.content)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(stored?.content, "__proto__")?.value).toEqual({ x: 1 });
      expect(Object.hasOwn(stored?.vectorClock ?? {}, "__proto__")).toBe(true);
    });
  });

  describe("change log", () => {
    it("assigns increasing seq numbers", () => {
      const first = adapter.appendChange(change());
      const second = adapter.appendChange(change({ docId: "doc-2" }));
      const third = adapter.appendChange(change({ op: "delete" }));
      expect(first).toBeGreaterThan(0);
      expect(second).toBeGreaterThan(first);
      expect(third).toBeGreaterThan(second);
    });

    it("returns entries after the given seq, in order, with seq filled in", () => {
      const entries = [
        change(),
        change({ docId: "doc-2", vectorClock: { "replica-b": 1 }, instanceId: "replica-b" }),
        change({ op: "delete", suspect: true, suspectReason: "clock went backwards" }),
      ];
      const seqs = entries.map((entry) => adapter.appendChange(entry));

      expect(adapter.changesSince(0)).toEqual(entries.map((entry, i) => ({ ...entry, seq: seqs[i] })));
      expect(adapter.changesSince(seqs[0] ?? 0)).toEqual(
        entries.slice(1).map((entry, i) => ({ ...entry, seq: seqs[i + 1] })),
      );
      expect(adapter.changesSince(seqs[2] ?? 0)).toEqual([]);
    });

    it("does not store fields beyond the change entry", () => {
      adapter.appendChange({ ...change(), seq: 999, extra: "x" } as Omit<ChangeEntry, "seq">);
      const [entry] = adapter.changesSince(0);
      expect(entry?.seq).not.toBe(999);
      expect(entry).not.toHaveProperty("extra");
    });
  });

  describe("local state", () => {
    it("sets, gets, and overwrites values", () => {
      expect(adapter.getLocal("instanceId")).toBeUndefined();
      adapter.setLocal("instanceId", "replica-a");
      expect(adapter.getLocal("instanceId")).toBe("replica-a");
      adapter.setLocal("instanceId", "replica-b");
      expect(adapter.getLocal("instanceId")).toBe("replica-b");
      adapter.setLocal("__proto__", "p");
      expect(adapter.getLocal("__proto__")).toBe("p");
    });
  });

  describe("transaction", () => {
    it("returns the function's result", () => {
      expect(adapter.transaction(() => 42)).toBe(42);
    });

    it("rolls back every write when the function throws", () => {
      adapter.setLocal("kept", "before");
      const failure = new Error("boom");

      expect(() =>
        adapter.transaction(() => {
          adapter.putDocument(envelope());
          adapter.appendChange(change());
          adapter.setLocal("kept", "after");
          throw failure;
        }),
      ).toThrow(failure);

      expect(adapter.getDocument("doc-1")).toBeUndefined();
      expect(adapter.changesSince(0)).toEqual([]);
      expect(adapter.getLocal("kept")).toBe("before");
    });

    it("commits nested transactions with the outer one", () => {
      adapter.transaction(() => {
        adapter.setLocal("outer", "1");
        adapter.transaction(() => {
          adapter.setLocal("inner", "2");
        });
      });
      expect(adapter.getLocal("outer")).toBe("1");
      expect(adapter.getLocal("inner")).toBe("2");
    });

    it("rolls back only the inner transaction when the outer one catches its error", () => {
      adapter.transaction(() => {
        adapter.setLocal("outer", "1");
        try {
          adapter.transaction(() => {
            adapter.setLocal("inner", "2");
            throw new Error("inner");
          });
        } catch {
          // The outer transaction carries on.
        }
      });
      expect(adapter.getLocal("outer")).toBe("1");
      expect(adapter.getLocal("inner")).toBeUndefined();
    });

    it("rolls back nested work when the outer transaction throws", () => {
      expect(() =>
        adapter.transaction(() => {
          adapter.transaction(() => {
            adapter.setLocal("inner", "2");
          });
          throw new Error("outer");
        }),
      ).toThrow("outer");
      expect(adapter.getLocal("inner")).toBeUndefined();
    });
  });
});

describe("SqliteAdapter with a file database", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "cromdb-test-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps data after close and reopen", () => {
    const filename = join(directory, "data.db");
    const doc = envelope();

    const first = SqliteAdapter.open(filename);
    first.putDocument(doc);
    const seq = first.appendChange(change());
    first.setLocal("instanceId", "replica-a");
    first.close();

    const second = SqliteAdapter.open(filename);
    try {
      expect(second.getDocument("doc-1")).toEqual(doc);
      expect(second.changesSince(0)).toEqual([{ ...change(), seq }]);
      expect(second.getLocal("instanceId")).toBe("replica-a");
    } finally {
      second.close();
    }
  });

  it("uses WAL and records the application id and format version", () => {
    const filename = join(directory, "data.db");
    SqliteAdapter.open(filename).close();

    const raw = new Database(filename, { readonly: true });
    try {
      expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(raw.pragma("application_id", { simple: true })).toBe(0x43524f4d);
      expect(raw.pragma("user_version", { simple: true })).toBe(1);
    } finally {
      raw.close();
    }
  });

  it("refuses a file with a different format version", () => {
    const filename = join(directory, "future.db");
    const raw = new Database(filename);
    raw.pragma("application_id = 0x43524f4d");
    raw.pragma("user_version = 2");
    raw.close();

    expect(() => SqliteAdapter.open(filename)).toThrow(/format version 2/);
  });

  it("refuses an unrelated SQLite file and leaves it unchanged", () => {
    const filename = join(directory, "other.db");
    const setup = new Database(filename);
    setup.exec("CREATE TABLE notes (body TEXT)");
    setup.close();

    expect(() => SqliteAdapter.open(filename)).toThrow(/not a CromDB database/);

    const raw = new Database(filename, { readonly: true });
    try {
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
      expect(tables).toEqual(["notes"]);
      expect(raw.pragma("journal_mode", { simple: true })).toBe("delete");
      expect(raw.pragma("application_id", { simple: true })).toBe(0);
      expect(raw.pragma("user_version", { simple: true })).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("refuses an empty file with another application id and leaves it unchanged", () => {
    const filename = join(directory, "empty-foreign.db");
    const setup = new Database(filename);
    setup.pragma("application_id = 1234");
    setup.close();

    expect(() => SqliteAdapter.open(filename)).toThrow(/not a CromDB database \(application_id 1234\)/);

    const raw = new Database(filename, { readonly: true });
    try {
      expect(raw.prepare("SELECT count(*) FROM sqlite_master").pluck().get()).toBe(0);
      expect(raw.pragma("journal_mode", { simple: true })).toBe("delete");
      expect(raw.pragma("application_id", { simple: true })).toBe(1234);
      expect(raw.pragma("user_version", { simple: true })).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("refuses a file with the right format version but a different application id", () => {
    const filename = join(directory, "foreign.db");
    const raw = new Database(filename);
    raw.pragma("application_id = 1234");
    raw.pragma("user_version = 1");
    raw.close();

    expect(() => SqliteAdapter.open(filename)).toThrow(/not a CromDB database/);
  });

  it("reopens a CromDB file", () => {
    const filename = join(directory, "data.db");
    SqliteAdapter.open(filename).close();
    SqliteAdapter.open(filename).close();
    const adapter = SqliteAdapter.open(filename);
    try {
      expect(adapter.getDocument("missing")).toBeUndefined();
    } finally {
      adapter.close();
    }
  });
});
