// A reference model of purge, staleness and recovery: replicas, change logs,
// knowledge, purge horizons, the purge itself and the checks a pull makes,
// registrations and retirement, rewinds caught at hello, backups, adoption,
// and recovering suspect versions, written as plainly as possible and
// independently of Database. It reuses only the
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

import { arrange, conflictRowId, latestCount, writerClock, writerKeyIndex } from "../../src/conflict.js";
import { DEFAULT_POLICY, policyNamed } from "../../src/conflict-policy.js";
import type { DocumentEnvelope } from "../../src/envelope.js";
import { rulesFor } from "../../src/principals.js";
import { canonicalString, compare, merge, type VectorClock } from "../../src/vector-clock.js";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const DEFAULT_PURGE_AFTER_DAYS = 90;
export const SETTINGS_ID = "settings";
/** The ID of a replica's registration row. */
export const registrationId = (instanceId: string): string => `reg:${instanceId}`;
const MAX_LEVEL = 4;
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
  /** Don't check at hello whether either side's change log went back. */
  skipRewindCheck?: boolean;
  /** Recover leaves out versions of documents this replica doesn't have. */
  recoverSkipsAbsent?: boolean;
  /** Recover takes versions this replica already has, or has superseded, as suspects too. */
  recoverTakesKnown?: boolean;
  /** An accepted suspect's clock is its own, bumped, not merged with the versions here. */
  acceptWithoutMerge?: boolean;
  /** A retirement can be undone by a concurrent registration that says active. */
  activeWins?: boolean;
  /** Adopting a backup keeps the backed-up replica's instance ID. */
  adoptKeepsId?: boolean;
}

export type Status = "active" | "retired";

/** A version only an old copy had, kept on the replica that recovered it until a person decides. */
export interface ModelSuspect {
  readonly key: string;
  readonly primaryId: string;
  /** The old copy's version, as a primary row of primaryId. */
  readonly version: DocumentEnvelope;
  /** "known" for a version this replica already had when recover compared it, kept so recovering again never offers it. */
  readonly reason: "absent" | "concurrent" | "deleted" | "known";
  state: "pending" | "accepted" | "discarded" | "superseded" | "known";
}

/** A log entry's identity, as the engine's: its row, clock and time. */
function entryKey(row: DocumentEnvelope | undefined, id: string): string {
  return `${id}|${canonicalString(row?.vectorClock ?? {})}|${row?.updatedAt ?? ""}`;
}

/** The key recover gives a version: its document and clock. */
export function suspectKey(primaryId: string, clock: VectorClock): string {
  return `${primaryId}|${canonicalString(clock)}`;
}

interface Checkpoint {
  seq: number;
  at: number;
}

export class ModelReplica {
  readonly rows = new Map<string, DocumentEnvelope>();
  /** Each entry's position, its row, and its identity: the row's ID, clock and time when it was written. */
  readonly log: { seq: number; id: string; key: string }[] = [];
  /** For each replica whose hello this one checked: that replica's newest entry then. */
  readonly tips = new Map<string, { seq: number; key: string }[]>();
  lastSeq = 0;
  readonly positions = new Map<string, number>();
  readonly knowledge = new Map<string, number>();
  readonly horizons = new Map<string, number>();
  closed: Checkpoint[] = [];
  open: (Checkpoint & { since: number }) | undefined;
  stale: Map<string, number> | undefined;
  /** Set on a backup: whose backup it is, and that replica's lastSeq then. */
  backupOf: { of: string; lastSeq: number } | undefined;
  /** A hello showed this replica's change log went back. Permanent. */
  rewound = false;
  /** This replica holds its own registration as retired. Permanent. */
  retired = false;
  /** Recovered versions, by key, in the order recover found them. */
  readonly suspects = new Map<string, ModelSuspect>();

  constructor(readonly id: string) {}

