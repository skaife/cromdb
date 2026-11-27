# @cromdb/driver

> **Status: 0.x, private.** This package isn't published. It is part of the
> CromDB server ([packages/server](../server/README.md)), which is early and
> unreleased. Not for production use. Its shapes may change before 1.0.

The interface a CromDB server is designed to use to reach a database engine,
without ever calling the engine itself. Each driver package implements it for
one engine release and database level; the one that exists so far is
[@cromdb/driver-level-4](../driver-level-4/README.md).

This package holds:

- the operations, with a TypeScript type and a JSON Schema (2020-12) for each
  input and output (`SCHEMAS`)
- the error codes and `DriverError`
- `createDriver`, which every driver wraps its handlers in
- the contract tests every driver must pass (`@cromdb/driver/contract`)

## Calling a driver

```ts
const { document } = await driver.call("documents.get", { handle, principal: { id: "alice" }, id });
```

Every call is async and takes and returns plain JSON. `callByName(op, input)`
does the same for a name known only at run time. A driver checks every input
strictly before acting on it: anything that isn't plain JSON, an unknown key at
any level, a missing field or a wrong type is refused with `INVALID_INPUT`.
User content is the exception (any JSON object), and so are the engine's own
formats passed through untouched (sync hellos, change batches, replica
tickets), which the engine checks.

Datetimes in content travel as ISO strings, with `fieldTypes` marking where
they are, as JSON Pointers: `{ "/due": "datetime" }`.

## Storage

A database's storage is a descriptor: `{ kind: "sqlite", path }` or
`{ kind: "memory" }`, among the kinds `driver.info` lists in `storage`. With
`{ kind: "sqlite", path, exclusive: true }`, the file is locked from open to
close, so no other connection or process can open it meanwhile: they get
`STORAGE_LOCKED`. `driver.info` lists the options each kind takes in
`storageOptions`, such as `{ sqlite: ["exclusive"] }`, so a caller can check
for one before relying on it.

## Reading what a driver returns

A driver's outputs match its output schemas exactly, and the contract tests
hold every driver to that. A caller should still read outputs leniently:
ignore fields it doesn't know, and allow optional fields to be missing. Then a
newer driver that adds a field, or an older one without it, doesn't break the
caller.

## Errors

Every call rejects with a `DriverError`: a `code`, a `message`, and sometimes
`details` (plain JSON). Engine codes pass through unchanged (`ACCESS_DENIED`,
`STALE_DOCUMENT`, `NOT_FOUND`, `STORAGE_LOCKED`, `STALE_REPLICA` and the rest). A driver adds
`INVALID_INPUT`, `UNKNOWN_HANDLE`, `ALREADY_OPEN`, `ALREADY_EXISTS`,
`NO_DATABASE` and `INTERNAL`. An engine code this interface doesn't list yet is passed on
exactly, with `details.known` set to false, never renamed.

## Purge, compact and raise

- **purge**: `database.purge` removes tombstones older than the database's
  `purgeAfterDays` and change entries a later one superseded (admins only).
  `settings.get` and `settings.save` read and change `purgeAfterDays` (1 to
  3650 days; saving is for admins). `sync.state` says whether the replica is
  stale: a pull found it can't show it holds everything another replica
  purged. A stale replica takes no writes (`READ_ONLY`) until a pull brings it
  up to date; the pull that finds it fails with `STALE_REPLICA`.
  `replicas.list` gives `knownThrough` for each other replica.
- **compact**: `database.compact` gives the space purged rows left back to the
  storage. Calls on the handle made meanwhile wait, and calls already running
  finish first; none is refused. It takes no principal, as `database.close`
  doesn't. On SQLite it can take a while on a large file, and blocks the
  process meanwhile.
- **raise**: `database.raise` opens storage whose database is at a level in
  `driver.info`'s `raisesFrom`, raises it as the principal (an admin of it,
  and only while it has no other replicas) to `createsLevel`, and returns it
  open, so an exclusive lock is held throughout. Storage already at a level
  the driver serves opens unchanged; `raisedFrom` says which happened. Raising
  is one way: engines that only know the old level can't open it afterwards.

## Backups, recovery, retiring and space

- **backup**: `database.backup` copies the database into `target`, empty
  storage the driver opens and closes again, as a backup (admins only). A
  backup opens and reads, but takes no writes (`READ_ONLY`) and doesn't sync
  (`SYNC_MISMATCH`); `sync.state` gives `backupOf`. Memory is refused
  (`NOT_SUPPORTED`), since the backup would be lost at once. `database.adopt`
  opens a backup as a new replica, for when it is the only copy left: a new
  instance ID, the replica it was a backup of retired (`retired` names it),
  and writable. Replicas still in use don't know the new replica and refuse
  it.
- **recover**: `database.recover` compares every document version in `from`,
  another copy of the database that the driver opens and closes again, with
  this replica, and keeps each version only `from` has as a suspect (admins
  only). It writes no document. `suspects.list` and `suspects.get` read the
  pending suspects, each with a `reason` (`absent`, `concurrent` or
  `deleted`) and `current`, the version accepting needs as `ifVersion`.
  `suspects.accept` and `suspects.acceptWithContent` write a new version that
  supersedes everything this replica holds of the document, with the access
  that write needs, and it replicates. `suspects.discard` drops one for good.
  Suspects never replicate.
- **retire**: `replicas.retire` retires another replica for good (admins
  only). Every replica that learns of it through sync refuses it, and it takes
  no writes and doesn't sync once it learns. `replicas.list` gives each
  replica's `status`, `active` or `retired`, and `introducedBy`.
- **space**: `database.space` gives the storage's `totalBytes` and
  `freeBytes`, the space `database.compact` would give back. Like compact, it
  takes no principal.

`sync.state` also says whether the replica is a backup (`backupOf`), went back
(`rewound`: it was restored or copied, and a sync caught it) or is retired
(`retired`). Those three are permanent: such a replica reads, but takes no
writes and doesn't sync.

## Capabilities and versions

`driver.info` gives the interface version (0 for all of 0.x) and the
driver's capabilities: `documents`, `conflicts`, `sync`, `acl`, `replicas`,
`tickets`, `purge`, `compact`, `raise`, `backup`, `recover`, `retire` and
`space`. An operation whose capability the
driver doesn't declare, or an unknown operation, is refused with
`NOT_SUPPORTED`, which names it.

## Contract tests

A driver package runs the shared suite from its own tests:

```ts
import { describe, it } from "vitest";
import { registerContractTests } from "@cromdb/driver/contract";

registerContractTests({ describe, it }, "my driver", {
  makeDriver: () => createMyDriver(),
  freshStorage: () => ({ kind: "memory" }),
  freshFilePath: () => newTempPath(),
});
```

Checks for capabilities the driver doesn't declare are skipped, and in their
place the suite checks that each of those operations is `NOT_SUPPORTED`.
`runContractChecks` runs the same checks without a test runner.
