# Changelog

## 0.4.0

- Database level 2: users are identified by ID. Every database this release creates is at level 2. `Session.withId(id)` opens one as a user with that ID: 1 to 512 characters from U+0021 to U+007E (ASCII letters, digits and punctuation, no spaces), such as an account ID from a sign-in system. IDs are stored as given and compared exactly, in sessions and in readers, writers, creators and admins, so `"Alice"` and `"alice"` are two users. `"*"`, anything starting with `"["`, and `"system"` and `"anonymous"` in any case are reserved. Access works as before otherwise: `"anonymous"` admits everyone, `"*"` every signed-in user, an ID that user.
- Sessions have `kind`: `"id"`, `"named"` or `"anonymous"`.
- Databases made by 0.3.0 and earlier are at level 1 and keep working exactly as before: open them with `Session.named`, which still compares names without regard to case. They sync with replicas on 0.2.0 and 0.3.0 as before, and nothing new is written to them. There is no way yet to move a level-1 database to IDs.
- Opening with the wrong kind of session is refused with `INVALID_PRINCIPAL`, with a message saying which kind to use: `Session.named` on a new or level-2 database, and `Session.withId` on a level-1 database. An anonymous session opens either.
- Replicas sync only at the same level. A handshake or batch from a replica at a higher level is refused with `UPGRADE_REQUIRED`, one at a lower level with `SYNC_MISMATCH`, before anything is applied.
- A level-2 database sends batches in format 2, which adds `level` and `engine` to the header. A level-1 database sends format 1, as before.
- `Document.version` and `Conflict.version` include the level at level 2, so a version string from a level-2 database never equals one from a level-1 database. At level 1 they are unchanged and still match 0.2.0 and 0.3.0.
- Each replica of a level-2 database records the highest level its engine supports in its own registration, when it is first opened and again after an upgrade or rollback. `db.replicas()` shows it as `maxLevel`, so it is known without a handshake. A new replica's first open writes this, so the first sync back to the replica it came from carries one more change.
- A system document or field this engine doesn't know, in a batch, is refused with `UPGRADE_REQUIRED` rather than `INVALID_BATCH`, so a later engine's additions read as "upgrade this replica". So is a batch in a later format, whatever fields it has.
- The 0.3.0 entry below overstated how a later batch format is refused: 0.2.0 and 0.3.0 refuse format-2 batches with `INVALID_BATCH`, because they reject the new header fields before reading the format. 0.4.0 reads the format first, so later formats get `UPGRADE_REQUIRED`.
- `StorageAdapter` has a new optional method, `markLevel(level)`, called when a database at level 2 or higher is created in the adapter or copied into it. `SqliteAdapter` uses it to set the file's format version (`PRAGMA user_version`) to 2, so engines that don't know levels refuse the file. Level-1 files stay at format version 1. An adapter without the method still works.

What it breaks:

- `Session.named` can no longer create a database. An app that creates databases must use `Session.withId`.
- An app that has level-1 databases and also creates new ones handles both kinds of session until level-1 databases can be moved to IDs.
- Users of a level-1 database can't move to IDs yet.
- The README examples now use `Session.withId`.
- CromDB 0.3.0 and earlier can't open or sync a level-2 database. A level-2 SQLite file is refused by their `SqliteAdapter` with a plain `Error` ("Unsupported database format version 2"), not a `CromDBError`. A level-2 batch is refused with `INVALID_BATCH` (`The batch has unknown field "level"`); with the handshake, 0.4.0 refuses an older peer first, with `UPGRADE_REQUIRED`. Through any other adapter, 0.3.0 refuses level-2 data with `UPGRADE_REQUIRED`.
- Warning: CromDB 0.2.0 doesn't know levels. Given level-2 data through an adapter other than `SqliteAdapter`, it opens it and treats IDs as names, compared without regard to case, so its access checks would be wrong. Don't let 0.2.0 open a level-2 database through a custom adapter.

Upgrading: a level-1 database used by 0.4.0 stays at level 1 and its files stay at format version 1, so it still opens in 0.3.0 and 0.2.0, and an upgrade can be rolled back. A new replica of a level-1 database is at level 1 too.

## 0.3.0

- Databases have a level: a version of what replicas store and exchange, so the format can change later without guesswork. `db.level` is the database's level and `SUPPORTED_LEVELS` the levels an engine handles. Every database is at level 1, the format of 0.1.x and 0.2.0, and nothing stored or sent changes. A database or batch at a level above what the engine supports is refused with `UPGRADE_REQUIRED`.
- A sync handshake. `db.syncHello()` says what a replica is (database, instance, engine version, level, conflict policy, Unicode version), and the other replica's `db.checkPeer(hello)` checks it before any batch moves, refusing a mismatch with `SYNC_MISMATCH`, `UPGRADE_REQUIRED`, or the new `INVALID_HANDSHAKE` for a malformed hello. `checkPeer(undefined)` stands for a peer on 0.2.0 or earlier, which has no handshake. `pullFrom` and `sync` do the handshake themselves. `db.replicas()` now shows `maxLevel`, the highest level a replica supports, as far as this replica knows from handshakes. `examples/custom-transport.ts` shows the handshake over a transport of your own.
- Paging in `find`: `db.find(filter, { limit, after })` returns one page as a `DocumentSet` of at most `limit` documents (1 to 1000), and the page's `next` is the `after` for the following page. A page can hold fewer than `limit` documents and still have a `next`; only an undefined `next` means the end. Pages are positions in find order, not a snapshot, and the cursor works on any replica and after a restart, with the same filter. `find` without `limit` is unchanged.
- `StorageAdapter` has a new optional method, `documentsAfter`, for paging. An adapter without it still works: the engine then reads and sorts every candidate for each page. `SqliteAdapter` implements it with a new index, added when a file is opened. The index doesn't change the file format.
- A batch with a later format and no new header fields is now refused with `UPGRADE_REQUIRED` rather than `INVALID_BATCH`. One that adds header fields is still refused with `INVALID_BATCH`, as an unknown field.

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
