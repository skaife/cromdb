# @cromdb/driver

> **Status: 0.x, private.** This package isn't published. It is the start of
> a CromDB server, which doesn't exist yet: for now only its own tests use
> it. Not for production use. Its shapes may change before 1.0.

The interface a CromDB server is designed to use to reach a database engine,
without ever calling the engine itself. Each driver package is to implement
it for one engine release and database level; there are none yet.

This package holds:

- the operations, with a TypeScript type and a JSON Schema (2020-12) for each
  input and output (`SCHEMAS`)
- the error codes and `DriverError`
- `createDriver`, which every driver wraps its handlers in

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

## Reading what a driver returns

A driver's outputs are meant to match its output schemas exactly. A caller should still read outputs leniently:
ignore fields it doesn't know, and allow optional fields to be missing. Then a
newer driver that adds a field, or an older one without it, doesn't break the
caller.

## Errors

Every call rejects with a `DriverError`: a `code`, a `message`, and sometimes
`details` (plain JSON). Engine codes pass through unchanged (`ACCESS_DENIED`,
`STALE_DOCUMENT`, `NOT_FOUND` and the rest). A driver adds `INVALID_INPUT`,
`UNKNOWN_HANDLE`, `ALREADY_OPEN`, `ALREADY_EXISTS`, `NO_DATABASE` and
`INTERNAL`. An engine code this interface doesn't list yet is passed on
exactly, with `details.known` set to false, never renamed.

## Capabilities and versions

`driver.info` gives the interface version (0 for all of 0.x) and the
driver's capabilities: `documents`, `conflicts`, `sync`, `acl`, `replicas` and
`tickets`. An operation whose capability the driver doesn't declare, or an
unknown operation, is refused with `NOT_SUPPORTED`, which names it.
