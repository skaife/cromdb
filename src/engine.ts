// What this engine is: its release and the database levels it handles.

/** The CromDB version, as in package.json. */
export const VERSION = "0.3.0";

/**
 * The database levels this engine can open and sync. A level is a version of
 * what replicas store and exchange, recorded in each database; a database is
 * raised to a new level only when every replica can handle it. In 0.3.0 every
 * database is at level 1, the format 0.1.x and 0.2.0 use.
 */
export const SUPPORTED_LEVELS: { readonly min: number; readonly max: number } = Object.freeze({ min: 1, max: 1 });

/** @internal Whether value is a level: a positive safe integer. */
export function isLevel(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}
