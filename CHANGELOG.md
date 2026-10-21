# Changelog

## 0.1.1

- `syncPosition(sourceInstanceId)` returns how far a replica has applied another replica's changes, so an app can carry batches between replicas over its own transport. `pullFrom` uses it. See `examples/custom-transport.ts`.
- The source maps now include the TypeScript sources, so they work without `src/`.
- Updated a development dependency (vite, used by the test runner) to fix a security advisory. It is not part of the published package.

## 0.1.0

The first release. CromDB is early but functional: the pieces below work and are tested, and the items under "Not yet" are still to come. Until they exist, don't rely on CromDB for data you can't afford to lose. The API may change before 1.0.

### What works

- Schemaless JSON documents, with dates kept as dates.
- Sessions for named users and for anonymous use. User names compare without regard to case.
- Creating, reading, saving and deleting documents. Deletes are kept as tombstones so they replicate.
- Per-document readers and writers lists, and a database ACL of creators and admins.
- Parent and child documents, and queries: by parent, top-level or orphaned documents, conflict status, and equality on top-level fields.
- Replicas: an admin can create a new replica from an existing one, and replicas exchange changes with `pullFrom` and `sync`. Changes travel as batches of plain JSON.
- Conflicts: concurrent edits are detected with vector clocks and kept, never silently merged. Every replica shows the same version as the primary. Conflicts are resolved by choosing a version, writing new content, or deleting. Saving a document still in conflict reports `editedThroughConflict`.
- A version written by someone not in its own writers list is held as a conflict until a writer confirms it.

### Not yet

- Retiring a lost replica.
- Detecting stale replicas.
- Purging deleted documents.
- Backup and restore.
- A network transport.
- Concurrent edits of the database ACL on two replicas.
