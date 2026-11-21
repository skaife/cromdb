import { readFileSync } from "node:fs";
import {
  createDriver,
  DriverError,
  engineError,
  INTERFACE_VERSION,
  type AclData,
  type Capability,
  type ConflictData,
  type DocumentData,
  type Driver,
  type FindFilter,
  type Handlers,
  type JsonObject,
} from "@cromdb/driver";
import {
  CromDBError,
  SUPPORTED_LEVELS,
  VERSION,
  type Acl,
  type Database,
  type Document,
  type FindFilter as EngineFindFilter,
  type ReplicaTicket,
} from "cromdb";
import { decodeContent, encodeContent, parseTimestamp } from "./codec.js";
import { Handles, LEVEL, RAISES_FROM, refuseLevel } from "./handles.js";
import { STORAGE_KINDS, STORAGE_OPTIONS } from "./storage.js";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
  dependencies: Record<string, string>;
};

/** The cromdb version this driver is pinned to, from its package.json. */
export const ENGINE_PIN = PACKAGE.dependencies["cromdb"] ?? "";

const CAPABILITIES: readonly Capability[] = ["documents", "conflicts", "sync", "acl", "replicas", "tickets", "purge", "compact", "raise"];

export interface Level4DriverOptions {
  /** The clock every database opened through the driver uses, for tests. The engine's purge counts days by it. */
  readonly now?: () => Date;
}

type Doc = Document<Record<string, unknown>>;

async function documentData(doc: Doc): Promise<DocumentData> {
  const { content, fieldTypes } = encodeContent(doc.content);
  const access = await doc.myAccess();
  return {
    id: doc.id,
    parentId: doc.parentId,
    version: doc.version,
    deleted: doc.deleted,
    content,
    fieldTypes,
    readers: [...doc.readers],
    writers: [...doc.writers],
    createdAt: doc.createdAt.toISOString(),
    createdBy: doc.createdBy,
    updatedAt: doc.updatedAt.toISOString(),
    updatedBy: doc.updatedBy,
    updatedOn: doc.updatedOn,
    access: { read: access.read, update: access.update, delete: access.delete },
  };
}

function aclData(acl: Acl): AclData {
  return {
    admins: [...acl.admins],
    creators: [...acl.creators],
    writers: [...acl.writers],
    readers: [...acl.readers],
    noAccess: [...acl.noAccess],
    version: acl.version,
    createdAt: acl.createdAt.toISOString(),
    createdBy: acl.createdBy,
    updatedAt: acl.updatedAt.toISOString(),
    updatedBy: acl.updatedBy,
    updatedOn: acl.updatedOn,
  };
}

/** The engine's filter: where values marked datetime in whereTypes become Dates. */
function engineFilter(filter: FindFilter | undefined): EngineFindFilter {
  if (filter === undefined) {
    return {};
  }
  const result: { -readonly [K in keyof EngineFindFilter]: EngineFindFilter[K] } = {};
  if (filter.parentId !== undefined) result.parentId = filter.parentId;
  if (filter.topLevel !== undefined) result.topLevel = filter.topLevel;
  if (filter.orphaned !== undefined) result.orphaned = filter.orphaned;
  if (filter.inConflict !== undefined) result.inConflict = filter.inConflict;
  if (filter.where !== undefined || filter.whereTypes !== undefined) {
    const where = filter.where ?? {};
    const types = filter.whereTypes ?? {};
    for (const key of Object.keys(types)) {
      if (!Object.hasOwn(where, key)) {
        throw new DriverError("INVALID_INPUT", `filter.whereTypes names ${JSON.stringify(key)}, which isn't in filter.where`, {
          path: `/filter/whereTypes/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        });
      }
    }
    result.where = Object.fromEntries(
      Object.keys(where).map((key) => {
        const value = where[key] ?? null;
        if (!Object.hasOwn(types, key)) {
          return [key, value];
        }
        const date = parseTimestamp(value);
        if (date === undefined) {
          throw new DriverError("INVALID_INPUT", `filter.where.${key} is marked datetime but is not an ISO string as toISOString writes it`, {
            path: `/filter/where/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          });
        }
        return [key, date];
      }),
    );
  }
  return result;
}

