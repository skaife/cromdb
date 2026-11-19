import type { Driver, JsonObject } from "@cromdb/driver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Directory, SERVER_PRINCIPAL } from "../src/directory/directory.js";
import { mergePeople } from "../src/directory/merge.js";
import { readPerson, type Person } from "../src/directory/person.js";
import { createLevel2Driver } from "./helpers.js";

const T1 = new Date("2026-11-19T10:00:00.000Z");
const T2 = new Date("2026-11-19T11:00:00.000Z");
const T3 = new Date("2026-11-19T12:00:00.000Z");
const on = (handle: string) => ({ handle, principal: SERVER_PRINCIPAL });

let driver: Driver;
let handle: string;
const logs: string[] = [];

beforeEach(async () => {
  driver = createLevel2Driver();
  ({ handle } = await driver.call("database.create", { storage: { kind: "memory" }, principal: SERVER_PRINCIPAL }));
  logs.length = 0;
});
afterEach(() => driver.shutdown());

const load = (h = handle, serverId = "server-a", d = driver) => Directory.load({ driver: d, handle: h, serverId, log: (m) => logs.push(m) });

describe("the directory index", () => {
  it("finds people by ID, login and email", async () => {
    const directory = await load();
    const ann = await directory.invite({ email: " Ann@Example.com", serverAdmin: false, by: "setup", now: T1 });
    const id = ann.person.personId;
    await directory.update(id, T2, (p) => ({ ...p, status: "active", statusAt: T2.toISOString(), logins: [{ issuer: "https://id", subject: "s-1", addedAt: T2.toISOString() }] }));
    for (const d of [directory, await load()]) {
      expect(d.index.get(id)?.person.status).toBe("active");
      expect(d.index.byLogin("https://id", "s-1")?.person.personId).toBe(id);
      expect(d.index.byLogin("https://id", "s-2")).toBeUndefined();
      expect(d.index.byEmail("ANN@example.com").map((e) => e.person.personId)).toEqual([id]);
      expect(d.index.byEmail("__proto__")).toEqual([]);
      expect(d.index.get("constructor")).toBeUndefined();
    }
  });

  it("moves the email index when an email changes", async () => {
    const directory = await load();
    const { person } = await directory.invite({ email: "old@example.com", serverAdmin: false, by: "setup", now: T1 });
    await directory.update(person.personId, T2, (p) => ({ ...p, email: "new@example.com", emailAt: T2.toISOString() }));
    expect(directory.index.byEmail("old@example.com")).toEqual([]);
    expect(directory.index.byEmail("new@example.com")).toHaveLength(1);
  });

  it("pages through many people", async () => {
    const directory = await load();
    for (let i = 0; i < 1005; i++) {
      await directory.invite({ email: `p${i}@example.com`, serverAdmin: false, by: "setup", now: T1 });
    }
    expect((await load()).index.size).toBe(1005);
  }, 60_000);

  it("skips documents that aren't readable people, and says so", async () => {
    await driver.call("documents.create", { ...on(handle), content: { type: "person", schema: 1, personId: "x" }, readers: ["cromdb-server"], writers: ["cromdb-server"] });
    await driver.call("documents.create", { ...on(handle), content: { type: "something else" } });
    const directory = await load();
    expect(directory.index.size).toBe(0);
    expect(logs).toEqual([expect.stringContaining("missing or of the wrong type: email")]);
  });

  it("makes no write for no change", async () => {
    const directory = await load();
    const entry = await directory.invite({ email: "a@example.com", serverAdmin: true, by: "setup", now: T1 });
    expect(await directory.update(entry.person.personId, T2, (p) => p)).toBe(entry);
  });

  it("reads again and retries when the document changed underneath", async () => {
    const directory = await load();
    const { person } = await directory.invite({ email: "a@example.com", serverAdmin: false, by: "setup", now: T1 });
    // Another program (the console, while the server runs) changes the name.
    const other = await load();
    await other.update(person.personId, T2, (p) => ({ ...p, displayName: "Ann", displayNameAt: T2.toISOString() }));
    const seen: (string | null)[] = [];
    const result = await directory.update(person.personId, T3, (p) => {
      seen.push(p.displayName);
      return { ...p, serverAdmin: true, serverAdminAt: T3.toISOString() };
    });
    expect(seen).toEqual([null, "Ann"]);
    expect(result.person).toMatchObject({ displayName: "Ann", serverAdmin: true });
  });
});

