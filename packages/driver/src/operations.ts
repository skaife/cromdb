import type { JsonObject, JsonPrimitive } from "./json.js";
import { SCHEMAS } from "./schemas.js";

/**
 * The interface version: 0 for the whole of 0.x, where shapes may still
 * change; 1 from 1.0. Additions are shown by capabilities, not by this number.
 */
export const INTERFACE_VERSION = 0;

/**
 * Named groups of operations a driver may support. Names are never renamed or
 * reused. Operations under "core" are in every driver.
 */
export const CAPABILITIES = ["documents", "conflicts", "sync", "acl", "replicas", "tickets", "purge", "compact", "raise", "backup", "recover", "retire", "space"] as const;
export type Capability = (typeof CAPABILITIES)[number];

// Shapes shared by many operations.

/** Who a call is made for: the server's person ID, or its own sync principal. */
export interface Principal {
  readonly id: string;
}

/**
 * Where a database is stored. A driver lists the kinds it handles in
 * driver.info, and the options it takes for each in storageOptions. With
 * exclusive, the storage is locked from open to close, so no other
 * connection or process can open it meanwhile: they get STORAGE_LOCKED.
 */
export type Storage = { readonly kind: "sqlite"; readonly path: string; readonly exclusive?: boolean } | { readonly kind: "memory" };

/** JSON Pointers into content of the fields that hold a datetime, as ISO strings. */
export type FieldTypes = Readonly<Record<string, "datetime">>;

export interface DocumentData {
  readonly id: string;
  readonly parentId: string;
  readonly version: string;
  readonly deleted: boolean;
  readonly content: JsonObject;
  readonly fieldTypes: FieldTypes;
  readonly readers: readonly string[];
  readonly writers: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly updatedOn: string;
  readonly access: { readonly read: boolean; readonly update: boolean; readonly delete: boolean };
}

export interface FindFilter {
  readonly parentId?: string;
  readonly topLevel?: boolean;
  readonly orphaned?: boolean;
  readonly inConflict?: boolean;
  readonly where?: Readonly<Record<string, JsonPrimitive>>;
  /** Which where values are datetimes, given as ISO strings. */
  readonly whereTypes?: FieldTypes;
}

export interface ConflictData {
  readonly primaryId: string;
  readonly version: string;
  readonly versions: readonly {
    readonly document: DocumentData;
    readonly isPrimary: boolean;
    readonly authorized: boolean;
    readonly deleted: boolean;
  }[];
}

/** The database ACL: a list for each access type, as in cromdb's Acl. */
export interface AclLists {
  readonly admins: readonly string[];
  readonly creators: readonly string[];
  readonly writers: readonly string[];
  readonly readers: readonly string[];
  readonly noAccess: readonly string[];
}

export interface AclData extends AclLists {
  readonly version: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly updatedOn: string;
}

export interface ReplicaData {
  readonly instanceId: string;
  readonly name?: string;
  readonly createdAt: string;
  readonly maxLevel?: number;
  /**
   * For replicas other than the one asked, at level 4 and above: how far into
   * that replica's change log the one asked is known to hold everything,
   * directly or through other replicas. 0 if nothing yet.
   */
  readonly knownThrough?: number;
  /** "retired" once an admin retired the replica, as far as the replica asked knows; otherwise "active". */
  readonly status: "active" | "retired";
  /** The replica that introduced this one: whose ticket made it, or, for an adopted backup, the replica it was a backup of. Absent for the first replica. */
  readonly introducedBy?: string;
}

/** A database's settings, as the engine keeps them. */
export interface DatabaseSettings {
  /**
   * How many days a tombstone is kept on a replica, from when that replica
   * recorded it, before database.purge may remove it. 1 to 3650.
   */
  readonly purgeAfterDays: number;
}

/** What database.purge did. */
export interface PurgeResult {
  /** Tombstones removed. */
  readonly tombstones: number;
  /** Change entries removed: the tombstones' own, and entries a later one for the same document superseded. */
  readonly entries: number;
  /** This replica's purge horizon afterwards. */
  readonly horizon: number;
}

/** From sync.state. */
export interface SyncState {
  /** A pull found this replica can't show it holds everything another one purged. It takes no writes (READ_ONLY) meanwhile. */
  readonly stale: boolean;
  /** The replica whose pull found it stale, while stale. */
  readonly staleSource?: string;
  /** This replica's own purge horizon, 0 if it has never purged. */
  readonly purgedThrough: number;
  /** For a backup (database.backup): the instance ID of the replica it is a backup of. A backup takes no writes and doesn't sync. */
  readonly backupOf?: string;
  /** A sync found this replica's change log went back: it was restored or copied. Permanent: it takes no writes and doesn't sync. */
  readonly rewound: boolean;
  /** This replica holds its own registration as retired. Permanent: it takes no writes and doesn't sync. */
  readonly retired: boolean;
}