/** The document, or NOT_FOUND if this principal can't get it. */
async function load(db: Database, id: string, ifVersion?: string): Promise<Doc> {
  const doc = await db.get<Record<string, unknown>>(id, ifVersion === undefined ? {} : { ifVersion });
  if (doc === undefined) {
    throw new DriverError("NOT_FOUND", `Document ${JSON.stringify(id)} not found`);
  }
  return doc;
}

/** The document's conflict at that version: STALE_DOCUMENT if it changed, or isn't in conflict any more. */
async function loadConflict(db: Database, id: string, conflictVersion: string) {
  const conflict = await (await load(db, id)).conflict({ ifVersion: conflictVersion });
  if (conflict === undefined) {
    throw new DriverError("STALE_DOCUMENT", `Document ${JSON.stringify(id)} is not in conflict`);
  }
  return conflict;
}

function lists(input: { readonly readers?: readonly string[]; readonly writers?: readonly string[] }) {
  return {
    ...(input.readers === undefined ? {} : { readers: [...input.readers] }),
    ...(input.writers === undefined ? {} : { writers: [...input.writers] }),
  };
}

function mapError(error: unknown): DriverError | undefined {
  if (error instanceof CromDBError) {
    return engineError(error.code, error.message);
  }
  // The engine throws these for arguments it doesn't accept.
  if (error instanceof TypeError || error instanceof RangeError) {
    return new DriverError("INVALID_INPUT", error.message);
  }
  return undefined;
}

/**
 * The driver for level 4 databases on the pinned cromdb release. Throws if
 * the cromdb it loaded is another version than the pin.
 */
