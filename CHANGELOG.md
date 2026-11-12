# Changelog

## 0.3.0

- Databases have a level: a version of what replicas store and exchange, so the format can change later without guesswork. `db.level` is the database's level and `SUPPORTED_LEVELS` the levels an engine handles. Every database is at level 1, the format of 0.1.x and 0.2.0, and nothing stored or sent changes. A database or batch at a level above what the engine supports is refused with `UPGRADE_REQUIRED`.
- A sync handshake. `db.syncHello()` says what a replica is (database, instance, engine version, level, conflict policy, Unicode version), and the other replica's `db.checkPeer(hello)` checks it before any batch moves, refusing a mismatch with `SYNC_MISMATCH`, `UPGRADE_REQUIRED`, or the new `INVALID_HANDSHAKE` for a malformed hello. `checkPeer(undefined)` stands for a peer on 0.2.0 or earlier, which has no handshake. `pullFrom` and `sync` do the handshake themselves. `db.replicas()` now shows `maxLevel`, the highest level a replica supports, as far as this replica knows from handshakes. `examples/custom-transport.ts` shows the handshake over a transport of your own.
- Paging in `find`: `db.find(filter, { limit, after })` returns one page as a `DocumentSet` of at most `limit` documents (1 to 1000), and the page's `next` is the `after` for the following page. A page can hold fewer than `limit` documents and still have a `next`; only an undefined `next` means the end. Pages are positions in find order, not a snapshot, and the cursor works on any replica and after a restart, with the same filter. `find` without `limit` is unchanged.
- `StorageAdapter` has a new optional method, `documentsAfter`, for paging. An adapter without it still works: the engine then reads and sorts every candidate for each page. `SqliteAdapter` implements it with a new index, added when a file is opened. The index doesn't change the file format.
- A batch with a format later than this engine's is now refused with `UPGRADE_REQUIRED` rather than `INVALID_BATCH`.

Upgrading: replicas on 0.2.0 and 0.3.0 sync with each other both ways, and a database file used by 0.3.0 still opens in 0.2.0, so an upgrade can be rolled back. A replica on 0.2.0 has no handshake: call `checkPeer(undefined)` for it, as the demo does when a peer answers 404 to `GET /sync/hello`.

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
