// JSON Schema (2020-12) for the API's request and response bodies. The same
// objects check requests at run time, check responses in tests, and go into
// openapi.json under components.schemas by the names in NAMED_SCHEMAS.
//
// Every object is closed (additionalProperties: false), so a field that isn't
// documented can't reach a client unnoticed.

import { SCHEMAS } from "@cromdb/driver";
import { STATUSES } from "../directory/person.js";

export type Schema = Readonly<Record<string, unknown>>;

/** Pages of a list: how many by default, and at most. */
export const PAGE_LIMIT = { default: 50, max: 1000 };

function object(properties: Record<string, Schema>, required: readonly string[] = Object.keys(properties)): Schema {
  return { type: "object", properties, required, additionalProperties: false };
}

const string: Schema = { type: "string" };
const boolean: Schema = { type: "boolean" };
/** An ISO 8601 date and time in UTC, as Date.prototype.toISOString writes it. */
const timestamp: Schema = { type: "string", format: "date-time" };
const nullableString: Schema = { type: ["string", "null"] };

/** Every error response: a code to act on and a message for people. */
export const ErrorBody: Schema = object({
  error: object(
    {
      code: string,
      message: string,
      details: { type: "object" },
    },
    ["code", "message"],
  ),
});

export const Health: Schema = object({ status: { const: "ok" } });

/** The description of this API, as served. */
export const OpenApiDocument: Schema = { type: "object" };

/** The person logged in. */
export const Me: Schema = object({
  personId: string,
  displayName: nullableString,
  email: string,
  serverAdmin: boolean,
  /** The server's name, for the page header. */
  serverName: string,
});

/** What anyone may know of the server before logging in. */
export const About: Schema = object({ serverName: string });

/** What everyone may see of a person whose ID they hold. */
export const PersonCard: Schema = object({
  personId: string,
  displayName: nullableString,
});

/** At most this many people's cards in one request. */
export const CARDS_LIMIT = 100;

export const PersonCards: Schema = object({ people: { type: "array", items: PersonCard } });

export const Login: Schema = object({ issuer: string, subject: string, addedAt: timestamp });

/** A person in full, for server admins. */
export const Person: Schema = object({
  personId: string,
  email: string,
  displayName: nullableString,
  status: { enum: [...STATUSES] },
  statusAt: timestamp,
  /** A person ID, or "setup" or "console". */
  statusBy: string,
  serverAdmin: boolean,
  invitedBy: string,
  invitedAt: timestamp,
  logins: { type: "array", items: Login },
});

export const PeoplePage: Schema = object({
  people: { type: "array", items: Person },
  /** Pass as "after" for the next page; null on the last page. */
  next: nullableString,
});

export const ServerAdminChange: Schema = object({ serverAdmin: boolean });

export const NewInvitation: Schema = object({ email: { type: "string", minLength: 1, maxLength: 320 }, serverAdmin: boolean }, ["email"]);

// ---------------------------------------------------------------------------
// Databases and documents

/** A property's schema in a driver operation's input, so the API takes exactly what the driver does. */
function driverInput(operation: keyof typeof SCHEMAS, name: string): Schema {
  const properties = (SCHEMAS[operation].input as { properties?: Readonly<Record<string, Schema>> }).properties;
  const schema = properties !== undefined && Object.hasOwn(properties, name) ? properties[name] : undefined;
  if (schema === undefined) {
    throw new Error(`The driver's ${operation} takes no ${name}`);
  }
  return schema;
}

/** User data: any JSON object. */
export const Content: Schema = driverInput("documents.create", "content");
/** JSON Pointers into content of the fields that hold a datetime, as ISO strings. */
export const FieldTypes: Schema = driverInput("documents.create", "fieldTypes");
/** Which documents find returns. */
export const FindFilter: Schema = driverInput("documents.find", "filter");

const names: Schema = { type: "array", items: string };

/** What the person logged in may do in a database. */
export const Access: Schema = object({
  /** In any of the database's lists, and not in noAccess: they know it exists. */
  visible: boolean,
  read: boolean,
  write: boolean,
  create: boolean,
  admin: boolean,
});

export const Database: Schema = object({
  databaseId: string,
  name: string,
  createdAt: timestamp,
  /** A person ID. */
  createdBy: string,
  access: Access,
});

/** A registered database the server couldn't open. Only server admins see these. */
export const UnavailableDatabase: Schema = object({ databaseId: string, name: string, reason: string });

export const DatabaseList: Schema = object({
  databases: { type: "array", items: Database },
  /** Always empty for anyone but server admins. */
  unavailable: { type: "array", items: UnavailableDatabase },
});

export const NewDatabase: Schema = object({ name: { type: "string", minLength: 1, maxLength: 200 } });

/** For the databases list: how many replicas, and how many documents in conflict that you can read. */
export const DatabaseSummary: Schema = object({
  replicas: { type: "integer", minimum: 0 },
  conflicts: { type: "integer", minimum: 0 },
  /** Counting stopped at the cap: there may be more. */
  conflictsCapped: boolean,
});

