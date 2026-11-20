import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/database.js";
import { Session } from "../src/session.js";
import { TestAdapter, admitEveryone, expectCode } from "./helpers.js";

const alice = Session.withId("alice");
const bob = Session.withId("bob");

let adapters: TestAdapter[];
const now = (): Date => new Date("2026-11-16T12:00:00.000Z");

beforeEach(() => {
  adapters = [];
});

afterEach(() => {
  for (const adapter of adapters) {
    adapter.close();
  }
});

function newAdapter(): TestAdapter {
  const adapter = new TestAdapter();
  adapters.push(adapter);
  return adapter;
}

async function founder(): Promise<{ db: Database; adapter: TestAdapter }> {
  const adapter = newAdapter();
  return { db: await alice.openDatabase(adapter, { now }), adapter };
}

describe("Acl.version", () => {
  it("is the same on every replica for the same ACL, and changes on save", async () => {
    const a = await founder();
    const copy = newAdapter();
    await a.db.createReplica(copy);
    const b = { db: await alice.openDatabase(copy, { now }) };
    const before = (await a.db.getAcl()).version;
    expect(before).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await b.db.getAcl()).version).toBe(before);
    const acl = await a.db.getAcl();
    acl.creators = ["*"];
    await acl.save();
    expect(acl.version).not.toBe(before);
    expect((await a.db.getAcl()).version).toBe(acl.version);
    await b.db.pullFrom(a.db);
    expect((await b.db.getAcl()).version).toBe(acl.version);
  });

  it("loads with ifVersion only at that version", async () => {
    const a = await founder();
    const first = await a.db.getAcl();
    expect((await a.db.getAcl({ ifVersion: first.version })).version).toBe(first.version);
    const acl = await a.db.getAcl();
    acl.creators = ["*"];
    await acl.save();
    await expectCode(a.db.getAcl({ ifVersion: first.version }), "STALE_DOCUMENT");
    await expect(a.db.getAcl({ ifVersion: 1 as never })).rejects.toThrow(TypeError);
  });

  it("gives an Acl whose save refuses if the ACL changed after it was loaded at that version", async () => {
    const a = await founder();
    const { version } = await a.db.getAcl();
    const held = await a.db.getAcl({ ifVersion: version });
    const other = await a.db.getAcl();
    other.creators = ["*"];
    await other.save();
    held.creators = ["alice", "bob"];
    await expectCode(held.save(), "STALE_DOCUMENT");
  });

  it("refuses non-admins before comparing versions", async () => {
    const a = await founder();
    await admitEveryone(a.db);
    const { version } = await a.db.getAcl();
    const asBob = await bob.openDatabase(a.adapter, { now });
    await expectCode(asBob.getAcl({ ifVersion: version }), "ACCESS_DENIED");
  });
});