  /** A copy of everything, as a file copy would make, under id. */
  clone(id: string = this.id): ModelReplica {
    const copy = new ModelReplica(id);
    for (const [key, row] of this.rows) copy.rows.set(key, row);
    copy.log.push(...this.log.map((entry) => ({ ...entry })));
    copy.lastSeq = this.lastSeq;
    for (const [key, value] of this.positions) copy.positions.set(key, value);
    for (const [key, value] of this.knowledge) copy.knowledge.set(key, value);
    for (const [key, value] of this.horizons) copy.horizons.set(key, value);
    copy.closed = this.closed.map((point) => ({ ...point }));
    copy.open = this.open === undefined ? undefined : { ...this.open };
    copy.stale = this.stale === undefined ? undefined : new Map(this.stale);
    copy.backupOf = this.backupOf === undefined ? undefined : { ...this.backupOf };
    copy.rewound = this.rewound;
    copy.retired = this.retired;
    for (const [key, suspect] of this.suspects) copy.suspects.set(key, { ...suspect });
    for (const [key, tips] of this.tips) copy.tips.set(key, tips.map((tip) => ({ ...tip })));
    return copy;
  }

  /** What this replica holds about replica z: its registration's status, or undefined if it holds none. */
  status(z: string): Status | undefined {
    return this.rows.get(registrationId(z))?.content["status"] as Status | undefined;
  }

  /** Puts back everything from a clone of this replica, as a refused transaction does. */
  restoreFrom(copy: ModelReplica): void {
    this.rows.clear();
    for (const [key, row] of copy.rows) this.rows.set(key, row);
    this.log.length = 0;
    this.log.push(...copy.log);
    this.lastSeq = copy.lastSeq;
    for (const [target, source] of [
      [this.positions, copy.positions],
      [this.knowledge, copy.knowledge],
      [this.horizons, copy.horizons],
    ] as const) {
      target.clear();
      for (const [key, value] of source) target.set(key, value);
    }
    this.closed = copy.closed;
    this.open = copy.open;
    this.stale = copy.stale;
  }

  /** A backup, rewound or retired replica: it doesn't write or sync, ever. */
  get blocked(): boolean {
    return this.backupOf !== undefined || this.rewound || this.retired;
  }

  /** Takes writes: not blocked and not stale. */
  get writable(): boolean {
    return !this.blocked && this.stale === undefined;
  }

  /** Live documents (kind "document", not deleted, not conflict rows), by ID. */
  live(): Map<string, DocumentEnvelope> {
    return new Map([...this.rows].filter(([, row]) => row.kind === "document" && row.conflictOf === undefined && !row.deleted));
  }
}

export type Outcome = "ok" | "stale" | "skipped" | "readOnly" | "refused" | "rewound";

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
  return JSON.stringify([row.conflictOf ?? null, row.deleted, Object.entries(row.vectorClock).sort(), row.content]);
}

