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

## Demo

The repository has a demo: three replicas of one database, each its own process with its own port and file, syncing over HTTP through small servers built on the public API, with a page to drive them.

Three replicas, each its own process: a note travels A to B to C and back, with no conflict.

![Scene 1: a note is created on A, synced to B and edited, synced to C and edited, then synced back to A and B.](https://raw.githubusercontent.com/skaife/cromdb/main/demo/media/scene-1.gif)

Two replicas edit the same note offline. All three detect the same conflict and agree on it without a coordinator, and resolving it on one replica settles it everywhere.

![Scene 2: B and C edit the same note offline, all three replicas show the same conflict, and resolving it on A settles it on all three.](https://raw.githubusercontent.com/skaife/cromdb/main/demo/media/scene-2.gif)

To run it from a clone:

```
npm install
npm run demo
```

Then open http://localhost:4000. It runs on this machine only, with no login. See [demo/README.md](demo/README.md).

## What it is

CromDB is a database you embed in your application, not a separate server. It stores schemaless JSON documents, using SQLite underneath.

Each copy of a database (a replica) can be edited on its own, including while offline. Replicas then sync with each other. When two replicas edit the same document, both versions are kept until someone decides between them.

Documents can have a parent through a `parentId` field. Stored documents are never rewritten to fit a new schema, so older documents stay exactly as they were written.

## Install

```
npm install cromdb
```

Requires Node 24.13.1 or newer, and is tested on Linux, Windows and macOS with Node 24. CromDB uses better-sqlite3, a native module. Prebuilt binaries cover Linux, macOS and Windows on x64 and arm64, so no build tools are needed there. On other platforms, installing needs a C++ build toolchain, Python, and `npm install-scripts approve better-sqlite3`, because npm blocks dependency install scripts by default.

## Quick start

Open a database file and a session. The first session to open a new database becomes its admin, and only admins can change who may create documents.

```ts
import { Session, SqliteAdapter } from "cromdb";

// Open (or create) a database file. The first session to open a new
// database becomes its only admin and its only creator.
const adapter = SqliteAdapter.open(file);
const alice = Session.named("alice");
const db = await alice.openDatabase(adapter);

// Let every named user create documents, not just alice.
const acl = await db.getAcl();
acl.creators = ["*"];
await acl.save();
```

Create, read, edit and find documents:

```ts
// Create a document. readers and writers default to ["*"].
const note = await db.create({ title: "Groceries", items: ["milk"], done: false });
console.log(`alice created ${note.id}`);

// Read it back, edit it in place, and save.
const loaded = await db.get<{ title: string; items: string[]; done: boolean }>(note.id);
if (loaded === undefined) {
  throw new Error("note not found");
}
loaded.content.items.push("eggs");
await loaded.save();
console.log(`items now: ${loaded.content.items.join(", ")}`);

// Another user, on the same database file.
const bob = await Session.named("bob").openDatabase(adapter);
await bob.create({ title: "Bob's list", items: [], done: false }, { readers: ["bob"], writers: ["bob"] });

// find returns only what the session can read.
const open = await db.find({ where: { done: false } });
console.log(`alice sees ${open.count} open note(s)`);
for await (const doc of await bob.find({ where: { done: false } })) {
  console.log(`bob sees: ${String(doc.content["title"])}`);
}
```

## Replication

Make a second replica, edit both, and sync:

```ts
import { Session, SqliteAdapter, sync } from "cromdb";

// The first replica, and an empty adapter for the second.
const adapterA = SqliteAdapter.open(":memory:");
const adapterB = SqliteAdapter.open(":memory:");
const a = await alice.openDatabase(adapterA);

// createReplica copies the database into the empty adapter (admin only).
await a.createReplica(adapterB);
const b = await alice.openDatabase(adapterB);
console.log(`replica ${b.instanceId} of database ${b.databaseId}`);

// Each replica can be edited on its own, including while offline.
await a.create({ city: "Lisbon" });
await b.create({ city: "Osaka" });

// sync pulls each way. Both sessions must be admins.
await sync(a, b);
```

When both replicas edit the same document before syncing, the result is a conflict. Here `task` is a document created on `a` and already synced to `b`:

```ts
// Both replicas edit the same document before syncing.
const onA = await a.get<Task>(task.id);
const onB = await b.get<Task>(task.id);
if (onA === undefined || onB === undefined) {
  throw new Error("task not found");
}
onA.content.status = "done";
await onA.save();
onB.content.status = "blocked";
await onB.save();
await sync(a, b);

// Neither edit is lost. Every replica shows the same version as the
// document (the primary) and keeps the other as a conflict version.
const inConflict = await a.find({ inConflict: true });
console.log(`documents in conflict: ${inConflict.count}`);
const current = await a.get<Task>(task.id);
const conflict = await current?.conflict();
if (current === undefined || conflict === undefined) {
  throw new Error("expected a conflict");
}
for (const version of conflict.versions) {
  console.log(`${version.isPrimary ? "primary " : "conflict"}: ${version.document.content.status}`);
}
```

Resolve it:

```ts
// Editing a document in conflict works, and says the conflict remains.
current.content.title = "Ship 0.1.0 (reviewed)";
const { editedThroughConflict } = await current.save();
console.log(`edited through conflict: ${editedThroughConflict}`);

// A person or the app decides. Here, keep "done" with the new title.
const fresh = await (await a.get<Task>(task.id))?.conflict();
await fresh?.resolveWithContent({ content: { title: "Ship 0.1.0 (reviewed)", status: "done" } });
await sync(a, b);
```

The full programs are in [examples/](examples/). `npm test` runs them.

## Concepts

### Replicas and sync

Each copy of a database is a replica, with its own storage. An admin makes a new replica with `createReplica`. Replicas are edited independently and exchange changes with `pullFrom` (one way) or `sync` (both ways), as often or as rarely as suits the app.

Changes travel as batches of plain JSON (`exportChanges` and `applyChanges`), so they can be carried over any transport. CromDB doesn't include a network transport yet, but an app can carry the batches itself. The receiver asks `syncPosition` how far it has got with the source, the source exports the changes after that, and the receiver applies them, repeating while the result's `hasMore` is true:

```ts
// The receiver says how far it has got.
const since = await target.syncPosition(source.instanceId);
const request = JSON.parse(send(JSON.stringify({ since }))) as { since: number };

// The source answers with the changes after that.
const batch = await source.exportChanges({ since: request.since });
const response: unknown = JSON.parse(send(JSON.stringify(batch)));

// The receiver applies them, and stores its new position.
const result = await target.applyChanges(response);
```

Here `send` stands in for the network. The full loop is in [examples/custom-transport.ts](examples/custom-transport.ts). `pullFrom` and `sync` do the same for two databases open in the same process.

A replica accepts changes only from replicas it knows about. A new replica can always sync with the one it was copied from, and it can sync with the others once they have learned of it, through sync with a replica that already knows it.

### Access

Each document has a readers list and a writers list. An entry is a user name, `"*"`, or `"anonymous"`: a name admits that user (names compare without regard to case), `"*"` admits every named user, and `"anonymous"` admits everyone, including sessions with no user. So the ladder is a name, then `"*"`, then `"anonymous"`.

The database has its own ACL with two lists: creators, who may create documents, and admins, who may change the ACL, create replicas, and sync. Every write records who made it. A version whose writer wasn't in its own writers list is treated as unauthorized: it is held as a conflict until a writer confirms it, rather than trusted.

One adapter can be open in several sessions at once, one `Database` per user, which is how a server serves many users from one file. Each sees the others' writes, ACL changes, conflicts and synced changes as soon as they are made, and each checks its own user's access.

### Versions

`save` refuses with `STALE_DOCUMENT` if the document has changed since it was loaded. A caller that keeps nothing between requests, such as an HTTP API using `If-Match`, gets the same check through `doc.version`: an opaque string, the same on every replica for the same version of a document. Hand it to the client, and when the edit comes back, load the document with `db.get(id, { ifVersion })`, which refuses with `STALE_DOCUMENT` if it has changed since, then edit and save it. `conflict.version` and `doc.conflict({ ifVersion })` do the same for a conflict's set of versions.

### Conflicts

Each document carries a vector clock, so replicas can tell an edit that follows another from two edits made independently. Independent edits are never silently merged or dropped. Every replica picks the same version as the primary, the one `get` and `find` return, and keeps the others as conflict versions.

A person or the app resolves the conflict: `conflict()` lists the versions, and `resolveWith`, `resolveWithContent` or `resolveByDeleting` writes one version that replaces them. `find({ inConflict: true })` lists documents waiting for a decision. Saving a document that is still in conflict works, and its result has `editedThroughConflict: true`, so the app can prompt the user to resolve it. A resolve call reports the same way: it is true when versions the user can't read are left in conflict.

## Limitations

- No way yet to retire a lost replica, or to detect a replica that has been offline too long.
- Deleted documents stay as tombstones; there is no purge yet.
- No backup and restore.
- No network transport (see Replicas and sync).
- Editing the database ACL on two replicas before they sync isn't supported yet: the sync stops with an error.
- Queries are simple: by parent, top-level or orphaned, conflict status, and equality on top-level fields.
- The API may change before 1.0.

Until the items above exist, don't rely on CromDB for data you can't afford to lose.

## API

Everything public is exported from `src/index.ts`, and the doc comments ship in the package's type declarations, so editors show them.

## Development

```
git clone https://github.com/skaife/cromdb.git
cd cromdb
npm install
npm test
npm run typecheck
npm run build
```

## License

MIT, see [LICENSE](LICENSE).