export function createLevel4Driver(options: Level4DriverOptions = {}): Driver {
  if (VERSION !== ENGINE_PIN) {
    throw new Error(`${PACKAGE.name} is pinned to cromdb ${ENGINE_PIN} but loaded cromdb ${VERSION}`);
  }
  const handles = new Handles(options.now ?? (() => new Date()));

  const handlers: Handlers = {
    "database.create": ({ storage, principal, replicaName }) =>
      handles.create(storage, principal, replicaName === undefined ? {} : { replicaName }),
    "database.createFromTicket": async ({ storage, principal, ticket }) => {
      // A ticket for a database below level 4 is refused here, so the code
      // says why; the engine checks everything else in the ticket.
      const level = Object.hasOwn(ticket, "level") ? ticket["level"] : undefined;
      if (typeof level === "number" && level !== LEVEL && level <= SUPPORTED_LEVELS.max) {
        throw refuseLevel(level);
      }
      return handles.create(storage, principal, { replicaOf: ticket as unknown as ReplicaTicket });
    },
    "database.open": ({ storage }) => handles.open(storage),
    "database.info": async ({ handle }) => {
      const { databaseId, instanceId, level } = handles.describe(handle);
      return { databaseId, instanceId, level };
    },
    "database.close": async ({ handle }) => {
      await handles.close(handle);
      return {};
    },
    "database.raise": ({ storage, principal }) => handles.raise(storage, principal),
    "database.compact": async ({ handle }) => {
      await handles.compact(handle);
      return {};
    },
    "database.purge": ({ handle, principal }) =>
      handles.use(handle, principal, async (db) => {
        const { tombstones, entries, horizon } = await db.purge();
        return { tombstones, entries, horizon };
      }),
    "settings.get": ({ handle, principal }) =>
      handles.use(handle, principal, async (db) => ({ settings: { purgeAfterDays: (await db.getSettings()).purgeAfterDays } })),
    "settings.save": ({ handle, principal, settings }) =>
      handles.use(handle, principal, async (db) => {
        await db.saveSettings({ purgeAfterDays: settings.purgeAfterDays });
        return { settings: { purgeAfterDays: (await db.getSettings()).purgeAfterDays } };
      }),
    "sync.state": ({ handle, principal }) =>
      handles.use(handle, principal, async (db) => {
        const { stale, staleSource, purgedThrough } = await db.syncState();
        return { stale, ...(staleSource === undefined ? {} : { staleSource }), purgedThrough };
      }),

    "documents.get": ({ handle, principal, id, ifVersion }) =>
      handles.use(handle, principal, async (db) => {
        const doc = await db.get<Record<string, unknown>>(id, ifVersion === undefined ? {} : { ifVersion });
        return { document: doc === undefined ? null : await documentData(doc) };
      }),
    "documents.create": (input) =>
      handles.use(input.handle, input.principal, async (db) => {
        const content = decodeContent(input.content, input.fieldTypes);
        const doc = await db.create(content, {
          ...lists(input),
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        });
        return { document: await documentData(doc) };
      }),
    "documents.save": (input) =>
      handles.use(input.handle, input.principal, async (db) => {
        const content = decodeContent(input.content, input.fieldTypes);
        const doc = await load(db, input.id, input.ifVersion);
        doc.content = content;
        if (input.readers !== undefined) doc.readers = [...input.readers];
        if (input.writers !== undefined) doc.writers = [...input.writers];
        const { editedThroughConflict } = await doc.save();
        return { document: await documentData(doc), editedThroughConflict };
      }),
    "documents.delete": ({ handle, principal, id, ifVersion }) =>
      handles.use(handle, principal, async (db) => {
        const { editedThroughConflict } = await (await load(db, id, ifVersion)).delete();
        return { editedThroughConflict };
      }),
    "documents.find": ({ handle, principal, filter, limit, after }) =>
      handles.use(handle, principal, async (db) => {
        const set = await db.find<Record<string, unknown>>(engineFilter(filter), after === undefined ? { limit } : { limit, after });
        const documents: DocumentData[] = [];
        for await (const doc of set) {
          documents.push(await documentData(doc));
        }
        return { documents, next: set.next ?? null };
      }),
    // Never ACCESS_DENIED: the database refuses to open for a principal it
    // doesn't admit, and that principal may do nothing.
    "access.mine": async ({ handle, principal }) => {
      try {
        return await handles.use(handle, principal, async (db) => {
          const { visible, read, write, create, admin } = await db.myAccess();
          return { visible, read, write, create, admin };
        });
      } catch (error) {
        if (error instanceof CromDBError && error.code === "ACCESS_DENIED") {
          return { visible: false, read: false, write: false, create: false, admin: false };
        }
        throw error;
      }
    },

    "conflicts.get": ({ handle, principal, id, ifVersion }) =>
      handles.use(handle, principal, async (db) => {
        const doc = await db.get<Record<string, unknown>>(id);
        const conflict = doc === undefined ? undefined : await doc.conflict(ifVersion === undefined ? {} : { ifVersion });
        if (conflict === undefined) {
          return { conflict: null };
        }
        const versions: ConflictData["versions"][number][] = [];
        for (const version of conflict.versions) {
          versions.push({
            document: await documentData(version.document),
            isPrimary: version.isPrimary,
            authorized: version.authorized,
            deleted: version.deleted,
          });
        }
        return { conflict: { primaryId: conflict.primaryId, version: conflict.version, versions } };
      }),
    "conflicts.resolveWith": ({ handle, principal, id, conflictVersion, chosenId }) =>
      handles.use(handle, principal, async (db) => {
        const conflict = await loadConflict(db, id, conflictVersion);
        const chosen = conflict.versions.find((version) => version.document.id === chosenId);
        if (chosen === undefined) {
          throw new DriverError("NOT_FOUND", `No version ${JSON.stringify(chosenId)} in this conflict`);
        }
        const { editedThroughConflict } = await conflict.resolveWith(chosen.document);
        return { editedThroughConflict };
      }),
    "conflicts.resolveWithContent": (input) =>
      handles.use(input.handle, input.principal, async (db) => {
        const content = decodeContent(input.content, input.fieldTypes);
        const conflict = await loadConflict(db, input.id, input.conflictVersion);
        const { editedThroughConflict } = await conflict.resolveWithContent({ content, ...lists(input) });
        return { editedThroughConflict };
      }),
    "conflicts.resolveByDeleting": ({ handle, principal, id, conflictVersion }) =>
      handles.use(handle, principal, async (db) => {
        const { editedThroughConflict } = await (await loadConflict(db, id, conflictVersion)).resolveByDeleting();
        return { editedThroughConflict };
      }),

    "sync.hello": ({ handle, principal }) =>
      handles.use(handle, principal, async (db) => ({ hello: (await db.syncHello()) as unknown as JsonObject })),
    "sync.checkPeer": ({ handle, principal, hello }) =>
      handles.use(handle, principal, async (db) => {
        const { level } = await db.checkPeer((hello ?? undefined) as Parameters<Database["checkPeer"]>[0]);
        return { level };
      }),
    "sync.export": ({ handle, principal, since, limit }) =>
      handles.use(handle, principal, async (db) => ({
        batch: (await db.exportChanges(limit === undefined ? { since } : { since, limit })) as unknown as JsonObject,
      })),
    "sync.apply": ({ handle, principal, batch }) =>
      handles.use(handle, principal, async (db) => {
        const { applied, skipped, toSeq, hasMore } = await db.applyChanges(batch);
        return { applied, skipped, toSeq, hasMore };
      }),
    "sync.position": ({ handle, principal, sourceInstanceId }) =>
      handles.use(handle, principal, async (db) => ({ since: await db.syncPosition(sourceInstanceId) })),

    "acl.get": ({ handle, principal, ifVersion }) =>
      handles.use(handle, principal, async (db) => ({ acl: aclData(await db.getAcl(ifVersion === undefined ? {} : { ifVersion })) })),
    "acl.save": ({ handle, principal, ifVersion, admins, creators, writers, readers, noAccess }) =>
      handles.use(handle, principal, async (db) => {
        const acl = await db.getAcl({ ifVersion });
        acl.admins = [...admins];
        acl.creators = [...creators];
        acl.writers = [...writers];
        acl.readers = [...readers];
        acl.noAccess = [...noAccess];
        await acl.save();
        return { acl: aclData(acl) };
      }),
    "replicas.list": ({ handle, principal }) =>
      handles.use(handle, principal, async (db) => ({
        replicas: (await db.replicas()).map((replica) => ({
          instanceId: replica.instanceId,
          ...(replica.name === undefined ? {} : { name: replica.name }),
          createdAt: replica.createdAt.toISOString(),
          ...(replica.maxLevel === undefined ? {} : { maxLevel: replica.maxLevel }),
          ...(replica.knownThrough === undefined ? {} : { knownThrough: replica.knownThrough }),
        })),
      })),
    "replicas.register": ({ handle, principal, name }) =>
      handles.use(handle, principal, async (db) => ({
        ticket: (await db.registerReplica(name === undefined ? {} : { name })) as unknown as JsonObject,
      })),
  };

  return createDriver({
    info: {
      interface: INTERFACE_VERSION,
      driver: { name: PACKAGE.name, version: PACKAGE.version },
      engine: { name: "cromdb", version: VERSION },
      levels: { min: LEVEL, max: LEVEL },
      createsLevel: LEVEL,
      raisesFrom: RAISES_FROM,
      capabilities: CAPABILITIES,
      storage: STORAGE_KINDS,
      storageOptions: STORAGE_OPTIONS,
    },
    handlers,
    mapError,
    shutdown: () => handles.closeAll(),
  });
}