/**
 * A version only an old copy of the database had, kept on this replica by
 * database.recover until a person accepts or discards it. Never replicated.
 */
export interface SuspectData {
  /** Identifies the suspect on this replica. Opaque: pass it back as it is. */
  readonly key: string;
  readonly documentId: string;
  /**
   * "absent": the document isn't on this replica, so accepting may bring back
   * one others deleted; "concurrent": it is here, and this version isn't
   * superseded here; "deleted": the old copy deleted it, and it is live here.
   */
  readonly reason: "absent" | "concurrent" | "deleted";
  /** The instance ID of the copy it was recovered from. */
  readonly from: string;
  readonly recoveredAt: string;
  /** The old copy's version, read-only. For a deletion, deleted is true and content is empty. */
  readonly document: DocumentData;
  /** Everything this replica holds of the document now, as one version, or null if it holds nothing. Accepting needs it as ifVersion. */
  readonly current: string | null;
}

/** What database.recover found. */
export interface RecoverResult {
  /** New suspects: versions only the old copy had, not found by an earlier recover. */
  readonly suspects: number;
  /** Versions this replica already had, or had something after. */
  readonly known: number;
  /** Versions an earlier recover already compared, left as they were. */
  readonly seen: number;
}

export interface DriverInfo {
  readonly interface: number;
  readonly driver: { readonly name: string; readonly version: string };
  readonly engine: { readonly name: string; readonly version: string };
  /** The database levels this driver serves. */
  readonly levels: { readonly min: number; readonly max: number };
  readonly createsLevel: number;
  /** The levels database.raise takes a database from, to createsLevel. Empty without "raise". */
  readonly raisesFrom: readonly number[];
  readonly capabilities: readonly string[];
  readonly storage: readonly string[];
  /** For each storage kind, the options it takes, such as "exclusive" for "sqlite". */
  readonly storageOptions: { readonly [kind in Storage["kind"]]?: readonly string[] };
}

export interface Opened {
  readonly handle: string;
  readonly databaseId: string;
  readonly instanceId: string;
  readonly level: number;
}

export interface Written {
  readonly editedThroughConflict: boolean;
}

interface OnDatabase {
  readonly handle: string;
  readonly principal: Principal;
}

