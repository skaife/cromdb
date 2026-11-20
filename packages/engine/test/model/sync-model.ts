// A reference model of purge and staleness: replicas, change logs, knowledge,
// purge horizons, the purge itself and the two checks a pull makes, written
// as plainly as possible and independently of Database. It reuses only the
// engine's pure clock and arrangement functions (compare, merge, writerClock,
// arrange, conflictRowId), which have their own tests.
//
// It is used two ways: the properties in purge-model.test.ts run on it
// directly, many times, and purge-engine.test.ts runs the same programs on the
// engine and the model side by side and requires the same results.
//
// Positions are numbers in each replica's own change log. The engine's logs
// also hold system documents, which the model leaves out (except the settings
// document), so the numbers differ between the two; every decision compares
// positions in the same replica's log, so the decisions are the same.

import { arrange, conflictRowId, writerClock } from "../../src/conflict.js";
import { DEFAULT_POLICY, policyNamed } from "../../src/conflict-policy.js";
import type { DocumentEnvelope } from "../../src/envelope.js";
import { rulesFor } from "../../src/principals.js";
import { canonicalString, compare, merge, type VectorClock } from "../../src/vector-clock.js";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const DEFAULT_PURGE_AFTER_DAYS = 90;
export const SETTINGS_ID = "settings";
const MAX_CHECKPOINTS = 1000;

const policy = policyNamed(DEFAULT_POLICY);
const rules = rulesFor(4, "17.0");

/** Faults that can be planted in the model, to check that the properties catch them. */
export interface ModelFaults {
  /** Skip check (i): pull from a source whose purged range the puller hasn't covered. */
  skipCheckI?: boolean;
  /** Skip check (ii): take documents from a source that hasn't covered the puller's purged range. */
  skipCheckII?: boolean;
  /** Merge the source's knowledge from a batch that isn't the last of its pull. */
  mergeKnowledgeEarly?: boolean;
  /** Don't take the source's purge horizons along with its knowledge. */
  dontInheritHorizons?: boolean;
  /** Age a tombstone by its updatedAt (the deleting replica's time), not when this replica recorded it. */
  ageByUpdatedAt?: boolean;
  /** Purge a tombstone that is in a conflict. */
  purgeConflicted?: boolean;
}

interface Checkpoint {
  seq: number;
  at: number;
}

export class ModelReplica {
  readonly rows = new Map<string, DocumentEnvelope>();
  readonly log: { seq: number; id: string }[] = [];
  lastSeq = 0;
  readonly positions = new Map<string, number>();
  readonly knowledge = new Map<string, number>();
  readonly horizons = new Map<string, number>();
  closed: Checkpoint[] = [];
  open: (Checkpoint & { since: number }) | undefined;
  stale: Map<string, number> | undefined;

  constructor(readonly id: string) {}

  /** Live documents (kind "document", not deleted, not conflict rows), by ID. */
  live(): Map<string, DocumentEnvelope> {
    return new Map([...this.rows].filter(([, row]) => row.kind === "document" && row.conflictOf === undefined && !row.deleted));
  }
}

export type Outcome = "ok" | "stale" | "skipped";

/** The state of every replica's documents: what the engine's must equal. */
export function documentState(replica: ModelReplica): Map<string, string> {
  const state = new Map<string, string>();
  for (const row of replica.rows.values()) {
    if (row.kind === "document") {
      state.set(row.id, describeRow(row));
    }
  }
  return state;
}

export function describeRow(row: DocumentEnvelope): string {
  return JSON.stringify([row.conflictOf ?? null, row.deleted, Object.entries(row.vectorClock).sort()]);
}

export class Model {
  readonly replicas: ModelReplica[] = [];

  constructor(
    readonly principal: string,
    readonly faults: ModelFaults = {},
  ) {}

  // ---- the change log and its checkpoints ----

