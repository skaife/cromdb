# @cromdb/driver-level-3

> **Status: 0.x, private.** This package isn't published. It is part of the
> CromDB server ([packages/server](../server/README.md)), which is early and
> unreleased. Not for production use. Its shapes may change before 1.0.

The [driver](../driver/README.md) for level 3 databases, the level every
database made by cromdb 0.6.0 and later is at. It uses only cromdb's public
API.

```ts
import { createLevel3Driver } from "@cromdb/driver-level-3";

const driver = createLevel3Driver();
const { handle } = await driver.call("database.open", { storage: { kind: "sqlite", path: "notes.cromdb" } });
```

- **Pinned engine.** It depends on one exact cromdb version (0.5.0) and won't
  start with another. Raising the pin is a deliberate change, made with the
  driver's tests run against the new engine.
- **Storage.** `{ kind: "sqlite", path }` for a database file, or
  `{ kind: "memory" }` for a database that lasts until it is closed.
  `database.open` never creates a database: a missing or empty file is
  `NO_DATABASE`. `database.create` refuses storage that already holds
  anything with `ALREADY_EXISTS`. A file is open under one handle at a time.
- **Levels 1 and 2 are refused.** Databases made by cromdb 0.3.0 and earlier
  (level 1) identify people by name, and those made by 0.4.0 and 0.5.0
  (level 2) have no access structure in their ACL. `database.open` refuses
  them with `NOT_SUPPORTED` (`details.level` 1 or 2) and writes nothing to
  the file; so does `database.createFromTicket` for their tickets.
- **Access.** The database's ACL has a list for each access type: admins,
  creators, writers, readers and noAccess, as in cromdb. `acl.save` takes all
  five, so none is cleared by leaving it out. Every operation for a
  principal the database doesn't admit is `ACCESS_DENIED`, except
  `access.mine`, which answers all false. `database.open` and
  `database.info` take no principal: they read the database's IDs and level
  without opening it as anyone.
- **Handles.** Each open database has a handle, shared by every principal
  calling on it. `database.close` waits for the calls already running on that
  handle, then closes the file.
