// What this engine is: its release and the database levels it handles.

/** The CromDB version, as in package.json. */
export const VERSION = "0.6.0";

/**
 * The database levels this engine can open and sync. A level is a version of
 * what replicas store and exchange, recorded in each database. Level 1
 * identifies people by name, the format 0.1.x to 0.3.0 use. Level 2
 * identifies them by ID, as 0.4.0 and 0.5.0 do. Level 3 adds the database's
 * access structure: readers, writers and noAccess lists in the ACL, which
 * every document's own lists are narrowed by. Level 4 adds purge: replicas
 * exchange what they know of each other's change logs and how far each has
 * purged, a settings document holds how long tombstones are kept, and
 * concurrent versions of the settings and of a replica's registration merge.
 * Every database this engine creates is at level 4. A level-3 database can
 * be raised to level 4 while it has no other replicas (Database.raiseLevel).
 */
export const SUPPORTED_LEVELS: { readonly min: number; readonly max: number } = Object.freeze({ min: 1, max: 4 });

/** @internal The level of every database this engine creates. */
export const NEW_DATABASE_LEVEL = 4;

/** @internal The first level with purge, knowledge and purge horizons. */
export const PURGE_LEVEL = 4;

/** @internal The first level whose ACL has the access structure. */
export const ACCESS_STRUCTURE_LEVEL = 3;

/** @internal Whether value is a level: a positive safe integer. */
export function isLevel(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}
