import type { VectorClock } from "./vector-clock.js";
import type { JsonObject } from "./json.js";
import type { FieldTypes } from "./field-types.js";

export type DocumentKind = "document" | "system";

export interface DocumentEnvelope {
  readonly id: string;
  readonly parentId: string; // equals id for a top-level document
  readonly kind: DocumentKind;
  readonly vectorClock: VectorClock;
  readonly deleted: boolean;
  readonly deletedAt?: string; // ISO, only when deleted
  readonly createdAt: string; // ISO, set once at creation
  readonly createdBy: string; // principal that created it
  readonly updatedAt: string; // ISO
  readonly updatedBy: string; // principal that made the write
  readonly updatedOn: string; // instance ID of the replica that made the write
  readonly readers: readonly string[];
  readonly writers: readonly string[];
  readonly content: JsonObject; // encoded (JSON-safe) content
  readonly fieldTypes: FieldTypes;
  readonly conflictOf?: string; // set only on conflict documents
}

export type ChangeOp = "put" | "delete";

// A change entry references its document; it does not carry the content.
export interface ChangeEntry {
  readonly seq: number; // assigned by the store
  readonly docId: string;
  readonly vectorClock: VectorClock;
  readonly op: ChangeOp;
  readonly instanceId: string; // replica that made the write
  readonly updatedBy: string;
  readonly timestamp: string; // ISO
  readonly suspect: boolean;
  readonly suspectReason: string | null;
}
