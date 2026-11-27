// JSON Schema (2020-12) for every operation's input and output. The same
// definitions check inputs at run time, check outputs in tests, and can go
// into an OpenAPI 3.1 description unchanged.
//
// Every object is closed (additionalProperties: false) except content, which
// is user data, and the engine's own formats (hello, batch, ticket), which the
// engine checks.

export type Schema = Readonly<Record<string, unknown>>;

function object(properties: Record<string, Schema>, required: readonly string[] = Object.keys(properties)): Schema {
  return { type: "object", properties, required, additionalProperties: false };
}

function nullable(schema: Schema): Schema {
  return { anyOf: [schema, { type: "null" }] };
}

const string: Schema = { type: "string" };
const boolean: Schema = { type: "boolean" };
const integer: Schema = { type: "integer" };
const count: Schema = { type: "integer", minimum: 0 };
const level: Schema = { type: "integer", minimum: 1 };
const stringList: Schema = { type: "array", items: string };
/** An ISO 8601 date and time, as Date.prototype.toISOString writes it. */
const timestamp: Schema = { type: "string" };

export const handle: Schema = { type: "string", minLength: 1 };
export const principal: Schema = object({ id: string });

export const storage: Schema = {
  type: "object",
  // Picks the branch by kind, so errors are about that branch.
  discriminator: { propertyName: "kind" },
  oneOf: [
    object({ kind: { const: "sqlite" }, path: { type: "string", minLength: 1 }, exclusive: boolean }, ["kind", "path"]),
    object({ kind: { const: "memory" } }),
  ],
};

/** User data: any JSON object. */
export const content: Schema = { type: "object" };
/** JSON Pointers into content of the fields that hold a datetime. */
export const fieldTypes: Schema = { type: "object", additionalProperties: { const: "datetime" } };
/** An engine format the driver passes through without looking inside. */
export const enginePayload: Schema = { type: "object" };

export const documentAccess: Schema = object({ read: boolean, update: boolean, delete: boolean });

export const documentData: Schema = object({
  id: string,
  parentId: string,
  version: string,
  deleted: boolean,
  content,
  fieldTypes,
  readers: stringList,
  writers: stringList,
  createdAt: timestamp,
  createdBy: string,
  updatedAt: timestamp,
  updatedBy: string,
  updatedOn: string,
  access: documentAccess,
});

export const findFilter: Schema = object(
  {
    parentId: string,
    topLevel: boolean,
    orphaned: boolean,
    inConflict: boolean,
    where: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } },
    whereTypes: fieldTypes,
  },
  [],
);

export const aclData: Schema = object({
  admins: stringList,
  creators: stringList,
  writers: stringList,
  readers: stringList,
  noAccess: stringList,
  version: string,
  createdAt: timestamp,
  createdBy: string,
  updatedAt: timestamp,
  updatedBy: string,
  updatedOn: string,
});

export const replicaData: Schema = object(
  { instanceId: string, name: string, createdAt: timestamp, maxLevel: level, knownThrough: count, status: { enum: ["active", "retired"] }, introducedBy: string },
  ["instanceId", "createdAt", "status"],
);

export const suspectData: Schema = object({
  key: string,
  documentId: string,
  reason: { enum: ["absent", "concurrent", "deleted"] },
  from: string,
  recoveredAt: timestamp,
  document: documentData,
  current: nullable(string),
});

export const conflictData: Schema = object({
  primaryId: string,
  version: string,
  versions: {
    type: "array",
    items: object({ document: documentData, isPrimary: boolean, authorized: boolean, deleted: boolean }),
  },
});

const opened: Schema = object({ handle, databaseId: string, instanceId: string, level });
const settings: Schema = object({ purgeAfterDays: { type: "integer", minimum: 1, maximum: 3650 } });
const written: Schema = object({ editedThroughConflict: boolean });
const suspectKey: Schema = { type: "string", minLength: 1 };

/** For an operation on an open database, as a principal: handle and principal plus these. */
function onDatabase(properties: Record<string, Schema>, optional: readonly string[] = []): Schema {
  const all = { handle, principal, ...properties };
  return object(
    all,
    Object.keys(all).filter((key) => !optional.includes(key)),
  );
}

