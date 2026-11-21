# Changelog

## 0.8.0

Recovery, at level 4. Nothing new is stored or sent that 0.7.0 can't read: no new level, no new batch format, and a 0.7.0 replica syncs with this one both ways.

- `db.retireReplica(instanceId)` retires another replica for good, admin only. Every replica that learns of it refuses that replica's hello and batches, as 0.7.0 already did for a retired registration, and the retired replica, once it pulls its own registration, takes no writes and doesn't sync. Refused for this replica itself (`NOT_SUPPORTED`) and for one it holds no registration of (`NOT_FOUND`). Retiring one already retired does nothing.
- Copies that went back are caught. A hello now also carries this replica's newest change entry (`tip`: its position and a hash of its document, clock and time) and, for each replica whose hellos it checked, the last eight tips they showed (`tips`). A replica that finds another replica knows more of its change log than it has, or saw a different entry at a position it has, was restored or copied: it refuses with `REWIND_DETECTED` and from then on takes no writes and doesn't sync. A replica that sees a peer's newest entry differ from one it saw at the same position refuses the peer the same way. So does a replica that receives a batch carrying a write of its own it doesn't hold, which 0.7.0 refused without marking the replica. A replica that holds more of a peer's log than the peer has refuses the peer with `REWIND_DETECTED`, at hello instead of at the first batch.
- `db.backup(target)` copies the replica into an empty storage adapter as a backup, admin only. A backup reads, but takes no writes (`READ_ONLY`) and doesn't sync (`SYNC_MISMATCH`). Opening one writes nothing. `session.openDatabase(adapter, { adopt: true })` adopts a backup when it is the only copy left: a new instance ID, the backed-up replica retired, writable. A backup of a stale replica stays stale when adopted.
- `db.recover(oldAdapter)` compares every document version on an old copy of the database with what this replica holds, and keeps each version only the old copy had as a suspect, admin only. Suspects stay on this replica and never replicate. `db.suspects()` lists them, with a reason (`"absent"`, `"concurrent"` or `"deleted"`), and `suspect.accept`, `acceptWithContent` and `discard` decide each one. Accepting writes a new version that supersedes everything this replica holds of the document, with the access that write needs. Recovering again from the same copy offers only versions it hasn't compared before.
- `db.syncState()` adds `backupOf`, `rewound` and `retired`. A backup, a rewound and a retired replica also refuse `purge` and `raiseLevel` (`READ_ONLY`).
- `StorageAdapter` has new optional methods: `putSuspect`, `getSuspect` and `suspects`, which recover needs (`NOT_SUPPORTED` without them); `markBackup`, which `SqliteAdapter` uses to give a backup file format 3, so earlier engines refuse to open it; `changeAt(seq)`; and `spaceUsage()`, which returns `{ totalBytes, freeBytes }`. `SqliteAdapter` has all of them. Its suspects live in a table made the first time recover needs it, which 0.7.0 ignores.

What it breaks:

- A replica that finds it went back is now marked rewound: it takes no writes and doesn't sync, for good, and the fix is a new replica that recovers from it. A replica restored from an old file used to keep working between syncs that happened to fail.
- `SyncState` has three more members, and `SyncHello` two more, `tip` and `tips`.
- CromDB 0.7.0 and earlier can't open a backup file. Adopt it first.

## 0.7.0