/** How many days a deletion is kept before a purge may remove it, as the engine allows. */
const purgeAfterDays: Schema = { type: "integer", minimum: 1, maximum: 3650 };

export const DatabaseSettings: Schema = object({
  databaseId: string,
  /** The name on this server. */
  name: string,
  /** Shared by every replica; when two admins change it before their replicas sync, the larger value wins. */
  purgeAfterDays,
  level: { type: "integer" },
});

export const DatabaseSettingsChange: Schema = object({ name: { type: "string", minLength: 1, maxLength: 200 }, purgeAfterDays });

export const Replica: Schema = object(
  {
    instanceId: string,
    name: string,
    createdAt: timestamp,
    /** The replica this server holds. */
    thisCopy: boolean,
    /** For the other replicas: how far into that replica's log this copy is known to hold everything. 0 if nothing yet. */
    knownThrough: { type: "integer", minimum: 0 },
  },
  ["instanceId", "createdAt", "thisCopy"],
);

export const ReplicaList: Schema = object(
  {
    replicas: { type: "array", items: Replica },
    /** This copy can't show it holds everything another replica purged; it takes no writes until it is resynced. */
    stale: boolean,
    /** The replica whose sync found this copy stale, while stale. */
    staleSource: string,
    /** This copy's own purge horizon; 0 if it has never purged. */
    purgedThrough: { type: "integer", minimum: 0 },
  },
  ["replicas", "stale", "purgedThrough"],
);

/** The lists of a database's ACL. */
export const AclLists: Schema = object({ admins: names, creators: names, writers: names, readers: names, noAccess: names });

export const Acl: Schema = object({
  admins: names,
  creators: names,
  writers: names,
  readers: names,
  noAccess: names,
  version: string,
  createdAt: timestamp,
  createdBy: string,
  updatedAt: timestamp,
  updatedBy: string,
});

export const DocumentAccess: Schema = object({ read: boolean, update: boolean, delete: boolean });

export const Document: Schema = object({
  id: string,
  /** The document's own ID for a document with no parent. */
  parentId: string,
  version: string,
  deleted: boolean,
  content: Content,
  fieldTypes: FieldTypes,
  readers: names,
  writers: names,
  createdAt: timestamp,
  createdBy: string,
  updatedAt: timestamp,
  updatedBy: string,
  /** The instance ID of the replica it was last changed on. */
  updatedOn: string,
  /** Whether it has conflict versions to resolve. */
  inConflict: boolean,
  access: DocumentAccess,
});

export const NewDocument: Schema = object(
  { content: Content, fieldTypes: FieldTypes, readers: names, writers: names, parentId: string },
  ["content"],
);

export const DocumentChange: Schema = object({ content: Content, fieldTypes: FieldTypes, readers: names, writers: names }, ["content"]);

export const SavedDocument: Schema = object({ document: Document, editedThroughConflict: boolean });

/** What a delete or a resolve reports. */
export const Written: Schema = object({ editedThroughConflict: boolean });

export const FindRequest: Schema = object(
  {
    filter: FindFilter,
    limit: { type: "integer", minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default },
    after: { type: "string", description: "The next value of the page before" },
  },
  [],
);

export const DocumentPage: Schema = object({
  documents: { type: "array", items: Document },
  /** Pass as "after" for the next page; null on the last page. */
  next: nullableString,
});

export const ConflictVersion: Schema = object({ document: Document, isPrimary: boolean, authorized: boolean, deleted: boolean });

export const Conflict: Schema = object({
  primaryId: string,
  version: string,
  /** The versions the person may read. */
  versions: { type: "array", items: ConflictVersion },
});

/** One of three ways to resolve a conflict. */
export const Resolution: Schema = {
  description: "one of { chooseId }, { content, fieldTypes?, readers?, writers? } or { delete: true }",
  oneOf: [
    object({ chooseId: string }),
    object({ content: Content, fieldTypes: FieldTypes, readers: names, writers: names }, ["content"]),
    object({ delete: { const: true } }),
  ],
};

// ---------------------------------------------------------------------------
// The server's settings and status, for server admins

const integer: Schema = { type: "integer" };

/** Every setting but the client secret, as stored. Values are checked by the route, as "config set" checks them. */
export const ServerSettings: Schema = object({
  serverName: string,
  publicUrl: string,
  listen: string,
  tls: { oneOf: [{ type: "null" }, object({ certFile: { type: "string", minLength: 1, maxLength: 4096 }, keyFile: { type: "string", minLength: 1, maxLength: 4096 } })] },
  trustProxy: boolean,
  oidcIssuer: string,
  oidcClientId: string,
  sessionIdleMinutes: integer,
  sessionMaxDays: integer,
  serverDbPurgeAfterDays: integer,
  maintenanceHour: integer,
  /** An IANA time zone, or null for the server's own. */
  maintenanceTimeZone: nullableString,
});

