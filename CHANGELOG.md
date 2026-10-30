# Changelog

## 0.2.0

- Versions for callers that keep nothing between requests, such as an HTTP API using `If-Match`. Every document has `version`, an opaque string that is the same on every replica for the same version. `db.get(id, { ifVersion })` refuses with `STALE_DOCUMENT` if the document is no longer at that version, and the document it returns refuses a later save or delete if it changes in between, as before. A conflict has `version` too, covering all of its versions, and `doc.conflict({ ifVersion })` refuses with `STALE_DOCUMENT` if they have changed.
- `resolveWith`, `resolveWithContent` and `resolveByDeleting` return a `WriteResult`, as `save` and `delete` do: `editedThroughConflict` is true when versions the user can't read are left in conflict.
- Replica names: `createReplica(target, { name })` gives a new replica a display label, and `openDatabase(adapter, { replicaName })` names the first replica of a new database. Names travel with sync and needn't be unique. `db.replicas()` lists every replica this replica knows about, with its instance ID, name if any, and creation time, for anyone who can open the database.
- The `VectorClock` type is exported.
- Several sessions can have one adapter open at once, one `Database` per user. This was already the case and is now tested and documented: each sees the others' writes, ACL changes, conflicts and synced changes at once, and checks its own user's access.
- Documented that a replica accepts changes only from replicas it knows about.

Upgrading: databases made by 0.1.x open and sync with 0.2.0 unchanged, and replicas on 0.1.x and 0.2.0 sync with each other while no replica is named. Once any replica is named, every replica must run 0.2.0 or later; a 0.1.x replica refuses batches carrying a named registration (INVALID_BATCH) until upgraded.

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
