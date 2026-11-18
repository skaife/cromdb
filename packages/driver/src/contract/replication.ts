import { existsSync } from "node:fs";
import type { JsonObject } from "../json.js";
import { assert, assertEqual, type ContractContext } from "./context.js";
import type { ContractCheck } from "./index.js";

const ALICE = { id: "alice" };
const BOB = { id: "bob" };

interface Replica {
  readonly handle: string;
  readonly instanceId: string;
  readonly databaseId: string;
  readonly alice: { readonly handle: string; readonly principal: { readonly id: string } };
}

function replica(opened: { handle: string; instanceId: string; databaseId: string }): Replica {
  return { ...opened, alice: { handle: opened.handle, principal: ALICE } };
}

/** Pulls everything from one replica into another, through hello, checkPeer, export, apply and position. */
async function pull(ctx: ContractContext, from: Replica, to: Replica): Promise<number> {
  const { hello } = await ctx.call("sync.hello", from.alice);
  await ctx.call("sync.checkPeer", { ...to.alice, hello });
  let applied = 0;
  for (let rounds = 0; ; rounds++) {
    assert(rounds < 1000, "sync never finished");
    const { since } = await ctx.call("sync.position", { ...to.alice, sourceInstanceId: from.instanceId });
    const { batch } = await ctx.call("sync.export", { ...from.alice, since, limit: 2 });
    const result = await ctx.call("sync.apply", { ...to.alice, batch });
    applied += result.applied;
    if (!result.hasMore) {
      return applied;
    }
  }
}

/** Alice's database and a second replica of it made from a ticket, synced both ways. */
async function twoReplicas(ctx: ContractContext): Promise<[Replica, Replica]> {
  const a = replica(await ctx.create(ALICE));
  const { ticket } = await ctx.call("replicas.register", { ...a.alice, name: "Second" });
  const b = replica(await ctx.call("database.createFromTicket", { storage: ctx.storage(), principal: ALICE, ticket }));
  await pull(ctx, a, b);
  await pull(ctx, b, a);
  return [a, b];
}

/** A document edited on both replicas at once, synced both ways: in conflict on both. */
async function conflicted(ctx: ContractContext, a: Replica, b: Replica): Promise<string> {
  const { document } = await ctx.call("documents.create", { ...a.alice, content: { side: "start" } });
  await pull(ctx, a, b);
  await ctx.call("documents.save", { ...a.alice, id: document.id, ifVersion: document.version, content: { side: "a" } });
  await ctx.call("documents.save", { ...b.alice, id: document.id, ifVersion: document.version, content: { side: "b" } });
  await pull(ctx, a, b);
  await pull(ctx, b, a);
  return document.id;
}

export const ACL_CHECKS: readonly ContractCheck[] = [
  {
    capabilities: ["acl"],
    name: "the ACL is read and saved with versions, by admins only",
    async run(ctx) {
      const opened = await ctx.create(ALICE);
      const alice = { handle: opened.handle, principal: ALICE };
      const bob = { handle: opened.handle, principal: BOB };
      const { acl } = await ctx.call("acl.get", alice);
      assertEqual([acl.creators, acl.admins], [["alice"], ["alice"]], "a new database's ACL");
      assertEqual((await ctx.call("acl.get", { ...alice, ifVersion: acl.version })).acl, acl, "acl.get at its version");
      await ctx.fails("ACCESS_DENIED", "acl.get", bob);

      const { acl: saved } = await ctx.call("acl.save", { ...alice, ifVersion: acl.version, creators: ["alice", "bob"], admins: ["alice"] });
      assertEqual([saved.creators, saved.admins], [["alice", "bob"], ["alice"]], "the saved ACL");
      assert(saved.version !== acl.version, "a save gives a new version");
      assertEqual((await ctx.call("acl.get", alice)).acl, saved, "the saved ACL read back");
      await ctx.fails("STALE_DOCUMENT", "acl.get", { ...alice, ifVersion: acl.version });
      await ctx.fails("STALE_DOCUMENT", "acl.save", { ...alice, ifVersion: acl.version, creators: [], admins: ["alice"] });
      await ctx.fails("INVALID_ACCESS_LIST", "acl.save", { ...alice, ifVersion: saved.version, creators: [], admins: [] });
      await ctx.fails("ACCESS_DENIED", "acl.save", { ...bob, ifVersion: saved.version, creators: [], admins: ["bob"] });
      await ctx.fails("INVALID_INPUT", "acl.save", { ...alice, creators: [], admins: ["alice"] });
    },
  },
];

