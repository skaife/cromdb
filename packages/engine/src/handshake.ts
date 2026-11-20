import { CromDBError } from "./errors.js";
import { isPlainObject } from "./field-types.js";
import { PURGE_LEVEL, isLevel } from "./engine.js";
import type { SeqMap } from "./purge.js";

// The sync handshake: before syncing, each replica can send the other a
// hello saying what it is, so a mismatch shows up as one clear error before
// any batch moves. Pure; Database does the reads and writes.

export const HELLO_PROTOCOL = 1;

/**
 * What one replica tells another before they sync, from Database.syncHello.
 * Plain JSON, to send over any transport.
 */
export interface SyncHello {
  /** The handshake's own format. */
  readonly protocol: 1;
  readonly databaseId: string;
  readonly instanceId: string;
  /** The sender's CromDB version, for messages only: decisions use levels. */
  readonly engine: string;
  /** The database's level on the sender. */
  readonly level: number;
  /** The levels the sender's engine supports. */
  readonly levels: { readonly min: number; readonly max: number };
  readonly conflictPolicy: string;
  readonly unicodeVersion: string;
  /** Level 4 and above: the sender's highest change-log position. */
  readonly lastSeq?: number;
  /** Level 4 and above: as a batch's knowledge. */
  readonly knowledge?: SeqMap;
  /** Level 4 and above: as a batch's horizons. */
  readonly horizons?: SeqMap;
}

/** The result of Database.checkPeer. */
export interface PeerCheck {
  /** The level the two replicas sync at, which is the level of both. */
  readonly level: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SEQ_MAP_ENTRIES = 10_000;

function malformed(message: string): CromDBError {
  return new CromDBError("INVALID_HANDSHAKE", `The sync hello is malformed: ${message}`);
}

/** The own data property key of a plain object, or undefined if it has none. */
function own(value: object, key: string, what: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    return undefined;
  }
  if (!("value" in descriptor)) {
    throw malformed(`${what} ${JSON.stringify(key)} is not a data property`);
  }
  return descriptor.value as unknown;
}

function isPlainObjectValue(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isPlainObject(value);
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/**
 * @internal Checks a hello from another replica and returns a fresh copy.
 * Fields it doesn't know are ignored, so a later engine can add some. Throws
 * INVALID_HANDSHAKE if malformed, and UPGRADE_REQUIRED for a later protocol.
 */
export function parseHello(value: unknown): SyncHello {
  if (!isPlainObjectValue(value)) {
    throw malformed("expected a plain object");
  }
  const field = (key: string): unknown => own(value, key, "field");
  const protocol = field("protocol");
  if (protocol !== HELLO_PROTOCOL) {
    if (Number.isSafeInteger(protocol) && (protocol as number) > HELLO_PROTOCOL) {
      throw new CromDBError(
        "UPGRADE_REQUIRED",
        `The peer uses sync hello protocol ${String(protocol)}, but this engine knows only ${HELLO_PROTOCOL}; this replica must be upgraded`,
      );
    }
    throw malformed(`protocol must be ${HELLO_PROTOCOL}`);
  }
  const require = <V>(key: string, check: (item: unknown) => item is V, expected: string): V => {
    const item = field(key);
    if (!check(item)) {
      throw malformed(`${key} must be ${expected}`);
    }
    return item;
  };
  const isUuid = (item: unknown): item is string => typeof item === "string" && UUID_PATTERN.test(item);
  const databaseId = require("databaseId", isUuid, "a UUID");
  const instanceId = require("instanceId", isUuid, "a UUID");
  const engine = require("engine", (item): item is string => isText(item, 100), "a string of 1 to 100 characters");
  const level = require("level", isLevel, "a positive integer");
  const levels = require("levels", isPlainObjectValue, "an object { min, max }");
  const min = own(levels, "min", "levels field");
  const max = own(levels, "max", "levels field");
  if (!isLevel(min) || !isLevel(max) || min > max) {
    throw malformed("levels must have positive integers min and max, with min no more than max");
  }
  if (level < min || level > max) {
    throw malformed(`level ${level} is outside the sender's own levels ${min} to ${max}`);
  }
  const conflictPolicy = require("conflictPolicy", (item): item is string => isText(item, 100), "a string of 1 to 100 characters");
  const unicodeVersion = require("unicodeVersion", (item): item is string => isText(item, 20), "a string of 1 to 20 characters");
  let purge: { lastSeq: number; knowledge: SeqMap; horizons: SeqMap } | undefined;
  if (level >= PURGE_LEVEL) {
    const isSeq = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0;
    const seqMap = (key: string): SeqMap => {
      const map = require(key, isPlainObjectValue, "an object of instance IDs and positions");
      const keys = Object.keys(map);
      if (keys.length > MAX_SEQ_MAP_ENTRIES) {
        throw malformed(`${key} has more than ${MAX_SEQ_MAP_ENTRIES} entries`);
      }
      const entries: [string, number][] = keys.map((replica) => {
        const seq = own(map, replica, `${key} entry`);
        if (!isUuid(replica) || !isSeq(seq)) {
          throw malformed(`${key} entry ${JSON.stringify(replica)} must have an instance ID key and a non-negative integer`);
        }
        return [replica, seq];
      });
      return Object.freeze(Object.fromEntries(entries));
    };
    purge = { lastSeq: require("lastSeq", isSeq, "a non-negative integer"), knowledge: seqMap("knowledge"), horizons: seqMap("horizons") };
  }
  return Object.freeze({
    protocol: HELLO_PROTOCOL,
    databaseId,
    instanceId,
    engine,
    level,
    levels: Object.freeze({ min, max }),
    conflictPolicy,
    unicodeVersion,
    ...(purge ?? {}),
  });
}

/**
 * @internal The level two replicas sync at, given this replica's level and
 * engine levels and the peer's (a peer with no handshake supports level 1
 * only). Throws UPGRADE_REQUIRED, saying which side must be upgraded, if
 * either engine can't handle the higher of the two levels. Replicas sync
 * only at the same level, as no engine can raise a database yet: a peer at a
 * higher level is UPGRADE_REQUIRED, and one at a lower level SYNC_MISMATCH.
 */
export function syncLevel(
  ours: { readonly level: number; readonly max: number },
  theirs: { readonly level: number; readonly max: number; readonly name: string },
): number {
  const level = Math.max(ours.level, theirs.level);
  if (level > ours.max) {
    throw new CromDBError(
      "UPGRADE_REQUIRED",
      `The database is at level ${level} on ${theirs.name}, but this engine supports levels up to ${ours.max}; this replica must be upgraded`,
    );
  }
  if (level > theirs.max) {
    throw new CromDBError(
      "UPGRADE_REQUIRED",
      `This replica is at database level ${level}, but ${theirs.name} supports levels up to ${theirs.max}; it must be upgraded`,
    );
  }
  if (theirs.level > ours.level) {
    throw new CromDBError(
      "UPGRADE_REQUIRED",
      `${capitalize(theirs.name)} has this database at level ${theirs.level}, but this replica is at level ${ours.level}, and raising a database needs a later engine; this replica must be upgraded`,
    );
  }
  if (theirs.level < ours.level) {
    throw new CromDBError(
      "SYNC_MISMATCH",
      `${capitalize(theirs.name)} has this database at level ${theirs.level}, but this replica is at level ${ours.level}`,
    );
  }
  return level;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
