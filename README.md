# CromDB

[![CI](https://github.com/skaife/cromdb/actions/workflows/ci.yml/badge.svg)](https://github.com/skaife/cromdb/actions/workflows/ci.yml)

An embeddable, replicated, offline-first document database with vector-clock conflict detection and document-level access control.

> **Status: 0.x, early but functional.**
>
> What works: documents with access control, queries, replicas that
> sync with each other, and conflicts that are detected, kept, and
> resolved by people or apps rather than silently merged.
>
> Not yet: retiring a lost replica, detecting stale replicas, purging
> deleted documents, backup and restore, and a network transport.
> Until those exist, don't rely on CromDB for data you can't afford
> to lose. The API may change before 1.0.
>
> Next: replica trust, then stale replicas and purge, then backup.

## What it is

CromDB is designed to be a database you embed in your application, not a separate server. It will store schemaless JSON documents, using SQLite underneath.

Each copy of a database (a replica) will be editable on its own, including while offline. Replicas will then sync with each other.

## Design highlights

These describe the design. Most of it is built; the items listed under "Not yet" above are still to come.

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