  #append(replica: ModelReplica, id: string): void {
    replica.lastSeq++;
    replica.log.push({ seq: replica.lastSeq, id });
  }

  /** Called once after an operation that appended entries, at that operation's time. */
  #note(replica: ModelReplica, now: number): void {
    const seq = replica.lastSeq;
    const open = replica.open;
    if (open === undefined) {
      replica.open = { seq, at: now, since: now };
    } else if (now - open.since >= HOUR) {
      replica.closed.push({ seq: open.seq, at: open.at });
      replica.open = { seq, at: Math.max(now, open.at), since: now };
      if (replica.closed.length > MAX_CHECKPOINTS) {
        replica.closed = replica.closed.filter((_, index) => index % 2 === 1 || index === replica.closed.length - 1);
      }
    } else {
      open.seq = seq;
      open.at = Math.max(now, open.at);
    }
  }

  #withAppends(replica: ModelReplica, now: number, body: () => void): void {
    const before = replica.lastSeq;
    body();
    if (replica.lastSeq > before) {
      this.#note(replica, now);
    }
  }

  // ---- knowledge ----

  /** How far replica is known to have everything of z's log. */
  known(replica: ModelReplica, z: string): number {
    return Math.max(replica.positions.get(z) ?? 0, replica.knowledge.get(z) ?? 0);
  }

  /** The knowledge a replica sends: every other replica it knows of. */
  knowledgeOf(replica: ModelReplica): Map<string, number> {
    const out = new Map<string, number>();
    for (const z of new Set([...replica.positions.keys(), ...replica.knowledge.keys()])) {
      if (z !== replica.id) {
        out.set(z, this.known(replica, z));
      }
    }
    return out;
  }

  hasDocuments(replica: ModelReplica): boolean {
    return [...replica.rows.values()].some((row) => row.kind === "document");
  }

  // ---- replicas ----

  /** The first replica. */
  found(id: string): ModelReplica {
    const replica = new ModelReplica(id);
    this.replicas.push(replica);
    return replica;
  }

  /** As Database.createReplica: a full copy, with the source's knowledge and horizons. */
  copy(source: ModelReplica, id: string, now: number): ModelReplica {
    const target = new ModelReplica(id);
    this.#withAppends(target, now, () => {
      for (const row of [...source.rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        target.rows.set(row.id, row);
        this.#append(target, row.id);
      }
    });
    for (const [z, k] of this.knowledgeOf(source)) {
      target.knowledge.set(z, k);
    }
    target.knowledge.set(source.id, source.lastSeq);
    for (const [z, h] of source.horizons) {
      target.horizons.set(z, h);
    }
    target.positions.set(source.id, source.lastSeq);
    source.positions.set(target.id, target.lastSeq);
    this.replicas.push(target);
    return target;
  }

  // ---- writes ----

  settingsDays(replica: ModelReplica): number {
    const row = replica.rows.get(SETTINGS_ID);
    return row === undefined ? DEFAULT_PURGE_AFTER_DAYS : (row.content["purgeAfterDays"] as number);
  }

  #stamp(replica: ModelReplica, previous: DocumentEnvelope | undefined, now: number) {
    const at = new Date(now).toISOString();
    return {
      createdAt: previous?.createdAt ?? at,
      createdBy: previous?.createdBy ?? this.principal,
      updatedAt: at,
      updatedBy: this.principal,
      updatedOn: replica.id,
    };
  }

  create(replica: ModelReplica, id: string, now: number): Outcome {
    if (replica.stale !== undefined) {
      return "skipped";
    }
    this.#withAppends(replica, now, () => {
      const row: DocumentEnvelope = {
        id,
        parentId: id,
        kind: "document",
        vectorClock: { [replica.id]: 1 },
        deleted: false,
        ...this.#stamp(replica, undefined, now),
        readers: ["*"],
        writers: ["*"],
        content: {},
        fieldTypes: {},
      };
      replica.rows.set(id, row);
      this.#append(replica, id);
    });
    return "ok";
  }

  /** Whether the engine would let a test edit or delete this document here: live, and not in a conflict. */
  editable(replica: ModelReplica, id: string): boolean {
    const row = replica.rows.get(id);
    return row !== undefined && row.kind === "document" && row.conflictOf === undefined && !row.deleted && this.#conflictRows(replica, id).length === 0;
  }

  write(replica: ModelReplica, id: string, deleted: boolean, now: number): Outcome {
    if (replica.stale !== undefined || !this.editable(replica, id)) {
      return "skipped";
    }
    const stored = replica.rows.get(id) as DocumentEnvelope;
    this.#withAppends(replica, now, () => {
      const row: DocumentEnvelope = {
        id,
        parentId: stored.parentId,
        kind: "document",
        vectorClock: writerClock(replica.id, stored.vectorClock, this.#storedClocks(replica, id)),
        deleted,
        ...(deleted ? { deletedAt: new Date(now).toISOString() } : {}),
        ...this.#stamp(replica, stored, now),
        readers: stored.readers,
        writers: stored.writers,
        content: {},
        fieldTypes: {},
      };
      replica.rows.set(id, row);
      this.#append(replica, id);
      this.#arrange(replica, id);
    });
    return "ok";
  }

  setPurgeAfterDays(replica: ModelReplica, days: number, now: number): Outcome {
    if (replica.stale !== undefined) {
      return "skipped";
    }
    const stored = replica.rows.get(SETTINGS_ID);
    this.#withAppends(replica, now, () => {
      const clock = { ...(stored?.vectorClock ?? {}) };
      clock[replica.id] = (clock[replica.id] ?? 0) + 1;
      replica.rows.set(SETTINGS_ID, {
        id: SETTINGS_ID,
        parentId: SETTINGS_ID,
        kind: "system",
        vectorClock: clock,
        deleted: false,
        ...this.#stamp(replica, stored, now),
        readers: [this.principal],
        writers: [this.principal],
        content: { purgeAfterDays: days },
        fieldTypes: {},
      });
      this.#append(replica, SETTINGS_ID);
    });
    return "ok";
  }

  // ---- arrangement, as Database does it ----

  #conflictRows(replica: ModelReplica, primaryId: string): DocumentEnvelope[] {
    return [...replica.rows.values()].filter((row) => row.conflictOf === primaryId);
  }

  #storedClocks(replica: ModelReplica, primaryId: string): VectorClock[] {
    const primary = replica.rows.get(primaryId);
    return [...(primary === undefined ? [] : [primary]), ...this.#conflictRows(replica, primaryId)].map((row) => row.vectorClock);
  }

  #arrange(replica: ModelReplica, primaryId: string, incoming?: DocumentEnvelope): void {
    const storedPrimary = replica.rows.get(primaryId);
    const storedRows = this.#conflictRows(replica, primaryId);
    const stored = storedPrimary === undefined ? storedRows : [storedPrimary, ...storedRows];
    const { primary, others } = arrange(incoming === undefined ? stored : [...stored, incoming], policy, rules);
    const parentId = storedPrimary?.parentId ?? primaryId;
    if (storedPrimary === undefined || compare(storedPrimary.vectorClock, primary.vectorClock) !== "equal") {
      const { conflictOf: _conflictOf, ...version } = primary;
      replica.rows.set(primaryId, { ...version, id: primaryId, parentId });
      this.#append(replica, primaryId);
    }
    const kept = new Set<string>();
    for (const other of others) {
      const rowId = conflictRowId(primaryId, other.vectorClock);
      kept.add(rowId);
      if (!storedRows.some((row) => row.id === rowId)) {
        replica.rows.set(rowId, { ...other, id: rowId, parentId: primaryId, conflictOf: primaryId });
        this.#append(replica, rowId);
      }
    }
    for (const row of storedRows) {
      if (!kept.has(row.id)) {
        replica.rows.delete(row.id);
      }
    }
  }

  // ---- sync ----

  /** Check (i): whether the puller has covered every purged range the source has, or holds no documents. */
  #coversHorizons(puller: ModelReplica, horizons: ReadonlyMap<string, number>): boolean {
    if (!this.hasDocuments(puller)) {
      return true;
    }
    return [...horizons].every(([z, h]) => z === puller.id || this.known(puller, z) >= h);
  }

  #clearStaleIfCovered(replica: ModelReplica): void {
    if (replica.stale !== undefined && [...replica.stale].every(([z, h]) => z === replica.id || this.known(replica, z) >= h)) {
      replica.stale = undefined;
    }
  }

  /**
   * One batch of puller.pullFrom(source): at most limit documents, as
   * exportChanges chooses them. With no limit, the whole pull in one batch.
   */
  pull(puller: ModelReplica, source: ModelReplica, now: number, limit = Number.POSITIVE_INFINITY): Outcome {
    if (!this.faults.skipCheckI && !this.#coversHorizons(puller, source.horizons)) {
      puller.stale = new Map(source.horizons);
      return "stale";
    }
    const since = puller.positions.get(source.id) ?? 0;
    const entries = source.log.filter((entry) => entry.seq > since);
    const ids: string[] = [];
    let toSeq = since;
    let index = 0;
    for (; index < entries.length; index++) {
      const entry = entries[index] as { seq: number; id: string };
      if (!ids.includes(entry.id)) {
        if (ids.length === limit) {
          break;
        }
        ids.push(entry.id);
      }
      toSeq = entry.seq;
    }
    const last = index === entries.length;
    // Every version of a document travels together, as the engine sends them
    // at level 4, so a replica that purged the document gets them all at once.
    const grouped = new Map<string, DocumentEnvelope>();
    for (const id of ids) {
      const row = source.rows.get(id);
      if (row === undefined) {
        continue;
      }
      const primaryId = row.conflictOf ?? row.id;
      const primary = row.kind === "document" ? source.rows.get(primaryId) : undefined;
      for (const version of primary === undefined ? [row] : [primary, ...this.#conflictRows(source, primaryId)]) {
        grouped.set(version.id, version);
      }
    }
    const rows = [...grouped.values()];
    const sent = this.knowledgeOf(source);

    if (!this.faults.skipCheckII && rows.some((row) => row.kind === "document")) {
      const covered = [...puller.horizons].every(([z, h]) => z === source.id || (sent.get(z) ?? 0) >= h);
      if (!covered) {
        return "stale";
      }
    }

    this.#withAppends(puller, now, () => {
      const ordered = [
        ...rows.filter((row) => row.kind === "system"),
        ...rows.filter((row) => row.kind === "document" && row.conflictOf === undefined),
        ...rows.filter((row) => row.conflictOf !== undefined),
      ];
      for (const incoming of ordered) {
        if (incoming.kind === "system") {
          this.#applySettings(puller, incoming);
        } else {
          this.#arrange(puller, incoming.conflictOf ?? incoming.id, incoming);
        }
      }
    });
    puller.positions.set(source.id, toSeq);
    if (!this.faults.dontInheritHorizons) {
      for (const [z, h] of source.horizons) {
        puller.horizons.set(z, Math.max(puller.horizons.get(z) ?? 0, h));
      }
    }
    // Only the last batch of a pull shows the puller holds everything the
    // source held when it was made.
    if (last || this.faults.mergeKnowledgeEarly) {
      for (const [z, k] of sent) {
        if (z !== puller.id) {
          puller.knowledge.set(z, Math.max(puller.knowledge.get(z) ?? 0, k));
        }
      }
      puller.knowledge.set(source.id, Math.max(puller.knowledge.get(source.id) ?? 0, source.lastSeq));
    }
    this.#clearStaleIfCovered(puller);
    return "ok";
  }

  #applySettings(replica: ModelReplica, incoming: DocumentEnvelope): void {
    const stored = replica.rows.get(SETTINGS_ID);
    if (stored === undefined) {
      replica.rows.set(SETTINGS_ID, incoming);
      this.#append(replica, SETTINGS_ID);
      return;
    }
    const order = compare(incoming.vectorClock, stored.vectorClock);
    if (order === "equal" || order === "before") {
      return;
    }
    if (order === "after") {
      replica.rows.set(SETTINGS_ID, incoming);
    } else {
      const winner = compareMeta(stored, incoming) >= 0 ? stored : incoming;
      const days = Math.max(stored.content["purgeAfterDays"] as number, incoming.content["purgeAfterDays"] as number);
      replica.rows.set(SETTINGS_ID, { ...winner, vectorClock: merge(stored.vectorClock, incoming.vectorClock), content: { purgeAfterDays: days } });
    }
    this.#append(replica, SETTINGS_ID);
  }

  // ---- purge ----

  purge(replica: ModelReplica, now: number): Outcome {
    const cutoff = now - this.settingsDays(replica) * DAY;
    const checkpoints = [...replica.closed, ...(replica.open === undefined ? [] : [replica.open])];
    const candidate = Math.max(0, ...checkpoints.filter((point) => point.at <= cutoff).map((point) => point.seq));
    let purgedThrough = replica.horizons.get(replica.id) ?? 0;
    for (const row of [...replica.rows.values()]) {
      if (row.kind !== "document" || row.conflictOf !== undefined || !row.deleted) {
        continue;
      }
      if (!this.faults.purgeConflicted && this.#conflictRows(replica, row.id).length > 0) {
        continue;
      }
      const seqs = replica.log.filter((entry) => entry.id === row.id).map((entry) => entry.seq);
      const old = this.faults.ageByUpdatedAt ? Date.parse(row.updatedAt) <= cutoff : seqs.every((seq) => seq <= candidate);
      if (!old) {
        continue;
      }
      replica.rows.delete(row.id);
      if (this.faults.purgeConflicted) {
        for (const conflictRow of this.#conflictRows(replica, row.id)) {
          replica.rows.delete(conflictRow.id);
        }
      }
      purgedThrough = Math.max(purgedThrough, ...seqs);
    }
    // Compaction: only the latest entry of each stored row stays.
    const latest = new Map<string, number>();
    for (const entry of replica.log) {
      if (replica.rows.has(entry.id)) {
        latest.set(entry.id, entry.seq);
      }
    }
    const kept = replica.log.filter((entry) => latest.get(entry.id) === entry.seq);
    replica.log.length = 0;
    replica.log.push(...kept);
    if (purgedThrough > 0) {
      replica.horizons.set(replica.id, purgedThrough);
    }
    // Keep only the newest checkpoint at or before the cutoff: later cutoffs are later.
    const newestOld = replica.closed.filter((point) => point.at <= cutoff).at(-1);
    replica.closed = replica.closed.filter((point) => point.at > cutoff || point === newestOld);
    return "ok";
  }
}

/**
 * The order the merged version's stamps come from: updatedAt, then
 * updatedOn, then updatedBy, then the clock's canonical form, so it is total.
 */
export function compareMeta(a: DocumentEnvelope, b: DocumentEnvelope): number {
  const key = (row: DocumentEnvelope) => [row.updatedAt, row.updatedOn, row.updatedBy, canonicalString(row.vectorClock)];
  const [x, y] = [key(a), key(b)];
  for (let index = 0; index < x.length; index++) {
    const p = x[index] as string;
    const q = y[index] as string;
    if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}
