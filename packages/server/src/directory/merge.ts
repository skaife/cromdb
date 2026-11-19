// How versions of one person merge, when servers edited the person at the
// same time. Pure.
//
// merge is commutative, associative and idempotent, so every server that
// reads the same versions gets the same person, in whatever order it meets
// them. Each field (with its time, and for status its author) is picked on
// its own:
//
//   status       disabled beats active beats invited, whatever the times:
//                a disabling is never undone by a concurrent edit, and an
//                old invitation never undoes an admission. Among versions
//                with the winning status, the newest statusAt.
//   logins       the union, by (issuer, subject), keeping the earliest
//                addedAt of each. Logins are never removed in 0.x.
//   every other  the newest by its own time.
//
// Ties are broken by the canonical JSON of the field with its time, so the
// result never depends on order.

import { compareStrings, compareTimes } from "../text.js";
import { loginKey, type Login, type Person, type Status } from "./person.js";

const STATUS_RANK: Readonly<Record<Status, number>> = { invited: 0, active: 1, disabled: 2 };

/** JSON with object keys sorted, so equal values always give the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareStrings)
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The newer of two field values with their times; ties by canonical JSON. */
function newer<T extends object>(a: T, b: T, time: (value: T) => string): T {
  const byTime = compareTimes(time(a), time(b));
  if (byTime !== 0) {
    return byTime > 0 ? a : b;
  }
  return compareStrings(canonicalJson(a), canonicalJson(b)) >= 0 ? a : b;
}

function mergeLogins(a: readonly Login[], b: readonly Login[]): Login[] {
  const byKey = new Map<string, Login>();
  for (const login of [...a, ...b]) {
    const key = loginKey(login.issuer, login.subject);
    const seen = byKey.get(key);
    if (seen === undefined) {
      byKey.set(key, login);
    } else {
      // The earlier; equal times are the same login.
      byKey.set(key, compareTimes(login.addedAt, seen.addedAt) < 0 ? login : seen);
    }
  }
  return [...byKey.entries()].sort(([x], [y]) => compareStrings(x, y)).map(([, login]) => login);
}

/** Two versions of one person, merged. Both must have the same personId. */
export function mergeTwo(a: Person, b: Person): Person {
  if (a.personId !== b.personId) {
    throw new Error(`Can't merge two people: ${a.personId} and ${b.personId}`);
  }
  const statusA = { status: a.status, statusAt: a.statusAt, statusBy: a.statusBy };
  const statusB = { status: b.status, statusAt: b.statusAt, statusBy: b.statusBy };
  const rank = STATUS_RANK[statusA.status] - STATUS_RANK[statusB.status];
  const status = rank > 0 ? statusA : rank < 0 ? statusB : newer(statusA, statusB, (s) => s.statusAt);
  const email = newer({ email: a.email, emailAt: a.emailAt }, { email: b.email, emailAt: b.emailAt }, (f) => f.emailAt);
  const serverAdmin = newer(
    { serverAdmin: a.serverAdmin, serverAdminAt: a.serverAdminAt },
    { serverAdmin: b.serverAdmin, serverAdminAt: b.serverAdminAt },
    (f) => f.serverAdminAt,
  );
  const displayName = newer(
    { displayName: a.displayName, displayNameAt: a.displayNameAt },
    { displayName: b.displayName, displayNameAt: b.displayNameAt },
    (f) => f.displayNameAt,
  );
  const invited = newer({ invitedBy: a.invitedBy, invitedAt: a.invitedAt }, { invitedBy: b.invitedBy, invitedAt: b.invitedAt }, (f) => f.invitedAt);
  const changed = newer({ changedAt: a.changedAt, changedOn: a.changedOn }, { changedAt: b.changedAt, changedOn: b.changedOn }, (f) => f.changedAt);
  return {
    personId: a.personId,
    ...email,
    ...status,
    ...serverAdmin,
    ...displayName,
    logins: mergeLogins(a.logins, b.logins),
    ...invited,
    ...changed,
  };
}

/** Every version of one person, merged. */
export function mergePeople(versions: readonly Person[]): Person {
  const [first, ...rest] = versions;
  if (first === undefined) {
    throw new Error("No versions to merge");
  }
  // A single version still goes through mergeTwo, so its logins come out in
  // the same order as any merge's.
  return rest.reduce(mergeTwo, mergeTwo(first, first));
}
