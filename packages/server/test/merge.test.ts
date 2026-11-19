import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mergePeople, mergeTwo } from "../src/directory/merge.js";
import { personContent, readPerson, STATUSES, type Person } from "../src/directory/person.js";

// Few distinct times and values, so ties happen often.
const time = fc.constantFrom(
  "2026-01-01T00:00:00.000Z",
  "2026-01-01T00:00:00.001Z",
  "2026-06-01T12:00:00.000Z",
  "2027-01-01T00:00:00.000Z",
);
const who = fc.constantFrom("setup", "console", "p1", "p2", "__proto__");
const login = fc.record({ issuer: fc.constantFrom("https://a", "https://b"), subject: fc.constantFrom("s1", "s2", "constructor"), addedAt: time });

const person: fc.Arbitrary<Person> = fc.record({
  personId: fc.constant("8d6c2a43-6d0e-4f43-9c31-0c7d3f3f4a10"),
  email: fc.constantFrom("a@example.com", "b@example.com"),
  emailAt: time,
  status: fc.constantFrom(...STATUSES),
  statusAt: time,
  statusBy: who,
  serverAdmin: fc.boolean(),
  serverAdminAt: time,
  displayName: fc.constantFrom(null, "Ann", "Bob"),
  displayNameAt: time,
  logins: fc.array(login, { maxLength: 3 }),
  invitedBy: who,
  invitedAt: time,
  changedAt: time,
  changedOn: fc.constantFrom("server-a", "server-b"),
});

/** A person as merging leaves it: logins deduplicated and sorted. */
const normal = (p: Person) => mergePeople([p]);

describe("merging versions of a person", () => {
  it("is commutative", () => {
    fc.assert(fc.property(person, person, (a, b) => {
        expect(mergeTwo(a, b)).toEqual(mergeTwo(b, a));
      }),
    );
  });

  it("is associative", () => {
    fc.assert(
      fc.property(person, person, person, (a, b, c) => {
        expect(mergeTwo(mergeTwo(a, b), c)).toEqual(mergeTwo(a, mergeTwo(b, c)));
      }),
    );
  });

  it("is idempotent", () => {
    fc.assert(fc.property(person, (a) => {
        expect(mergeTwo(normal(a), normal(a))).toEqual(normal(a));
      }),
    );
  });

  it("gives the same person for the versions in any order", () => {
    fc.assert(
      fc.property(fc.array(person, { minLength: 1, maxLength: 5 }), fc.nat(), (versions, seed) => {
        const shuffled = [...versions].sort((x, y) => ((JSON.stringify(x).length * 31 + seed) % 7) - ((JSON.stringify(y).length * 17 + seed) % 7));
        expect(mergePeople(shuffled)).toEqual(mergePeople(versions));
      }),
    );
  });

  it("lets disabled beat active beat invited, whatever the times", () => {
    fc.assert(
      fc.property(person, person, (a, b) => {
        const rank = { invited: 0, active: 1, disabled: 2 };
        const merged = mergeTwo(a, b);
        expect(rank[merged.status]).toBe(Math.max(rank[a.status], rank[b.status]));
        const winners = [a, b].filter((v) => v.status === merged.status);
        expect(winners.map((v) => v.statusAt)).toContain(merged.statusAt);
        expect(Date.parse(merged.statusAt)).toBe(Math.max(...winners.map((v) => Date.parse(v.statusAt))));
      }),
    );
  });

  it("keeps every login, once each, with its earliest time", () => {
    fc.assert(
      fc.property(person, person, (a, b) => {
        const merged = mergeTwo(a, b);
        const keys = (p: Person) => p.logins.map((l) => `${l.issuer} ${l.subject}`);
        expect(new Set(keys(merged))).toEqual(new Set([...keys(a), ...keys(b)]));
        expect(keys(merged).length).toBe(new Set(keys(merged)).size);
        for (const l of merged.logins) {
          const all = [...a.logins, ...b.logins].filter((x) => x.issuer === l.issuer && x.subject === l.subject);
          expect(Date.parse(l.addedAt)).toBe(Math.min(...all.map((x) => Date.parse(x.addedAt))));
        }
      }),
    );
  });

  it("takes every other field from the newer version", () => {
    fc.assert(
      fc.property(person, person, (a, b) => {
        fc.pre(a.emailAt !== b.emailAt && a.displayNameAt !== b.displayNameAt && a.serverAdminAt !== b.serverAdminAt);
        const merged = mergeTwo(a, b);
        const newer = <K extends keyof Person>(at: K) => (Date.parse(a[at] as string) > Date.parse(b[at] as string) ? a : b);
        expect(merged.email).toBe(newer("emailAt").email);
        expect(merged.displayName).toBe(newer("displayNameAt").displayName);
        expect(merged.serverAdmin).toBe(newer("serverAdminAt").serverAdmin);
      }),
    );
  });

  it("refuses two different people", () => {
    const a = fc.sample(person, 1)[0] as Person;
    expect(() => mergeTwo(a, { ...a, personId: "other" })).toThrow("Can't merge two people");
  });

  it("stores and reads a person unchanged", () => {
    fc.assert(
      fc.property(person, (p) => {
        const { content, fieldTypes } = personContent(normal(p));
        expect(readPerson(content)).toEqual({ person: normal(p) });
        expect(Object.keys(fieldTypes)).toContain("/statusAt");
        expect(Object.keys(fieldTypes).filter((k) => k.startsWith("/logins/"))).toHaveLength(normal(p).logins.length);
      }),
    );
  });
});

describe("reading a person document", () => {
  const good = personContent(fc.sample(person, 1)[0] as Person).content;

  it("names what is missing or wrong", () => {
    expect(readPerson({ ...good, status: "boss" })).toEqual({ problem: "missing or of the wrong type: status" });
    expect(readPerson({ ...good, statusAt: "yesterday" })).toEqual({ problem: "missing or of the wrong type: statusAt" });
    expect(readPerson({ ...good, logins: [{ issuer: "x" }] })).toEqual({ problem: "missing or of the wrong type: logins" });
    expect(readPerson({ ...good, type: "settings" })).toEqual({ problem: 'type is not "person"' });
    expect(readPerson({ ...good, schema: 2 })).toMatchObject({ problem: expect.stringContaining("schema is 2") });
  });

  it("reads only its own fields", () => {
    const inherited = Object.create({ personId: "from-prototype" }) as Record<string, unknown>;
    Object.assign(inherited, { ...good });
    delete inherited["personId"];
    expect(readPerson(inherited as never)).toEqual({ problem: "missing or of the wrong type: personId" });
  });
});