export const ServerSettingsChange: Schema = object(
  {
    ...(ServerSettings["properties"] as Record<string, Schema>),
    /** Use a plain http publicUrl or oidcIssuer that leaves this machine anyway. */
    allowPlainHttp: boolean,
  },
  [...(ServerSettings["required"] as string[])],
);

export const ServerSettingsView: Schema = object({
  /** As saved: what the server uses from its next start. */
  saved: ServerSettings,
  /** As in effect now: the live settings take effect when saved, the rest at restart. */
  running: ServerSettings,
  /** The settings that take effect only at restart. */
  restartKeys: { type: "array", items: string },
  clientSecretSet: boolean,
  /** The certificate in use, when the server serves HTTPS itself: when it stops being valid (null if unreadable). */
  certificate: { oneOf: [{ type: "null" }, object({ validUntil: { type: ["string", "null"], format: "date-time" } })] },
  /** Whether Restart can be used: something starts the server again when it exits (CROMDB_RESTART_ON_EXIT=1). */
  canRestart: boolean,
  /** The server's own time zone, used when maintenanceTimeZone is null; null if unknown (then UTC). */
  serverTimeZone: nullableString,
  /** The last maintenance run, if any: when, and whether every database went well. */
  lastMaintenance: { oneOf: [{ type: "null" }, object({ at: timestamp, ok: boolean })] },
});

export const ClientSecretChange: Schema = object({ secret: { type: "string", minLength: 1, maxLength: 4096 } });

export const Restarting: Schema = object({ restarting: { const: true } });

export const MaintenanceResult: Schema = object(
  {
    databaseId: string,
    /** "the server database", "the directory", or database "<name>". */
    what: string,
    /** When its step ended. */
    at: timestamp,
    ok: boolean,
    tombstones: integer,
    entries: integer,
    compactedAt: timestamp,
    error: string,
  },
  ["databaseId", "what", "at", "ok"],
);

export const ServerStatus: Schema = object({
  serverName: string,
  publicUrl: string,
  versions: object({ server: string, driver: string, engine: string }),
  startedAt: timestamp,
  databases: object({
    available: integer,
    /** "since" is when the server tried to open it: at its start. */
    unavailable: { type: "array", items: object({ databaseId: string, name: string, reason: string, since: timestamp }) },
  }),
  maintenance: object({
    /** null before the first run. */
    lastRunAt: { type: ["string", "null"], format: "date-time" },
    /** When the next run becomes due; it starts at the hourly check after. */
    nextDueAt: timestamp,
    hour: integer,
    zone: string,
    databases: { type: "array", items: MaintenanceResult },
  }),
});

/** Names for openapi.json's components.schemas. */
export const NAMED_SCHEMAS: Readonly<Record<string, Schema>> = {
  Error: ErrorBody,
  Health,
  Me,
  About,
  PersonCard,
  PersonCards,
  Person,
  Login,
  PeoplePage,
  ServerAdminChange,
  NewInvitation,
  Access,
  Database,
  UnavailableDatabase,
  DatabaseList,
  NewDatabase,
  DatabaseSummary,
  DatabaseSettings,
  DatabaseSettingsChange,
  Replica,
  ReplicaList,
  AclLists,
  Acl,
  DocumentAccess,
  Document,
  NewDocument,
  DocumentChange,
  SavedDocument,
  Written,
  FindRequest,
  DocumentPage,
  ConflictVersion,
  Conflict,
  Resolution,
  ServerSettings,
  ServerSettingsChange,
  ServerSettingsView,
  ClientSecretChange,
  Restarting,
  MaintenanceResult,
  ServerStatus,
};

/** Schemas open on purpose: user data, which any JSON object fits. */
export const OPEN_SCHEMAS: readonly Schema[] = [Content, FieldTypes, (FindFilter["properties"] as Readonly<Record<string, Schema>>)["where"] as Schema];

/** Query parameters: each one optional, as text. */
export const peopleQuery: Record<string, Schema> = {
  q: { type: "string", maxLength: 320, description: "Text in the email or display name, any case" },
  status: { enum: [...STATUSES] },
  limit: { type: "integer", minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default },
  after: { type: "string", maxLength: 2000, description: "The next value of the page before" },
};
export const cardsQuery: Record<string, Schema> = {
  ids: { type: "string", maxLength: 10_000, description: `Person IDs, separated by commas; at most ${CARDS_LIMIT}` },
};
export const invitationsQuery: Record<string, Schema> = {
  q: peopleQuery["q"] as Schema,
  limit: peopleQuery["limit"] as Schema,
  after: peopleQuery["after"] as Schema,
};

/** The error codes the API returns, with their HTTP status. */
export const ERROR_STATUS = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  ACCESS_DENIED: 403,
  BAD_ORIGIN: 403,
  NOT_FOUND: 404,
  PERSON_EXISTS: 409,
  NOT_INVITED: 409,
  LAST_ADMIN: 409,
  READ_ONLY: 409,
  NOT_SUPERVISED: 409,
  STALE_VERSION: 412,
  TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  IF_MATCH_REQUIRED: 428,
  INTERNAL: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;
