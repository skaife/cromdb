import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CromDBError } from "../src/errors.js";
import { MAX_ID_LENGTH, idRules, nameRules, rulesFor } from "../src/principals.js";
import { Session } from "../src/session.js";

// IDs, the principals of a database at level 2: 1 to 512 characters from
// U+0021 to U+007E, stored as given and compared exactly.

const ids = idRules(2);

const allowedChar = fc.integer({ min: 0x21, max: 0x7e }).map((code) => String.fromCharCode(code));
const RESERVED = new Set(["*", "system", "anonymous"]);
function isReserved(id: string): boolean {
  return RESERVED.has(id.toLowerCase()) || id.startsWith("[");
}
const validId = fc
  .array(allowedChar, { minLength: 1, maxLength: MAX_ID_LENGTH })
  .map((chars) => chars.join(""))
  .filter((id) => !isReserved(id));
// Any one UTF-16 code unit outside U+0021 to U+007E, lone surrogates included.
const disallowedChar = fc
  .oneof(fc.integer({ min: 0, max: 0x20 }), fc.integer({ min: 0x7f, max: 0xffff }))
  .map((code) => String.fromCharCode(code));

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(CromDBError);
    return (error as CromDBError).code;
  }
}

describe("IDs", () => {
  it("accepts any string of allowed characters, 1 to 512 long and not reserved, and stores it unchanged (property)", () => {
    fc.assert(
      fc.property(validId, (id) => {
        expect(Session.withId(id).principal).toBe(id);
        expect(ids.principal(id)).toBe(id);
        expect(ids.accessList([id], "admins")).toEqual([id]);
      }),
    );
  });

  it("refuses an ID with any one character outside U+0021 to U+007E (property)", () => {
    fc.assert(
      fc.property(validId, disallowedChar, fc.nat(), (id, bad, at) => {
        const index = at % (id.length + 1);
        const changed = (id.slice(0, index) + bad + id.slice(index)).slice(0, MAX_ID_LENGTH);
        fc.pre(changed.includes(bad));
        expect(code(() => Session.withId(changed))).toBe("INVALID_PRINCIPAL");
        expect(code(() => ids.accessList([changed], "readers"))).toBe("INVALID_ACCESS_LIST");
      }),
    );
  });

  it("refuses the empty string and anything longer than 512 characters", () => {
    expect(code(() => Session.withId(""))).toBe("INVALID_PRINCIPAL");
    expect(Session.withId("a".repeat(512)).principal).toHaveLength(512);
    expect(code(() => Session.withId("a".repeat(513)))).toBe("INVALID_PRINCIPAL");
    expect(code(() => ids.accessList(["a".repeat(513)], "writers"))).toBe("INVALID_ACCESS_LIST");
  });

  it.each([1, null, undefined, {}, ["alice"]])("refuses a non-string %j", (value) => {
    expect(code(() => Session.withId(value as string))).toBe("INVALID_PRINCIPAL");
  });

  it.each(["*", "system", "System", "SYSTEM", "sYsTeM", "anonymous", "Anonymous", "ANONYMOUS", "[", "[Admin]", "[x"])(
    "reserves %j as a session ID",
    (id) => {
      const error = (() => {
        try {
          Session.withId(id);
        } catch (caught) {
          return caught as CromDBError;
        }
        return undefined;
      })();
      expect(error?.code).toBe("INVALID_PRINCIPAL");
      expect(error?.message).toMatch(/reserved/);
    },
  );

  it("reserves system and anonymous in any case (property)", () => {
    const casings = (word: string): fc.Arbitrary<string> =>
      fc.array(fc.boolean(), { minLength: word.length, maxLength: word.length }).map((upper) =>
        [...word].map((char, index) => (upper[index] === true ? char.toUpperCase() : char)).join(""),
      );
    fc.assert(
      fc.property(fc.oneof(casings("system"), casings("anonymous")), (id) => {
        expect(code(() => Session.withId(id))).toBe("INVALID_PRINCIPAL");
        // Exactly "anonymous" is the special entry that admits everyone,
        // allowed in every list but admins.
        const expected = id === "anonymous" ? undefined : "INVALID_ACCESS_LIST";
        for (const field of ["readers", "writers", "creators"] as const) {
          expect(code(() => ids.accessList([id], field))).toBe(expected);
        }
        expect(code(() => ids.accessList([id], "admins"))).toBe("INVALID_ACCESS_LIST");
      }),
    );
  });

  it("allows IDs that only contain or resemble reserved words", () => {
    for (const id of ["systems", "anonymous1", "my-system", "a*", "x[1]", "**", "user@example.com", "auth0|5f7c8ec7c33c6c004bbafe82"]) {
      expect(Session.withId(id).principal).toBe(id);
    }
  });
});

describe("access lists of IDs", () => {
  it("compares exactly: different case is a different principal, not a duplicate", () => {
    expect(ids.accessList(["Alice", "alice", "ALICE"], "admins")).toEqual(["Alice", "alice", "ALICE"]);
    for (const field of ["readers", "writers", "creators", "admins"] as const) {
      expect(ids.canAccess("alice", ids.accessList(["Alice"], field))).toBe(false);
      expect(ids.canAccess("Alice", ids.accessList(["Alice"], field))).toBe(true);
    }
  });

  it("refuses exact duplicates", () => {
    expect(code(() => ids.accessList(["alice", "alice"], "readers"))).toBe("INVALID_ACCESS_LIST");
    expect(code(() => ids.accessList(["*", "*"], "readers"))).toBe("INVALID_ACCESS_LIST");
  });

  it('allows "*" and "anonymous" exactly, except in admins', () => {
    for (const field of ["readers", "writers", "creators"] as const) {
      expect(ids.accessList(["*", "anonymous"], field)).toEqual(["*", "anonymous"]);
    }
    expect(code(() => ids.accessList(["*"], "admins"))).toBe("INVALID_ACCESS_LIST");
    expect(code(() => ids.accessList(["alice", "anonymous"], "admins"))).toBe("INVALID_ACCESS_LIST");
    expect(code(() => ids.accessList(["Anonymous"], "readers"))).toBe("INVALID_ACCESS_LIST");
  });

  it("allows empty creators only", () => {
    expect(ids.accessList([], "creators")).toEqual([]);
    for (const field of ["readers", "writers", "admins"] as const) {
      expect(code(() => ids.accessList([], field))).toBe("INVALID_ACCESS_LIST");
    }
  });

  it("follows the ladder: anonymous admits everyone, * every ID, an ID itself", () => {
    expect(ids.canAccess("anonymous", ["anonymous"])).toBe(true);
    expect(ids.canAccess("bob", ["anonymous"])).toBe(true);
    expect(ids.canAccess("anonymous", ["*"])).toBe(false);
    expect(ids.canAccess("bob", ["*"])).toBe(true);
    expect(ids.canAccess("bob", ["alice"])).toBe(false);
  });
});

describe("rulesFor", () => {
  it("uses names at level 1 and IDs above it", () => {
    expect(rulesFor(1, "17.0").level).toBe(1);
    expect(rulesFor(1, "17.0").canAccess("ALICE", ["alice"])).toBe(true);
    expect(rulesFor(2, "17.0").canAccess("ALICE", ["alice"])).toBe(false);
    expect(nameRules("17.0").principal("Ｂｏｂ")).toBe("Bob");
    expect(code(() => rulesFor(2, "17.0").principal("Ｂｏｂ"))).toBe("INVALID_PRINCIPAL");
  });
});
