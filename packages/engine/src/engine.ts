// What this engine is: its release and the database levels it handles.

/** The CromDB version, as in package.json. */
export const VERSION = "0.5.0";

/**
 * The database levels this engine can open and sync. A level is a version of
 * what replicas store and exchange, recorded in each database. Level 1
 * identifies people by name, the format 0.1.x to 0.3.0 use. Level 2
 * identifies them by ID, as 0.4.0 and 0.5.0 do. Level 3 adds the database's
 * access structure: readers, writers and noAccess lists in the ACL, which
 * every document's own lists are narrowed by. Every database this engine
 * creates is at level 3. Raising an existing database to a higher level is
 * not available yet.
 */
export const SUPPORTED_LEVELS: { readonly min: number; readonly max: number } = Object.freeze({ min: 1, max: 3 });

/** @internal The level of every database this engine creates. */
export const NEW_DATABASE_LEVEL = 3;

/** @internal The first level whose ACL has the access structure. */
export const ACCESS_STRUCTURE_LEVEL = 3;

/** @internal Whether value is a level: a positive safe integer. */
export function isLevel(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}
