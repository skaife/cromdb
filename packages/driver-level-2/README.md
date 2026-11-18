# @cromdb/driver-level-2

> **Status: 0.x, private.** This package isn't published. It is the start of
> a CromDB server, which doesn't exist yet. Not for production use. Its
> shapes may change before 1.0.

The [driver](../driver/README.md) for level 2 databases, the level every
database made by cromdb 0.4.0 and later is at. It uses only cromdb's public
API.

```ts
import { createLevel2Driver } from "@cromdb/driver-level-2";

const driver = createLevel2Driver();
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
- **Level 1 is refused.** Databases made by cromdb 0.3.0 and earlier identify
  people by name. `database.open` refuses them with `NOT_SUPPORTED`
  (`details.level` 1) and writes nothing to the file.
- **Handles.** Each open database has a handle, shared by every principal
  calling on it. `database.close` waits for the calls already running on that
  handle, then closes the file.
