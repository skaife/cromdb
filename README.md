# CromDB

An embeddable, replicated, offline-first document database with vector-clock conflict detection and document-level access control.

> **Status: early development, not ready for use.**
>
> Done so far: the project scaffold, the vector-clock module, and local document storage: field-type encoding (dates in documents), the document envelope, and the SQLite storage layer. On top of that: sessions with case-insensitive principal names; creating, reading, saving and deleting documents with vector-clock updates; per-document readers and writers checks; and queries: finding documents by parent, top-level, orphan status, and simple field equality, returned as document sets. Replication has started: an admin can create a new replica from an existing one, and a replica can pull changes from another as long as no document was edited on both. Replication works one way at a time; syncing both ways is two pulls.
> Next: conflict handling (edits made to the same document on two replicas), then replica trust (retiring replicas), then detecting stale replicas and full resync.

## What it is

CromDB is designed to be a database you embed in your application, not a separate server. It will store schemaless JSON documents, using SQLite underneath.

Each copy of a database (a replica) will be editable on its own, including while offline. Replicas will then sync with each other.

## Design highlights

These describe the planned design. So far the single-replica pieces exist (vector clocks, SQLite storage, sessions, documents, access checks, and queries) and part of replication: creating replicas and pulling changes that don't conflict. Conflict handling does not exist yet; a pull that meets a conflicting edit stops with an error.

- **Vector clocks per document.** Concurrent edits are detected instead of silently overwritten.
- **Conflicts are surfaced, not auto-merged.** Every replica deterministically picks the same interim winner. The other versions are kept as conflict documents, and the application decides how to resolve them.
- **Document-level access control.** Each document has readers and writers lists, and each write records who made it.
- **Deletes replicate as tombstones.** Replicas that have been offline too long are flagged, rather than quietly bringing deleted documents back.
- **Parent/child documents** through a `parentId` field.
- **Schema-on-read.** Stored documents are never rewritten to fit a new schema, so older documents stay exactly as they were written.
- **SQLite behind an adapter interface,** so other storage backends can be added later.

## Development

Requires Node 24.13.1 or newer.

```
git clone https://github.com/skaife/cromdb.git
cd cromdb
npm install
npm test
npm run typecheck
npm run build
```

better-sqlite3 is a native module. `npm install` uses a prebuilt binary where one exists, and otherwise needs a C++ build toolchain and Python.

## License

MIT, see [LICENSE](LICENSE).