describe("a person edited on two servers at once", () => {
  /** A second replica of the directory, on its own driver, and a way to sync both ways. */
  async function twoServers() {
    const directoryA = await load();
    const ann = await directoryA.invite({ email: "ann@example.com", serverAdmin: false, by: "setup", now: T1 });
    const { ticket } = await driver.call("replicas.register", { ...on(handle), name: "b" });
    const driverB = createLevel2Driver();
    const b = await driverB.call("database.createFromTicket", { storage: { kind: "memory" }, principal: SERVER_PRINCIPAL, ticket });
    const sync = async () => {
      for (const [from, fromHandle, to, toHandle] of [
        [driver, handle, driverB, b.handle],
        [driverB, b.handle, driver, handle],
      ] as const) {
        const position = await to.call("sync.position", { ...on(toHandle), sourceInstanceId: (await from.call("database.info", { handle: fromHandle })).instanceId });
        const { batch } = await from.call("sync.export", { ...on(fromHandle), since: position.since });
        await to.call("sync.apply", { ...on(toHandle), batch });
      }
    };
    await sync();
    const directoryB = await load(b.handle, "server-b", driverB);
    return { directoryA, directoryB, driverB, handleB: b.handle, personId: ann.person.personId, sync };
  }

  it("reads the merge of every version on both servers, not the interim winner", async () => {
    const { directoryA, directoryB, driverB, handleB, personId, sync } = await twoServers();
    try {
      // A disables Ann early; B, later, admits her and renames her.
      await directoryA.update(personId, T2, (p) => ({ ...p, status: "disabled", statusAt: T2.toISOString(), statusBy: "admin-a" }));
      await directoryB.update(personId, T3, (p) => ({
        ...p,
        status: "active",
        statusAt: T3.toISOString(),
        statusBy: "admin-b",
        displayName: "Ann B",
        displayNameAt: T3.toISOString(),
        logins: [{ issuer: "https://id", subject: "ann", addedAt: T3.toISOString() }],
      }));
      await sync();

      const conflict = await driver.call("conflicts.get", { ...on(handle), id: directoryA.index.get(personId)!.documentId });
      expect(conflict.conflict?.versions).toHaveLength(2);
      const versions = conflict.conflict!.versions.map((v) => (readPerson(v.document.content) as { person: Person }).person);
      const expected = mergePeople(versions);
      expect(expected).toMatchObject({ status: "disabled", statusBy: "admin-a", displayName: "Ann B", logins: [{ subject: "ann" }], changedOn: "server-b" });

      const [readA, readB] = [await load(), await load(handleB, "server-b", driverB)];
      for (const d of [readA, readB]) {
        expect(d.index.get(personId)?.person).toEqual(expected);
        expect(d.index.get(personId)?.conflictVersion).toBe(conflict.conflict!.version);
        expect(d.index.byLogin("https://id", "ann")?.person.personId).toBe(personId);
      }

      // A write on the home server resolves the conflict with the merged person.
      const written = await readA.update(personId, new Date("2026-11-19T13:00:00.000Z"), (p) => ({ ...p, serverAdmin: true, serverAdminAt: "2026-11-19T13:00:00.000Z" }));
      expect(written.conflictVersion).toBeNull();
      expect(written.person).toMatchObject({ status: "disabled", displayName: "Ann B", serverAdmin: true, changedOn: "server-a" });
      const after = await driver.call("conflicts.get", { ...on(handle), id: written.documentId });
      expect(after.conflict).toBeNull();
    } finally {
      await driverB.shutdown();
    }
  });

  it("ignores versions written by someone not allowed to", async () => {
    const { directoryA, directoryB, driverB, handleB, personId } = await twoServers();
    try {
      await directoryA.update(personId, T2, (p) => ({ ...p, displayName: "From A", displayNameAt: T2.toISOString() }));
      await directoryB.update(personId, T3, (p) => ({ ...p, displayName: "Forged", displayNameAt: T3.toISOString(), serverAdmin: true, serverAdminAt: T3.toISOString() }));
      // B's change arrives claiming a writer who isn't in the document's writers.
      const position = await driver.call("sync.position", { ...on(handle), sourceInstanceId: (await driverB.call("database.info", { handle: handleB })).instanceId });
      const { batch } = await driverB.call("sync.export", { ...on(handleB), since: position.since });
      let forged = 0;
      const forge = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(forge);
        if (typeof value !== "object" || value === null) return value;
        const record = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, forge(v)]));
        const content = record["content"] as Record<string, unknown> | undefined;
        if (content?.["displayName"] === "Forged" && record["updatedBy"] === "cromdb-server") {
          forged++;
          record["updatedBy"] = "intruder";
        }
        return record;
      };
      await driver.call("sync.apply", { ...on(handle), batch: forge(batch) as JsonObject });
      expect(forged).toBeGreaterThan(0);
      const id = directoryA.index.get(personId)!.documentId;
      const { conflict } = await driver.call("conflicts.get", { ...on(handle), id });
      expect(conflict?.versions.map((v) => v.authorized).sort()).toEqual([false, true]);
      const read = await load();
      expect(read.index.get(personId)?.person).toMatchObject({ displayName: "From A", serverAdmin: false });
    } finally {
      await driverB.shutdown();
    }
  });
});