export const SCHEMAS = {
  "driver.info": {
    input: object({}),
    output: object({
      interface: integer,
      driver: object({ name: string, version: string }),
      engine: object({ name: string, version: string }),
      levels: object({ min: level, max: level }),
      createsLevel: level,
      raisesFrom: { type: "array", items: level },
      capabilities: stringList,
      storage: stringList,
      storageOptions: object({ sqlite: stringList, memory: stringList }, []),
    }),
  },
  "database.create": {
    input: object({ storage, principal, replicaName: string }, ["storage", "principal"]),
    output: opened,
  },
  "database.createFromTicket": {
    input: object({ storage, principal, ticket: enginePayload }),
    output: opened,
  },
  "database.open": {
    input: object({ storage }),
    output: opened,
  },
  "database.info": {
    input: object({ handle }),
    output: object({ databaseId: string, instanceId: string, level }),
  },
  "database.close": {
    input: object({ handle }),
    output: object({}),
  },
  "database.raise": {
    input: object({ storage, principal }),
    output: object({ handle, databaseId: string, instanceId: string, level, raisedFrom: level }),
  },
  "database.compact": {
    input: object({ handle }),
    output: object({}),
  },
  "database.space": {
    input: object({ handle }),
    output: object({ totalBytes: count, freeBytes: count }),
  },
  "database.backup": {
    input: onDatabase({ target: storage }),
    output: object({}),
  },
  "database.adopt": {
    input: object({ storage, principal }),
    output: object({ handle, databaseId: string, instanceId: string, level, retired: string }),
  },
  "database.recover": {
    input: onDatabase({ from: storage }),
    output: object({ suspects: count, known: count, seen: count }),
  },
  "database.purge": {
    input: onDatabase({}),
    output: object({ tombstones: count, entries: count, horizon: count }),
  },
  "settings.get": {
    input: onDatabase({}),
    output: object({ settings }),
  },
  "settings.save": {
    input: onDatabase({ settings }),
    output: object({ settings }),
  },
  "sync.state": {
    input: onDatabase({}),
    output: object(
      { stale: boolean, staleSource: string, purgedThrough: count, backupOf: string, rewound: boolean, retired: boolean },
      ["stale", "purgedThrough", "rewound", "retired"],
    ),
  },
  "documents.get": {
    input: onDatabase({ id: string, ifVersion: string }, ["ifVersion"]),
    output: object({ document: nullable(documentData) }),
  },
  "documents.create": {
    input: onDatabase(
      { content, fieldTypes, readers: stringList, writers: stringList, parentId: string },
      ["fieldTypes", "readers", "writers", "parentId"],
    ),
    output: object({ document: documentData }),
  },
  "documents.save": {
    input: onDatabase(
      { id: string, ifVersion: string, content, fieldTypes, readers: stringList, writers: stringList },
      ["fieldTypes", "readers", "writers"],
    ),
    output: object({ document: documentData, editedThroughConflict: boolean }),
  },
  "documents.delete": {
    input: onDatabase({ id: string, ifVersion: string }),
    output: written,
  },
  "documents.find": {
    input: onDatabase(
      { filter: findFilter, limit: { type: "integer", minimum: 1, maximum: 1000 }, after: string },
      ["filter", "after"],
    ),
    output: object({ documents: { type: "array", items: documentData }, next: nullable(string) }),
  },
  "access.mine": {
    input: onDatabase({}),
    output: object({ visible: boolean, read: boolean, write: boolean, create: boolean, admin: boolean }),
  },
  "conflicts.get": {
    input: onDatabase({ id: string, ifVersion: string }, ["ifVersion"]),
    output: object({ conflict: nullable(conflictData) }),
  },
  "conflicts.resolveWith": {
    input: onDatabase({ id: string, conflictVersion: string, chosenId: string }),
    output: written,
  },
  "conflicts.resolveWithContent": {
    input: onDatabase(
      { id: string, conflictVersion: string, content, fieldTypes, readers: stringList, writers: stringList },
      ["fieldTypes", "readers", "writers"],
    ),
    output: written,
  },
  "conflicts.resolveByDeleting": {
    input: onDatabase({ id: string, conflictVersion: string }),
    output: written,
  },
  "sync.hello": {
    input: onDatabase({}),
    output: object({ hello: enginePayload }),
  },
  "sync.checkPeer": {
    input: onDatabase({ hello: nullable(enginePayload) }),
    output: object({ level }),
  },
  "sync.export": {
    input: onDatabase({ since: count, limit: { type: "integer", minimum: 1 } }, ["limit"]),
    output: object({ batch: enginePayload }),
  },
  "sync.apply": {
    input: onDatabase({ batch: enginePayload }),
    output: object({ applied: count, skipped: count, toSeq: count, hasMore: boolean }),
  },
  "sync.position": {
    input: onDatabase({ sourceInstanceId: string }),
    output: object({ since: count }),
  },
  "acl.get": {
    input: onDatabase({ ifVersion: string }, ["ifVersion"]),
    output: object({ acl: aclData }),
  },
  "acl.save": {
    input: onDatabase({ ifVersion: string, admins: stringList, creators: stringList, writers: stringList, readers: stringList, noAccess: stringList }),
    output: object({ acl: aclData }),
  },
  "replicas.list": {
    input: onDatabase({}),
    output: object({ replicas: { type: "array", items: replicaData } }),
  },
  "replicas.register": {
    input: onDatabase({ name: string }, ["name"]),
    output: object({ ticket: enginePayload }),
  },
  "replicas.retire": {
    input: onDatabase({ instanceId: string }),
    output: object({}),
  },
  "suspects.list": {
    input: onDatabase({ limit: { type: "integer", minimum: 1, maximum: 1000 }, after: string }, ["after"]),
    output: object({ suspects: { type: "array", items: suspectData }, next: nullable(string) }),
  },
  "suspects.get": {
    input: onDatabase({ key: suspectKey }),
    output: object({ suspect: nullable(suspectData) }),
  },
  "suspects.accept": {
    input: onDatabase({ key: suspectKey, ifVersion: string }, ["ifVersion"]),
    output: written,
  },
  "suspects.acceptWithContent": {
    input: onDatabase(
      { key: suspectKey, ifVersion: string, content, fieldTypes, readers: stringList, writers: stringList },
      ["ifVersion", "fieldTypes", "readers", "writers"],
    ),
    output: written,
  },
  "suspects.discard": {
    input: onDatabase({ key: suspectKey }),
    output: object({}),
  },
} as const satisfies Record<string, { input: Schema; output: Schema }>;
