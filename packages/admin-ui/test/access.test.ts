import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { accessBadges } from "../src/screens/databases/access.ts";

const access = (flags: Partial<Record<"read" | "write" | "create" | "admin", boolean>>) => ({ visible: true, read: false, write: false, create: false, admin: false, ...flags });

describe("access badges", () => {
  it("names the cases the wireframe shows", () => {
    expect(accessBadges(access({ admin: true, read: true, write: true, create: true }))).toEqual({ badges: ["admin", "read", "write", "create"], note: undefined });
    expect(accessBadges(access({ read: true }))).toEqual({ badges: ["read"], note: undefined });
    expect(accessBadges(access({ create: true }))).toEqual({ badges: ["create"], note: "depositor: can add, can't read back" });
    expect(accessBadges(access({ admin: true }))).toEqual({ badges: ["admin"], note: "manage only: no document access" });
    expect(accessBadges(access({}))).toEqual({ badges: [], note: "no access to documents" });
  });

  it("shows a badge for each right and nothing else, for any access", () => {
    fc.assert(
      fc.property(fc.record({ read: fc.boolean(), write: fc.boolean(), create: fc.boolean(), admin: fc.boolean() }), (flags) => {
        const { badges, note } = accessBadges(access(flags));
        expect([...badges].sort()).toEqual((Object.keys(flags) as (keyof typeof flags)[]).filter((name) => flags[name]).sort());
        if (badges.length === 0) expect(note).toBeDefined();
        if (flags.read) expect(note).toBeUndefined();
      }),
    );
  });
});