/** What every test write puts in a document: who wrote it, and when, so two writes never look the same. */
export function writeTag(instanceId: string, now: number): { w: string } {
  return { w: `${instanceId}@${now}` };
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
    replica.log.push({ seq: replica.lastSeq, id, key: entryKey(replica.rows.get(id), id) });
  }

  /** The replica's newest entry, if it is still in the log. */
  #tip(replica: ModelReplica): { seq: number; key: string } | undefined {
    const last = replica.log.at(-1);
    return last !== undefined && last.seq === replica.lastSeq ? { seq: last.seq, key: last.key } : undefined;
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
  found(id: string, now = 0): ModelReplica {
    const replica = new ModelReplica(id);
    this.#withAppends(replica, now, () => {
      this.#writeRegistration(replica, id, { instanceId: id, status: "active", maxLevel: MAX_LEVEL }, now);
    });
    this.replicas.push(replica);
    return replica;
  }

  /** A new version of z's registration, written by replica, as the engine's writeDocument makes it. */
  #writeRegistration(replica: ModelReplica, z: string, content: Record<string, unknown>, now: number): void {
    const id = registrationId(z);
    const stored = replica.rows.get(id);
    const clock = { ...(stored?.vectorClock ?? {}) };
    clock[replica.id] = (clock[replica.id] ?? 0) + 1;
    replica.rows.set(id, {
      id,
      parentId: id,
      kind: "system",
      vectorClock: clock,
      deleted: false,
      ...this.#stamp(replica, stored, now),
      readers: [this.principal],
      writers: [this.principal],
      content: content as DocumentEnvelope["content"],
      fieldTypes: {},
    });
    this.#append(replica, id);
  }

  /**
   * What the engine does when a replica is opened: a replica whose own
   * registration doesn't yet say the engine's highest level writes it, unless
   * it is blocked.
   */
  opened(replica: ModelReplica, now: number): void {
    const own = replica.rows.get(registrationId(replica.id));
    if (replica.blocked || own === undefined || own.content["maxLevel"] === MAX_LEVEL) {
      return;
    }
    this.#withAppends(replica, now, () => {
      this.#writeRegistration(replica, replica.id, { ...own.content, maxLevel: MAX_LEVEL }, now);
    });
  }

  /** As Database.createReplica: a full copy, with the source's knowledge and horizons. */
  copy(source: ModelReplica, id: string, now: number): ModelReplica {
    this.#withAppends(source, now, () => {
      this.#writeRegistration(source, id, { instanceId: id, status: "active" }, now);
    });
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
    if (!replica.writable) {
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
        content: writeTag(replica.id, now),
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
    if (!replica.writable || !this.editable(replica, id)) {
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
        content: deleted ? {} : writeTag(replica.id, now),
        fieldTypes: {},
      };
      replica.rows.set(id, row);
      this.#append(replica, id);
      this.#arrange(replica, id);
    });
    return "ok";
  }

  setPurgeAfterDays(replica: ModelReplica, days: number, now: number): Outcome {
    if (!replica.writable) {
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
    // The source says hello first, then the puller checks it.
    if (source.blocked || puller.blocked) {
      return source.rewound || (!source.blocked && puller.rewound) ? "rewound" : "refused";
    }
    if (puller.status(source.id) !== "active") {
      return "refused";
    }
    if (!this.faults.skipRewindCheck) {
      // (a) The source knows more of the puller's log than the puller has.
      if ((this.knowledgeOf(source).get(puller.id) ?? 0) > puller.lastSeq) {
        puller.rewound = true;
        return "rewound";
      }
      // The source saw an entry of the puller's log where the puller now has another.
      for (const tip of source.tips.get(puller.id) ?? []) {
        if (tip.seq > puller.lastSeq || puller.log.some((entry) => entry.seq === tip.seq && entry.key !== tip.key)) {
          puller.rewound = true;
          return "rewound";
        }
      }
      // The source's newest entry is where it showed the puller another.
      const sourceTip = this.#tip(source);
      if (sourceTip !== undefined && (puller.tips.get(source.id) ?? []).some((tip) => tip.seq === sourceTip.seq && tip.key !== sourceTip.key)) {
        return "rewound";
      }
      // (b) The puller knows more of the source's log than the source has.
      if (this.known(puller, source.id) > source.lastSeq) {
        return "rewound";
      }
    }
    if (!this.faults.skipCheckI && !this.#coversHorizons(puller, source.horizons)) {
      puller.stale = new Map(source.horizons);
      return "stale";
    }
    // The hello passed: the puller keeps the source's tip, with the latest few before it.
    const newestTip = this.#tip(source);
    if (newestTip !== undefined) {
      const kept = (puller.tips.get(source.id) ?? []).filter((tip) => tip.seq !== newestTip.seq);
      puller.tips.set(source.id, [...kept, newestTip].slice(-8));
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

    // A version carrying a write of the puller's that it doesn't hold means
    // the puller went back: the batch is refused, and it is marked rewound.
    // Not checked for a document absent here once this replica has purged,
    // as the engine doesn't (it may have purged the document).
    const before = puller.clone();
    const purged = (puller.horizons.get(puller.id) ?? 0) > 0;
    const absent = new Set(purged ? rows.filter((row) => row.kind === "document" && !puller.rows.has(row.conflictOf ?? row.id)).map((row) => row.conflictOf ?? row.id) : []);
    let ownWriteMissing = false;
    this.#withAppends(puller, now, () => {
      const ordered = [
        ...rows.filter((row) => row.kind === "system"),
        ...rows.filter((row) => row.kind === "document" && row.conflictOf === undefined),
        ...rows.filter((row) => row.conflictOf !== undefined),
      ];
      for (const incoming of ordered) {
        if (ownWriteMissing) {
          break;
        }
        const primaryId = incoming.kind === "document" ? (incoming.conflictOf ?? incoming.id) : incoming.id;
        if (!(incoming.kind === "document" && absent.has(primaryId))) {
          const stored = incoming.kind === "document" ? this.#storedClocks(puller, primaryId) : [puller.rows.get(incoming.id)].flatMap((row) => (row === undefined ? [] : [row.vectorClock]));
          for (const key of Object.keys(incoming.vectorClock)) {
            if (writerKeyIndex(puller.id, key) !== undefined && (incoming.vectorClock[key] ?? 0) > latestCount(key, stored)) {
              ownWriteMissing = true;
            }
          }
          if (ownWriteMissing) {
            break;
          }
        }
        if (incoming.id === SETTINGS_ID) {
          this.#applySettings(puller, incoming);
        } else if (incoming.kind === "system") {
          this.#applyRegistration(puller, incoming);
        } else {
          this.#arrange(puller, incoming.conflictOf ?? incoming.id, incoming);
        }
      }
    });
    if (ownWriteMissing) {
      puller.restoreFrom(before);
      puller.rewound = true;
      return "rewound";
    }
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
    // A replica that receives its own registration retired stops for good.
    if (puller.status(puller.id) === "retired") {
      puller.retired = true;
    }
    return "ok";
  }

  /**
   * A registration version from a pull, as the engine applies it: a later one
   * replaces what is here, an earlier or equal one is skipped, and concurrent
   * ones merge: the replica's own fields from the version with more of its
   * own writes, and retired if either says so.
   */
  #applyRegistration(replica: ModelReplica, incoming: DocumentEnvelope): void {
    const stored = replica.rows.get(incoming.id);
    if (stored === undefined) {
      replica.rows.set(incoming.id, incoming);
      this.#append(replica, incoming.id);
      return;
    }
    const order = compare(incoming.vectorClock, stored.vectorClock);
    if (order === "equal" || order === "before") {
      return;
    }
    if (order === "after") {
      replica.rows.set(incoming.id, incoming);
    } else {
      const owner = incoming.content["instanceId"] as string;
      const own = (row: DocumentEnvelope) => row.vectorClock[owner] ?? 0;
      const base = own(stored) > own(incoming) ? stored : own(incoming) > own(stored) ? incoming : compareMeta(stored, incoming) >= 0 ? stored : incoming;
      const retired = stored.content["status"] === "retired" || incoming.content["status"] === "retired";
      const active = stored.content["status"] === "active" || incoming.content["status"] === "active";
      const status = this.faults.activeWins ? (active ? "active" : "retired") : retired ? "retired" : "active";
      const stamps = compareMeta(stored, incoming) >= 0 ? stored : incoming;
      replica.rows.set(incoming.id, { ...stamps, vectorClock: merge(stored.vectorClock, incoming.vectorClock), content: { ...base.content, status } });
    }
    this.#append(replica, incoming.id);
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

  // ---- retirement, backups, adoption, recovery ----

  /** by retires the replica with instance ID id. */
  retire(by: ModelReplica, id: string, now: number): Outcome {
    if (!by.writable) {
      return "readOnly";
    }
    const stored = by.rows.get(registrationId(id));
    if (id === by.id || stored === undefined) {
      return "skipped";
    }
    if (stored.content["status"] === "retired") {
      return "ok";
    }
    this.#withAppends(by, now, () => {
      this.#writeRegistration(by, id, { ...stored.content, status: "retired" }, now);
    });
    return "ok";
  }

  /**
   * As Database.backup: the rows and the replica's own local state, a change
   * log made again on the copy (one entry per row, in ID order), purge
   * checkpoints reset to that log's end at this time, no peer positions, no
   * suspects, and the backup mark.
   */
  backup(replica: ModelReplica, now: number): ModelReplica | undefined {
    if (replica.blocked) {
      return undefined;
    }
    const copy = new ModelReplica(replica.id);
    for (const row of [...replica.rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      copy.rows.set(row.id, row);
      copy.lastSeq++;
      copy.log.push({ seq: copy.lastSeq, id: row.id, key: entryKey(row, row.id) });
    }
    copy.open = copy.lastSeq === 0 ? undefined : { seq: copy.lastSeq, at: now, since: now };
    for (const [z, k] of this.knowledgeOf(replica)) copy.knowledge.set(z, k);
    for (const [z, h] of replica.horizons) copy.horizons.set(z, h);
    copy.stale = replica.stale === undefined ? undefined : new Map(replica.stale);
    copy.backupOf = { of: replica.id, lastSeq: replica.lastSeq };
    return copy;
  }

  /** As openDatabase(backup, { adopt: true }): a new replica with a new ID; the backed-up one retired. */
  adopt(backup: ModelReplica, id: string, now: number): ModelReplica | undefined {
    const mark = backup.backupOf;
    if (mark === undefined || backup.rewound || backup.retired) {
      return undefined;
    }
    const adopted = backup.clone(this.faults.adoptKeepsId ? mark.of : id);
    adopted.backupOf = undefined;
    adopted.positions.clear();
    this.#withAppends(adopted, now, () => {
      if (adopted.id !== mark.of) {
        this.#writeRegistration(adopted, adopted.id, { instanceId: adopted.id, status: "active" }, now);
        const old = adopted.rows.get(registrationId(mark.of));
        if (old !== undefined && old.content["status"] !== "retired") {
          this.#writeRegistration(adopted, mark.of, { ...old.content, status: "retired" }, now);
        }
        adopted.knowledge.set(mark.of, Math.max(adopted.knowledge.get(mark.of) ?? 0, mark.lastSeq));
      }
    });
    this.opened(adopted, now);
    this.replicas.push(adopted);
    return adopted;
  }

  /** As registerReplica on introducer and openDatabase(empty, { replicaOf }): an empty replica that knows the database. */
  fromTicket(introducer: ModelReplica, id: string, now: number): ModelReplica | undefined {
    if (!introducer.writable) {
      return undefined;
    }
    this.#withAppends(introducer, now, () => {
      this.#writeRegistration(introducer, id, { instanceId: id, status: "active" }, now);
    });
    const replica = new ModelReplica(id);
    this.#withAppends(replica, now, () => {
      for (const z of [introducer.id, id]) {
        const row = introducer.rows.get(registrationId(z)) as DocumentEnvelope;
        replica.rows.set(row.id, row);
        this.#append(replica, row.id);
      }
    });
    this.opened(replica, now);
    this.replicas.push(replica);
    return replica;
  }

  #versions(replica: ModelReplica, primaryId: string): DocumentEnvelope[] {
    const primary = replica.rows.get(primaryId);
    return [...(primary === undefined ? [] : [primary]), ...this.#conflictRows(replica, primaryId)];
  }

  /** As Database.recover: every version only old has becomes a pending suspect here, once. Returns how many were new. */
  recover(replica: ModelReplica, old: ModelReplica): number | "refused" {
    if (replica.blocked || old.id === replica.id) {
      return "refused";
    }
    let added = 0;
    const primaries = [...old.rows.values()]
      .filter((row) => row.kind === "document" && row.conflictOf === undefined)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const primary of primaries) {
      const here = this.#versions(replica, primary.id);
      if (here.length === 0 && this.faults.recoverSkipsAbsent) {
        continue;
      }
      for (const version of this.#versions(old, primary.id)) {
        const key = suspectKey(primary.id, version.vectorClock);
        if (replica.suspects.has(key)) {
          continue;
        }
        const known = here.some((row) => ["before", "equal"].includes(compare(version.vectorClock, row.vectorClock))) && !this.faults.recoverTakesKnown;
        const { conflictOf: _conflictOf, ...rest } = version;
        replica.suspects.set(key, {
          key,
          primaryId: primary.id,
          version: { ...rest, id: primary.id, parentId: primary.parentId },
          reason: known ? "known" : here.length === 0 ? "absent" : version.deleted ? "deleted" : "concurrent",
          state: known ? "known" : "pending",
        });
        if (!known) {
          added++;
        }
      }
    }
    return added;
  }

  /** Pending suspects, by key. */
  pending(replica: ModelReplica): ModelSuspect[] {
    return [...replica.suspects.values()].filter((suspect) => suspect.state === "pending").sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  discard(replica: ModelReplica, key: string): Outcome {
    const suspect = replica.suspects.get(key);
    if (suspect === undefined || suspect.state !== "pending") {
      return "skipped";
    }
    suspect.state = "discarded";
    return "ok";
  }

  /**
   * As Suspect.accept: a new write here that supersedes every version of the
   * document here and the suspect, with the suspect's content (or its
   * deletion). The document's other pending suspects are decided with it.
   */
  accept(replica: ModelReplica, key: string, now: number): Outcome {
    const suspect = replica.suspects.get(key);
    if (suspect === undefined || suspect.state !== "pending") {
      return "skipped";
    }
    if (!replica.writable) {
      return "readOnly";
    }
    const { primaryId, version } = suspect;
    const here = this.#versions(replica, primaryId);
    const stored = replica.rows.get(primaryId);
    if (here.length > 0 || !version.deleted) {
      const clocks = here.map((row) => row.vectorClock);
      const base = this.faults.acceptWithoutMerge ? version.vectorClock : clocks.reduce((clock, next) => merge(clock, next), version.vectorClock);
      this.#withAppends(replica, now, () => {
        const at = new Date(now).toISOString();
        const row: DocumentEnvelope = {
          id: primaryId,
          parentId: stored?.parentId ?? version.parentId,
          kind: "document",
          vectorClock: writerClock(replica.id, base, clocks),
          deleted: version.deleted,
          ...(version.deleted ? { deletedAt: at } : {}),
          createdAt: stored?.createdAt ?? version.createdAt,
          createdBy: stored?.createdBy ?? version.createdBy,
          updatedAt: at,
          updatedBy: this.principal,
          updatedOn: replica.id,
          readers: version.deleted && stored !== undefined ? stored.readers : version.readers,
          writers: version.deleted && stored !== undefined ? stored.writers : version.writers,
          content: version.deleted ? {} : version.content,
          fieldTypes: version.deleted ? {} : version.fieldTypes,
        };
        replica.rows.set(primaryId, row);
        this.#append(replica, primaryId);
        this.#arrange(replica, primaryId);
      });
    }
    suspect.state = "accepted";
    for (const other of replica.suspects.values()) {
      if (other.primaryId === primaryId && other.state === "pending") {
        other.state = "superseded";
      }
    }
    return "ok";
  }

  // ---- purge ----

  purge(replica: ModelReplica, now: number): Outcome {
    if (replica.blocked) {
      return "readOnly";
    }
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