/** Every operation's input and output. */
export interface Operations {
  "driver.info": { input: Record<string, never>; output: DriverInfo };
  "database.create": {
    input: { readonly storage: Storage; readonly principal: Principal; readonly replicaName?: string };
    output: Opened;
  };
  "database.createFromTicket": {
    input: { readonly storage: Storage; readonly principal: Principal; readonly ticket: JsonObject };
    output: Opened;
  };
  "database.open": { input: { readonly storage: Storage }; output: Opened };
  "database.info": {
    input: { readonly handle: string };
    output: { readonly databaseId: string; readonly instanceId: string; readonly level: number };
  };
  "database.close": { input: { readonly handle: string }; output: Record<string, never> };
  /**
   * Opens storage at a level in raisesFrom and raises it, as principal (an
   * admin), to createsLevel; storage already at a level the driver serves
   * opens unchanged. Either way the database stays open, under the handle
   * returned, so an exclusive lock is held from start to end.
   */
  "database.raise": {
    input: { readonly storage: Storage; readonly principal: Principal };
    output: Opened & { readonly raisedFrom: number };
  };
  /**
   * Gives the space purged rows left back to the storage. Calls on the handle
   * made meanwhile wait, and calls already running finish first. It works on
   * the storage, so it takes no principal, as database.close doesn't.
   */
  "database.compact": { input: { readonly handle: string }; output: Record<string, never> };
  /**
   * How big the storage is and how much of it is free space, which
   * database.compact gives back. Like compact, it takes no principal.
   */
  "database.space": { input: { readonly handle: string }; output: { readonly totalBytes: number; readonly freeBytes: number } };
  /**
   * Admin only. Copies the database into target, empty storage the driver
   * opens and closes again, as a backup: consistent, marked as a backup of
   * this replica, readable, taking no writes and no sync. ALREADY_EXISTS if
   * target holds anything; NOT_SUPPORTED for memory, where it would be lost.
   */
  "database.backup": { input: OnDatabase & { readonly target: Storage }; output: Record<string, never> };
  /**
   * Opens a backup as a new replica, for when it is the only copy left: a new
   * instance ID, the replica it was a backup of retired, and writable. By an
   * admin of it. NOT_SUPPORTED for storage that isn't a backup. Replicas still
   * in use don't know the new replica and refuse it.
   */
  "database.adopt": {
    input: { readonly storage: Storage; readonly principal: Principal };
    output: Opened & { readonly retired: string };
  };
  /**
   * Admin only. Compares every document version in from, another copy of this
   * database that the driver opens read-only and closes again, with this
   * replica, and keeps each version only from has as a suspect. Writes no
   * document. SYNC_MISMATCH if from holds another database, or a copy of this
   * replica.
   */
  "database.recover": { input: OnDatabase & { readonly from: Storage }; output: RecoverResult };
  /** Admin only. Removes old tombstones and superseded change entries. */
  "database.purge": { input: OnDatabase; output: PurgeResult };
  "settings.get": { input: OnDatabase; output: { readonly settings: DatabaseSettings } };
  /** Admin only. Two saves on two replicas before they sync: the larger purgeAfterDays wins. */
  "settings.save": {
    input: OnDatabase & { readonly settings: DatabaseSettings };
    output: { readonly settings: DatabaseSettings };
  };
  "sync.state": { input: OnDatabase; output: SyncState };
  "documents.get": {
    input: OnDatabase & { readonly id: string; readonly ifVersion?: string };
    output: { readonly document: DocumentData | null };
  };
  "documents.create": {
    input: OnDatabase & {
      readonly content: JsonObject;
      readonly fieldTypes?: FieldTypes;
      readonly readers?: readonly string[];
      readonly writers?: readonly string[];
      readonly parentId?: string;
    };
    output: { readonly document: DocumentData };
  };
  "documents.save": {
    input: OnDatabase & {
      readonly id: string;
      readonly ifVersion: string;
      readonly content: JsonObject;
      readonly fieldTypes?: FieldTypes;
      readonly readers?: readonly string[];
      readonly writers?: readonly string[];
    };
    output: { readonly document: DocumentData; readonly editedThroughConflict: boolean };
  };
  "documents.delete": { input: OnDatabase & { readonly id: string; readonly ifVersion: string }; output: Written };
  "documents.find": {
    input: OnDatabase & { readonly filter?: FindFilter; readonly limit: number; readonly after?: string };
    output: { readonly documents: readonly DocumentData[]; readonly next: string | null };
  };
  /** Never ACCESS_DENIED: a principal the database doesn't admit gets all false. */
  "access.mine": {
    input: OnDatabase;
    output: { readonly visible: boolean; readonly read: boolean; readonly write: boolean; readonly create: boolean; readonly admin: boolean };
  };
  "conflicts.get": {
    input: OnDatabase & { readonly id: string; readonly ifVersion?: string };
    output: { readonly conflict: ConflictData | null };
  };
  "conflicts.resolveWith": {
    input: OnDatabase & { readonly id: string; readonly conflictVersion: string; readonly chosenId: string };
    output: Written;
  };
  "conflicts.resolveWithContent": {
    input: OnDatabase & {
      readonly id: string;
      readonly conflictVersion: string;
      readonly content: JsonObject;
      readonly fieldTypes?: FieldTypes;
      readonly readers?: readonly string[];
      readonly writers?: readonly string[];
    };
    output: Written;
  };
  "conflicts.resolveByDeleting": {
    input: OnDatabase & { readonly id: string; readonly conflictVersion: string };
    output: Written;
  };
  "sync.hello": { input: OnDatabase; output: { readonly hello: JsonObject } };
  "sync.checkPeer": { input: OnDatabase & { readonly hello: JsonObject | null }; output: { readonly level: number } };
  "sync.export": {
    input: OnDatabase & { readonly since: number; readonly limit?: number };
    output: { readonly batch: JsonObject };
  };
  "sync.apply": {
    input: OnDatabase & { readonly batch: JsonObject };
    output: { readonly applied: number; readonly skipped: number; readonly toSeq: number; readonly hasMore: boolean };
  };
  "sync.position": { input: OnDatabase & { readonly sourceInstanceId: string }; output: { readonly since: number } };
  "acl.get": { input: OnDatabase & { readonly ifVersion?: string }; output: { readonly acl: AclData } };
  /** Replaces every list: all five are required, so none is cleared by leaving it out. */
  "acl.save": {
    input: OnDatabase & AclLists & { readonly ifVersion: string };
    output: { readonly acl: AclData };
  };
  "replicas.list": { input: OnDatabase; output: { readonly replicas: readonly ReplicaData[] } };
  "replicas.register": { input: OnDatabase & { readonly name?: string }; output: { readonly ticket: JsonObject } };
  /**
   * Admin only. Retires another replica for good: every replica that learns of
   * it through sync refuses it, and it takes no writes and no sync once it
   * learns. NOT_SUPPORTED for the replica asked; NOT_FOUND for one it holds no
   * registration of. Retiring one already retired does nothing.
   */
  "replicas.retire": { input: OnDatabase & { readonly instanceId: string }; output: Record<string, never> };
  /** Admin only. Pending suspects, ordered by key, at most limit after the key after. */
  "suspects.list": {
    input: OnDatabase & { readonly limit: number; readonly after?: string };
    output: { readonly suspects: readonly SuspectData[]; readonly next: string | null };
  };
  /** Admin only. The pending suspect with this key, or null once it is decided. */
  "suspects.get": { input: OnDatabase & { readonly key: string }; output: { readonly suspect: SuspectData | null } };
  /**
   * Writes the suspect's version as a new version of the document, which
   * supersedes everything this replica holds of it and replicates, with the
   * access a save (a create, for an absent document; a delete, for a
   * deletion) needs. ifVersion must be the suspect's current, left out only
   * when that is null (STALE_DOCUMENT otherwise). NOT_FOUND once decided.
   */
  "suspects.accept": { input: OnDatabase & { readonly key: string; readonly ifVersion?: string }; output: Written };
  /** As suspects.accept, with content a person merged. Not for a deletion. */
  "suspects.acceptWithContent": {
    input: OnDatabase & {
      readonly key: string;
      readonly ifVersion?: string;
      readonly content: JsonObject;
      readonly fieldTypes?: FieldTypes;
      readonly readers?: readonly string[];
      readonly writers?: readonly string[];
    };
    output: Written;
  };
  /** Admin only. Drops the suspect: nothing is written, and recovering again never offers it. */
  "suspects.discard": { input: OnDatabase & { readonly key: string }; output: Record<string, never> };
}

