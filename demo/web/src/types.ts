// What the replicas' /api answers hold. Written out here, not imported from
// the server: the page knows the replicas only through HTTP.

export type VectorClock = Record<string, number>;

export interface Info {
  name: string;
  person: string;
  service: string;
  port: number;
  pid: number;
  dataFile: string;
  databaseId: string;
  instanceId: string;
  online: boolean;
  peers: { name: string; url: string }[];
}

export interface Note {
  id: string;
  content: { title: string; text: string };
  deleted: boolean;
  inConflict: boolean;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  updatedOn: string;
  vectorClock: VectorClock;
}

export interface ConflictVersion {
  index: number;
  id: string;
  content: { title?: string; text?: string };
  isPrimary: boolean;
  authorized: boolean;
  deleted: boolean;
  updatedBy: string;
  updatedAt: string;
  updatedOn: string;
  vectorClock: VectorClock;
}

export type ConflictAnswer =
  | { inConflict: false }
  | { inConflict: true; primaryId: string; snapshot: string; versions: ConflictVersion[] };

export interface Transfer {
  applied: number;
  skipped: number;
  batches: number;
}

export interface SyncAnswer {
  peer: string;
  pulled: Transfer;
  pushed: Transfer;
}

/** A replica as the page's config lists it, with the URL worked out. */
export interface ReplicaRef {
  name: string;
  url: string;
}