export const REPLICATION_CHECKS: readonly ContractCheck[] = [
  {
    capabilities: ["tickets", "sync", "documents"],
    name: "a replica made from a ticket fills by sync, with the same versions",
    async run(ctx) {
      const a = replica(await ctx.create(ALICE));
      const { document } = await ctx.call("documents.create", { ...a.alice, content: { n: 1, at: "2026-01-01T00:00:00.000Z" }, fieldTypes: { "/at": "datetime" } });
      const { ticket } = await ctx.call("replicas.register", a.alice);
      const b = replica(await ctx.call("database.createFromTicket", { storage: ctx.storage(), principal: ALICE, ticket }));
      assertEqual(b.databaseId, a.databaseId, "the replica's database ID");
      assert(b.instanceId !== a.instanceId, "the replica has its own instance ID");
      assertEqual((await ctx.call("documents.get", { ...b.alice, id: document.id })).document, null, "a replica holds nothing before its first sync");
      assertEqual(await ctx.call("sync.position", { ...b.alice, sourceInstanceId: a.instanceId }), { since: 0 }, "position before sync");
      assert((await pull(ctx, a, b)) > 0, "the first sync applied nothing");
      const { since } = await ctx.call("sync.position", { ...b.alice, sourceInstanceId: a.instanceId });
      assert(since > 0, "the position advances");
      const { document: copied } = await ctx.call("documents.get", { ...b.alice, id: document.id });
      assertEqual(copied && { ...copied, access: undefined }, { ...document, access: undefined }, "the document on the new replica");
      assertEqual(await pull(ctx, a, b), 0, "a second sync applies nothing new");
    },
  },
  {
    capabilities: ["tickets", "replicas"],
    name: "replicas.list shows registered replicas",
    async run(ctx) {
      const a = replica(await ctx.create(ALICE));
      const { ticket } = await ctx.call("replicas.register", { ...a.alice, name: "Laptop" });
      const { replicas } = await ctx.call("replicas.list", a.alice);
      assertEqual(replicas.length, 2, "replicas known");
      assert(replicas.some((r) => r.instanceId === a.instanceId), "the replica itself is listed");
      const added = replicas.find((r) => r.instanceId !== a.instanceId);
      assertEqual(added?.name, "Laptop", "the new replica's name");
      assertEqual(added?.instanceId, ticket["instanceId"], "the ticket's instance ID");
      assertEqual((await ctx.call("replicas.list", { handle: a.handle, principal: BOB })).replicas.length, 2, "anyone who can open the database can list replicas");
    },
  },
  {
    capabilities: ["tickets"],
    name: "tickets are for admins and are checked",
    async run(ctx) {
      const a = replica(await ctx.create(ALICE));
      await ctx.fails("ACCESS_DENIED", "replicas.register", { handle: a.handle, principal: BOB });
      await ctx.fails("INVALID_TICKET", "database.createFromTicket", { storage: ctx.storage(), principal: ALICE, ticket: {} });
      const { ticket } = await ctx.call("replicas.register", a.alice);
      const path = ctx.filePath();
      const storage = path === undefined ? ctx.storage() : { kind: "sqlite" as const, path };
      await ctx.fails("ACCESS_DENIED", "database.createFromTicket", { storage, principal: BOB, ticket });
      if (path !== undefined) {
        assert(!existsSync(path), "a refused ticket left a file");
      }
      await ctx.fails("INVALID_INPUT", "database.createFromTicket", { storage, principal: ALICE, ticket: [ticket] });
      const opened = await ctx.call("database.createFromTicket", { storage, principal: ALICE, ticket });
      assertEqual(opened.instanceId, ticket["instanceId"], "the replica opened from the ticket");
    },
  },
  {
    capabilities: ["sync"],
    name: "sync is for admins, and the engine checks what arrives",
    async run(ctx) {
      const a = replica(await ctx.create(ALICE));
      const bob = { handle: a.handle, principal: BOB };
      await ctx.fails("ACCESS_DENIED", "sync.hello", bob);
      await ctx.fails("ACCESS_DENIED", "sync.export", { ...bob, since: 0 });
      await ctx.fails("ACCESS_DENIED", "sync.position", { ...bob, sourceInstanceId: a.instanceId });
      await ctx.fails("INVALID_BATCH", "sync.apply", { ...a.alice, batch: {} });
      await ctx.fails("INVALID_HANDSHAKE", "sync.checkPeer", { ...a.alice, hello: {} });
      await ctx.fails("INVALID_INPUT", "sync.export", { ...a.alice, since: -1 });
      await ctx.fails("INVALID_INPUT", "sync.apply", { ...a.alice, batch: [] });

      const other = replica(await ctx.create(ALICE));
      const { batch } = await ctx.call("sync.export", { ...other.alice, since: 0 });
      await ctx.fails("SYNC_MISMATCH", "sync.apply", { ...a.alice, batch });
      const { hello } = await ctx.call("sync.hello", other.alice);
      await ctx.fails("SYNC_MISMATCH", "sync.checkPeer", { ...a.alice, hello });
      const own = await ctx.call("sync.hello", a.alice);
      await ctx.fails("SYNC_MISMATCH", "sync.checkPeer", { ...a.alice, hello: own.hello as JsonObject });
    },
  },
  {
    capabilities: ["conflicts", "tickets", "sync", "documents"],
    name: "concurrent edits become a conflict, resolved with one version",
    async run(ctx) {
      const [a, b] = await twoReplicas(ctx);
      const id = await conflicted(ctx, a, b);
      const { conflict } = await ctx.call("conflicts.get", { ...a.alice, id });
      assert(conflict !== null, "no conflict after concurrent edits");
      assertEqual(conflict.primaryId, id, "primaryId");
      assertEqual(conflict.versions.length, 2, "versions");
      assertEqual(conflict.versions.filter((v) => v.isPrimary).length, 1, "one primary");
      assertEqual(conflict.versions.map((v) => v.document.content["side"]).sort(), ["a", "b"], "both edits kept");
      const onB = (await ctx.call("conflicts.get", { ...b.alice, id })).conflict;
      assertEqual(onB?.version, conflict.version, "the conflict's version on the other replica");
      assertEqual((await ctx.call("documents.find", { ...a.alice, limit: 10, filter: { inConflict: true } })).documents.map((d) => d.id), [id], "find inConflict");

      const loser = conflict.versions.find((v) => !v.isPrimary);
      assert(loser !== undefined, "a version that isn't the primary");
      const { document: readOnly } = await ctx.call("documents.get", { ...a.alice, id: loser.document.id });
      assertEqual(readOnly?.access, { read: true, update: false, delete: false }, "a conflict version is read-only");
      await ctx.fails("READ_ONLY", "documents.save", { ...a.alice, id: loser.document.id, ifVersion: loser.document.version, content: {} });

      await ctx.fails("NOT_FOUND", "conflicts.resolveWith", { ...a.alice, id, conflictVersion: conflict.version, chosenId: "no-such-version" });
      const result = await ctx.call("conflicts.resolveWith", { ...a.alice, id, conflictVersion: conflict.version, chosenId: loser.document.id });
      assertEqual(result, { editedThroughConflict: false }, "resolveWith");
      assertEqual((await ctx.call("documents.get", { ...a.alice, id })).document?.content, loser.document.content, "the chosen version is the document");
      assertEqual((await ctx.call("conflicts.get", { ...a.alice, id })).conflict, null, "resolved");
      await ctx.fails("STALE_DOCUMENT", "conflicts.resolveWith", { ...a.alice, id, conflictVersion: conflict.version, chosenId: loser.document.id });
      await ctx.fails("STALE_DOCUMENT", "conflicts.get", { ...a.alice, id, ifVersion: conflict.version });
    },
  },
  {
    capabilities: ["conflicts", "tickets", "sync", "documents"],
    name: "a conflict is resolved with new content, or by deleting",
    async run(ctx) {
      const [a, b] = await twoReplicas(ctx);
      const first = await conflicted(ctx, a, b);
      const second = await conflicted(ctx, a, b);

      const one = (await ctx.call("conflicts.get", { ...a.alice, id: first })).conflict;
      assert(one !== null, "no conflict");
      await ctx.fails("INVALID_INPUT", "conflicts.resolveWithContent", { ...a.alice, id: first, conflictVersion: one.version, content: { at: 1 }, fieldTypes: { "/at": "datetime" } });
      const merged = await ctx.call("conflicts.resolveWithContent", {
        ...a.alice,
        id: first,
        conflictVersion: one.version,
        content: { side: "both", at: "2026-02-03T04:05:06.007Z" },
        fieldTypes: { "/at": "datetime" },
        readers: ["alice"],
      });
      assertEqual(merged, { editedThroughConflict: false }, "resolveWithContent");
      const { document } = await ctx.call("documents.get", { ...a.alice, id: first });
      assertEqual(
        document && { content: document.content, fieldTypes: document.fieldTypes, readers: document.readers },
        { content: { side: "both", at: "2026-02-03T04:05:06.007Z" }, fieldTypes: { "/at": "datetime" }, readers: ["alice"] },
        "the merged document",
      );

      const two = (await ctx.call("conflicts.get", { ...b.alice, id: second })).conflict;
      assert(two !== null, "no conflict");
      assertEqual(await ctx.call("conflicts.resolveByDeleting", { ...b.alice, id: second, conflictVersion: two.version }), { editedThroughConflict: false }, "resolveByDeleting");
      assertEqual((await ctx.call("documents.get", { ...b.alice, id: second })).document, null, "deleted");
      await pull(ctx, a, b);
      await pull(ctx, b, a);
      assertEqual((await ctx.call("documents.get", { ...a.alice, id: second })).document, null, "deleted on the other replica too");
      assertEqual((await ctx.call("documents.find", { ...a.alice, limit: 10, filter: { inConflict: true } })).documents, [], "nothing in conflict");
    },
  },
  {
    capabilities: ["conflicts", "tickets", "sync", "documents"],
    name: "unreadable conflict versions stay in conflict",
    async run(ctx) {
      const [a, b] = await twoReplicas(ctx);
      const bob = { handle: a.handle, principal: BOB };
      const { document } = await ctx.call("documents.create", { ...a.alice, content: { side: "start" } });
      await pull(ctx, a, b);
      // Two edits on a against one on b, so a's version is the primary on both.
      const first = await ctx.call("documents.save", { ...a.alice, id: document.id, ifVersion: document.version, content: { side: "a1" } });
      await ctx.call("documents.save", { ...a.alice, id: document.id, ifVersion: first.document.version, content: { side: "a" } });
      await ctx.call("documents.save", { ...b.alice, id: document.id, ifVersion: document.version, content: { side: "hidden" }, readers: ["alice"] });
      await pull(ctx, a, b);
      await pull(ctx, b, a);

      const all = (await ctx.call("conflicts.get", { ...a.alice, id: document.id })).conflict;
      assert(all !== null, "no conflict after concurrent edits");
      assertEqual(all.versions.map((v) => [v.isPrimary, v.document.content["side"]]), [[true, "a"], [false, "hidden"]], "alice's versions");
      const hidden = all.versions[1]?.document;
      assert(hidden !== undefined, "the version bob can't read");

      const seen = (await ctx.call("conflicts.get", { ...bob, id: document.id })).conflict;
      assert(seen !== null, "bob reads the primary, so he sees the conflict");
      assertEqual(seen.versions.map((v) => v.document.content["side"]), ["a"], "bob's versions");
      assertEqual(seen.version, all.version, "the conflict's version covers every version, as the engine gives it");
      const shown = JSON.stringify(seen);
      assert(!shown.includes(hidden.id) && !shown.includes(hidden.version) && !shown.includes("hidden"), `bob was shown the version he can't read: ${shown}`);
      assertEqual((await ctx.call("documents.get", { ...bob, id: hidden.id })).document, null, "documents.get of the unreadable version, for bob");

      const primary = seen.versions[0]?.document;
      assert(primary !== undefined, "the primary");
      const result = await ctx.call("conflicts.resolveWith", { ...bob, id: document.id, conflictVersion: seen.version, chosenId: primary.id });
      assertEqual(result, { editedThroughConflict: true }, "bob's resolve leaves the version he can't read");

      const after = (await ctx.call("conflicts.get", { ...a.alice, id: document.id })).conflict;
      assert(after !== null, "the document is still in conflict");
      assertEqual(after.versions.length, 2, "versions after bob's resolve");
      assertEqual(after.versions.find((v) => !v.isPrimary)?.document, hidden, "the unreadable version, untouched");
      assertEqual((await ctx.call("documents.find", { ...a.alice, limit: 10, filter: { inConflict: true } })).documents.map((d) => d.id), [document.id], "find inConflict");

      const resolved = await ctx.call("conflicts.resolveWith", { ...a.alice, id: document.id, conflictVersion: after.version, chosenId: hidden.id });
      assertEqual(resolved, { editedThroughConflict: false }, "alice reads every version, so her resolve ends the conflict");
      assertEqual((await ctx.call("documents.get", { ...a.alice, id: document.id })).document?.content, { side: "hidden" }, "the version alice chose");
      assertEqual((await ctx.call("conflicts.get", { ...a.alice, id: document.id })).conflict, null, "resolved");
    },
  },
];