export type OperationName = keyof Operations;
export type Input<Op extends OperationName> = Operations[Op]["input"];
export type Output<Op extends OperationName> = Operations[Op]["output"];

/** The capability each operation needs, or "core" for every driver. */
export const OPERATION_CAPABILITY = {
  "driver.info": "core",
  "database.create": "core",
  "database.createFromTicket": "tickets",
  "database.open": "core",
  "database.info": "core",
  "database.close": "core",
  "database.raise": "raise",
  "database.compact": "compact",
  "database.space": "space",
  "database.backup": "backup",
  "database.adopt": "backup",
  "database.recover": "recover",
  "database.purge": "purge",
  "settings.get": "purge",
  "settings.save": "purge",
  "sync.state": "purge",
  "documents.get": "documents",
  "documents.create": "documents",
  "documents.save": "documents",
  "documents.delete": "documents",
  "documents.find": "documents",
  "access.mine": "documents",
  "conflicts.get": "conflicts",
  "conflicts.resolveWith": "conflicts",
  "conflicts.resolveWithContent": "conflicts",
  "conflicts.resolveByDeleting": "conflicts",
  "sync.hello": "sync",
  "sync.checkPeer": "sync",
  "sync.export": "sync",
  "sync.apply": "sync",
  "sync.position": "sync",
  "acl.get": "acl",
  "acl.save": "acl",
  "replicas.list": "replicas",
  "replicas.register": "tickets",
  "replicas.retire": "retire",
  "suspects.list": "recover",
  "suspects.get": "recover",
  "suspects.accept": "recover",
  "suspects.acceptWithContent": "recover",
  "suspects.discard": "recover",
} as const satisfies Record<OperationName, Capability | "core">;

export const OPERATION_NAMES: readonly OperationName[] = Object.freeze(Object.keys(OPERATION_CAPABILITY) as OperationName[]);

/** Whether name is an operation of this interface version. */
export function isOperationName(name: unknown): name is OperationName {
  return typeof name === "string" && Object.hasOwn(OPERATION_CAPABILITY, name);
}

// Every operation has schemas, and every schema an operation.
const _schemasMatch: Record<OperationName, unknown> = SCHEMAS satisfies Record<OperationName, unknown>;
const _operationsMatch: Record<keyof typeof SCHEMAS, unknown> = OPERATION_CAPABILITY;
void _schemasMatch;
void _operationsMatch;