- Database level 4: purge. Every database this release creates is at level 4, which is level 3 with purge, settings and the state replicas exchange for it.
- `db.purge()` removes the tombstones this replica recorded more than `purgeAfterDays` ago, except those in a conflict, with their change entries, and removes change entries that a later entry for the same document makes unnecessary. It returns `{ tombstones, entries, horizon }`. Admin only, and it runs only when called. A tombstone's age is counted from when this replica recorded it, not from when it was written, so a deletion that arrives late still gets its full time here.
- Database settings: `db.getSettings()` returns `{ purgeAfterDays }`, 90 by default, for anyone the database admits, and `db.saveSettings({ purgeAfterDays })` changes it, admin only, 1 to 3650 days (`TypeError` otherwise). Settings are a new system document and replicate. If two admins save them on two replicas before those sync, the larger `purgeAfterDays` wins on every replica.
- Stale replicas. Each hello and batch now carries how far the sender holds each replica's changes, directly or through others (its knowledge), and how far into each replica's change log it may lack purged tombstones (its purge horizons, its own and those it took over with the knowledge of replicas it pulled from). A pull is refused with the new error code `STALE_REPLICA` when the puller can't show it holds everything below the source's purge horizons, or the source can't show it holds everything below the puller's. The check doesn't prove a deletion is missing, only that it can't be shown present; deletions above a horizon sync as usual. So a refusal may be unnecessary, but a pull it lets through can't bring back a purged document. A replica that keeps pulling within `purgeAfterDays`, directly or through others, is never refused. A replica that holds no documents yet, such as a new one from a ticket, is never refused as behind.
- A replica refused because it is behind is stale: it takes no writes (`READ_ONLY`, also for settings, the ACL and new replicas) until a pull from a replica that hasn't purged that far brings it up to date. `db.syncState()` returns `{ stale, staleSource?, purgedThrough }`. `db.replicas()` shows `knownThrough` for every replica but this one.
- `db.raiseLevel()` raises a level-3 database to level 4 while it is the database's only replica (`NOT_SUPPORTED` otherwise, and for levels 1 and 2), admin only. Every `Database` of the same storage uses the new level from its next call. Document and ACL versions change with the level.
- At level 4, concurrent versions of the settings document and of a replica's registration merge instead of stopping sync: every replica computes the same merged version. A registration stays `"retired"` if either version says so, and keeps the fields the replica writes about itself from its own latest write. Concurrent versions of the ACL and the database document still stop sync with `NOT_SUPPORTED`.
- At level 4, batches are format 3, which adds `knowledge` and `horizons`, and a hello adds `lastSeq`, `knowledge` and `horizons`. Every version of a document travels in the same batch, whatever the limit, so a replica gets a document's conflict versions together.
- `REWIND_DETECTED` from a version carrying this replica's own counter is no longer checked for a document that a replica which has purged didn't hold when the batch started: it may be a document it purged. Rewinds are still caught from a source's change log going backwards.
- `StorageAdapter` has three new optional methods: `changesFor(docId)` and `removeChanges(seqs)`, which purge needs (`NOT_SUPPORTED` without them), and `compact()`, which gives freed space back to the storage. `SqliteAdapter` has all three; its `compact()` is SQLite's `VACUUM`. The contract of `lastSeq()` now says it never decreases, even when entries are removed. `SqliteAdapter.lastSeq()` reads SQLite's own counter, which removing entries never lowers, where it used to read the highest stored entry.
- `examples/custom-transport.ts` now syncs at level 4.

Databases at levels 1, 2 and 3 keep working as before and are never purged; nothing new is written to them beyond this engine's `maxLevel` in the replica's own registration. A level-3 database syncs with replicas on 0.6.0, and their files open in either.

What it breaks:

- CromDB 0.6.0 and earlier can't open or sync a level-4 database. They refuse the file, a batch, a handshake and a ticket with `UPGRADE_REQUIRED`. Every replica of a level-4 database needs 0.7.0 or later. Raising a database with `raiseLevel` makes it level 4 too.
- `CromDBErrorCode` has one more member, `STALE_REPLICA`, so TypeScript code that maps every code (such as a `Record<CromDBErrorCode, number>`) needs an entry for it.
- `ReplicaInfo` has one more member, `knownThrough`, and `SyncHello` three more, `lastSeq`, `knowledge` and `horizons`. Code comparing `db.replicas()` between replicas should leave `knownThrough` out, as it already had to leave out `maxLevel`.
- A batch from a level-4 database can hold more documents than its `limit`, since a document's conflict versions come with it.

## 0.6.0

- Database level 3: the database ACL is an access structure, a list of users for each access type. `admins` may change the ACL, make replicas and sync. `creators` may create documents. `writers` may edit documents, and `readers` may read them. `noAccess` overrides every other list: someone in it can't even open the database. `ACCESS_TYPES` lists the types, and `Acl` has a property for each, saved together by `acl.save()`. Every database this release creates is at level 3.
- The lists are independent. Being an admin doesn't let you read or edit documents. Editing a document still needs reading it, so someone in `writers` but not `readers` can edit nothing. Someone in `creators` but not `readers` can create documents but not read them back.
- The database's lists set the most anyone may do, and each document's own readers and writers can only narrow it. `"*"` in a document means every signed-in user the ACL lets read or edit, never anyone else.
- A new database lists only the session that created it, in admins, creators, writers and readers, so nobody else can open it until an admin adds them. Opening a level-3 database needs a place in at least one list outside `noAccess`; otherwise `openDatabase` refuses with `ACCESS_DENIED`.
- Access is checked on every call, not only at open: once the ACL stops admitting a session, every call of its `Database`, and of the `Document`, `Conflict` and `Acl` objects it returned, is refused with `ACCESS_DENIED`. `db.myAccess()` never refuses: it returns `{ visible, read, write, create, admin }`, all false for a session the database doesn't admit. `visible`, `read` and `write` are new. `doc.myAccess()` now takes the database's lists into account too.
- `noAccess` holds user IDs only, not `"*"` or `"anonymous"` (`INVALID_ACCESS_LIST`). An admin can't put themselves in it (`ACCESS_DENIED`), at least one admin must stay outside it, and an admin may lock out another admin. The ACL document and replica registrations are written with the admins outside `noAccess` as their readers and writers, so a locked-out admin's ACL edit made on another replica is unauthorized when it arrives.
- A level-3 ACL must have all five lists, and no other key: a stored one that doesn't is `INVALID_DATABASE`, and one in a batch is `INVALID_BATCH`, or `UPGRADE_REQUIRED` for a key this engine doesn't know. A batch's ACL must also leave an admin outside `noAccess`.
- Sync is not limited by the readers lists: a batch holds every document, so an admin who syncs, or who makes a replica, gets every document. The README says so.
- `describeDatabase(adapter)` reads a database's ID, this replica's instance ID and its level without opening it as anyone, and writes nothing, for code that must know what a storage holds before it knows who will use it.
- `SqliteAdapter.open(file, { exclusive: true })` takes the file's lock at open and keeps it until `close`, so no other connection or process can open the file meanwhile: they get the new error code `STORAGE_LOCKED`, at once. A plain open of a file an exclusive adapter holds gets `STORAGE_LOCKED` too, after SQLite's usual wait of a few seconds. The lock is SQLite's own: the operating system releases it if the process dies, and no lock file is left. `":memory:"` ignores the option. SQLite's locks aren't reliable on network file systems.
- `examples/basic.ts` and the README's quick start now let every signed-in user in, with `acl.readers`, `acl.writers` and `acl.creators`.

