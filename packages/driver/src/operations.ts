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
export const CAPABILITIES = ["documents", "conflicts", "sync", "acl", "replicas", "tickets"] as const;
export type Capability = (typeof CAPABILITIES)[number];

// Shapes shared by many operations.

/** Who a call is made for: the server's person ID, or its own sync principal. */
export interface Principal {
  readonly id: string;
}

/** Where a database is stored. A driver lists the kinds it handles in driver.info. */
export type Storage = { readonly kind: "sqlite"; readonly path: string } | { readonly kind: "memory" };

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
}

export interface DriverInfo {
  readonly interface: number;
  readonly driver: { readonly name: string; readonly version: string };
  readonly engine: { readonly name: string; readonly version: string };
  /** The database levels this driver serves. */
  readonly levels: { readonly min: number; readonly max: number };
  readonly createsLevel: number;
  readonly capabilities: readonly string[];
  readonly storage: readonly string[];
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