Databases at levels 1 and 2 keep working exactly as before, and nothing new is written to them beyond this engine's `maxLevel` in the replica's own registration. Their ACL has only creators and admins: everyone may open them, and each document's own lists decide. Their `Acl` shows readers and writers as `["anonymous"]` and noAccess as `[]`, and `acl.save()` refuses a change to those with `NOT_SUPPORTED`. A level-2 database syncs with replicas on 0.4.0 and 0.5.0 as before, and their files open in either. There is no way yet to move a level-2 database to level 3.

What it breaks:

- A new database admits only its creator. Code that creates a database and expects other users to open it must add them to the ACL first, as the quick start now does.
- CromDB 0.5.0 and earlier can't open or sync a level-3 database. They refuse the file, a batch, a handshake and a ticket with `UPGRADE_REQUIRED`; 0.3.0 and earlier refuse the file by its format version, as for level 2. Every replica of a level-3 database needs 0.6.0 or later.
- `DatabaseAccess` has three more members, and `Acl` three more lists.
- `CromDBErrorCode` has one more member, `STORAGE_LOCKED`, so TypeScript code that maps every code (such as a `Record<CromDBErrorCode, number>`) needs an entry for it.

## 0.5.0

- Replicas on other machines. `db.registerReplica({ name })` registers a new replica of the database and returns a ticket: plain JSON holding the database document, the ACL and the registrations of this replica and the new one, to send over any transport. On the other machine, `session.openDatabase(emptyAdapter, { replicaOf: ticket })` makes the empty adapter that replica, and its first sync, with the replica that wrote the ticket, brings every document through the usual batch checks. Both are admin only. Tickets work at level 1 and level 2. `createReplica` is unchanged, for replicas made in the same process.
- A ticket is checked in full before anything is written, and a refused open leaves the adapter empty. A malformed ticket, or one that doesn't hold together (documents for another database or replica, out of place, deleted or unauthorized), is refused with the new error code `INVALID_TICKET`. A ticket whose database needs a later engine (its format, level, conflict policy or Unicode version) is refused with `UPGRADE_REQUIRED`. The adapter must be empty (`INVALID_DATABASE`), and the session must be of the kind the database's level needs and an admin in the ticket's ACL (`ACCESS_DENIED`).
- A ticket is single-use: treat it like a database file. Opening one ticket on two adapters makes two replicas with one identity, which sync detects only sometimes (`REWIND_DETECTED`). A ticket gives no access to documents by itself: filling the replica needs an admin on the replica that wrote it.
- A replica opened from a ticket knows only the replica that wrote it, so its first sync must be with that one. Until that sync has finished, the replica is behind, like any replica that hasn't synced: opened is not the same as caught up. If a sync is interrupted, the next one goes on from where it stopped.
- A ticket that is never used leaves its registration behind: a replica that never syncs, listed by `db.replicas()`, costing one small system document. There is no way yet to retire it.
- `acl.version`, an opaque string like `doc.version`, the same on every replica for the same ACL, and `db.getAcl({ ifVersion })`, which refuses with `STALE_DOCUMENT` if the ACL has changed since, for HTTP APIs using `If-Match` on the ACL.
- `examples/custom-transport.ts` now makes its second replica from a ticket sent over its stand-in transport.

Nothing stored or sent changes: no new level, no new batch format, and a replica made from a ticket looks to every other replica like one made by `createReplica`. It syncs with replicas on 0.4.0 at level 2, and with replicas on 0.2.0 and 0.3.0 at level 1, both ways, and its files open in those releases.

What it breaks: nothing at run time. `CromDBErrorCode` has one more member, `INVALID_TICKET`, so TypeScript code that maps every code (such as a `Record<CromDBErrorCode, number>`) needs an entry for it.

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
