import { existsSync } from "node:fs";
import type { OperationName } from "../operations.js";
import { assert, assertEqual, type ContractContext } from "./context.js";
import type { ContractCheck } from "./index.js";
import { conflicted, pull, replica, twoReplicas, type Replica } from "./replication.js";

const ALICE = { id: "alice" };
const BOB = { id: "bob" };

/** Alice's database, with bob as a reader only. */
async function withReader(ctx: ContractContext) {
  const opened = await ctx.create(ALICE);
  const alice = { handle: opened.handle, principal: ALICE };
  const bob = { handle: opened.handle, principal: BOB };
  await ctx.setAcl(alice, { readers: ["alice", "bob"] });
  return { opened, alice, bob };
}

/** Everything a principal can read of a database, for comparing before and after. */
async function snapshot(ctx: ContractContext, on: Replica, conflictId: string, other: string) {
  const documents = [];
  let after: string | undefined;
  do {
    const page = await ctx.call("documents.find", { ...on.alice, limit: 2, ...(after === undefined ? {} : { after }) });
    documents.push(...page.documents);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return {
    documents,
    conflict: (await ctx.call("conflicts.get", { ...on.alice, id: conflictId })).conflict,
    acl: (await ctx.call("acl.get", on.alice)).acl,
    settings: (await ctx.call("settings.get", on.alice)).settings,
    position: await ctx.call("sync.position", { ...on.alice, sourceInstanceId: other }),
    state: await ctx.call("sync.state", on.alice),
  };
}

export const PURGE_CHECKS: readonly ContractCheck[] = [
  {
    capabilities: ["purge"],
    name: "a new database has nothing to purge and isn't stale",
    async run(ctx) {
      const opened = await ctx.create(ALICE);
      const alice = { handle: opened.handle, principal: ALICE };
      assertEqual(await ctx.call("sync.state", alice), { stale: false, purgedThrough: 0 }, "sync.state of a new database");
      const result = await ctx.call("database.purge", alice);
      assertEqual([result.tombstones, result.horizon], [0, 0], "tombstones and horizon purged from a new database");
      assertEqual(await ctx.call("sync.state", alice), { stale: false, purgedThrough: 0 }, "sync.state after purge");
      await ctx.fails("ACCESS_DENIED", "sync.state", { handle: opened.handle, principal: BOB });
    },
  },
  {
    capabilities: ["purge", "acl"],
    name: "purge and settings.save are for admins; settings.get for anyone admitted",
    async run(ctx) {
      const { alice, bob } = await withReader(ctx);
      await ctx.fails("ACCESS_DENIED", "database.purge", bob);
      await ctx.fails("ACCESS_DENIED", "settings.save", { ...bob, settings: { purgeAfterDays: 7 } });
      assertEqual(await ctx.call("settings.get", bob), { settings: { purgeAfterDays: 90 } }, "settings.get by a reader");
      assertEqual(await ctx.call("sync.state", bob), { stale: false, purgedThrough: 0 }, "sync.state by a reader");
      await ctx.fails("ACCESS_DENIED", "settings.get", { handle: alice.handle, principal: { id: "carol" } });
      assertEqual(await ctx.call("settings.get", alice), { settings: { purgeAfterDays: 90 } }, "settings, unchanged by refused saves");
    },
  },
  {
    capabilities: ["purge"],
    name: "settings are saved and read back, and checked",
    async run(ctx) {
      const opened = await ctx.create(ALICE);
      const alice = { handle: opened.handle, principal: ALICE };
      assertEqual(await ctx.call("settings.get", alice), { settings: { purgeAfterDays: 90 } }, "a new database's settings");
      assertEqual(await ctx.call("settings.save", { ...alice, settings: { purgeAfterDays: 7 } }), { settings: { purgeAfterDays: 7 } }, "settings.save");
      assertEqual(await ctx.call("settings.get", alice), { settings: { purgeAfterDays: 7 } }, "the saved settings");
      for (const days of [0, 3651, 1.5, -1, "7", null]) {
        await ctx.fails("INVALID_INPUT", "settings.save", { ...alice, settings: { purgeAfterDays: days } }, { path: "/settings/purgeAfterDays" });
      }
      await ctx.fails("INVALID_INPUT", "settings.save", { ...alice, settings: {} });
      await ctx.fails("INVALID_INPUT", "settings.save", { ...alice, settings: { purgeAfterDays: 7, other: 1 } });
      await ctx.fails("INVALID_INPUT", "settings.save", alice);
      assertEqual(await ctx.call("settings.save", { ...alice, settings: { purgeAfterDays: 3650 } }), { settings: { purgeAfterDays: 3650 } }, "the largest");
      assertEqual(await ctx.call("settings.save", { ...alice, settings: { purgeAfterDays: 1 } }), { settings: { purgeAfterDays: 1 } }, "the smallest");
    },
  },
  {
    capabilities: ["purge", "tickets", "sync", "documents"],
    name: "purge removes superseded entries and keeps the latest versions",
    async run(ctx) {
      const a = replica(await ctx.create(ALICE));
      let { document } = await ctx.call("documents.create", { ...a.alice, content: { n: 0 } });
      for (let n = 1; n <= 3; n++) {
        ({ document } = await ctx.call("documents.save", { ...a.alice, id: document.id, ifVersion: document.version, content: { n } }));
      }
      const result = await ctx.call("database.purge", a.alice);
      assert(result.entries >= 3, `purge removed ${result.entries} entries; three saves superseded at least three`);
      assertEqual([result.tombstones, result.horizon], [0, 0], "tombstones and horizon, with nothing deleted");
      assertEqual((await ctx.call("database.purge", a.alice)).entries, 0, "a second purge finds nothing more");
      const { ticket } = await ctx.call("replicas.register", a.alice);
      const b = replica(await ctx.call("database.createFromTicket", { storage: ctx.storage(), principal: ALICE, ticket }));
      await pull(ctx, a, b);
      const { document: copied } = await ctx.call("documents.get", { ...b.alice, id: document.id });
      assertEqual(copied && { ...copied, access: undefined }, { ...document, access: undefined }, "the latest version on a new replica");
    },
  },
  {
    capabilities: ["purge", "tickets", "sync", "documents"],
    name: "a deletion made just now isn't purged, and still replicates",
    async run(ctx) {
      const [a, b] = await twoReplicas(ctx);
      const { document } = await ctx.call("documents.create", { ...a.alice, content: { n: 1 } });
      await pull(ctx, a, b);
      assert((await ctx.call("documents.get", { ...b.alice, id: document.id })).document !== null, "the document reached the replica");
      await ctx.call("documents.delete", { ...a.alice, id: document.id, ifVersion: document.version });
      const result = await ctx.call("database.purge", a.alice);
      assertEqual([result.tombstones, result.horizon], [0, 0], "a new tombstone purged");
      await pull(ctx, a, b);
      assertEqual((await ctx.call("documents.get", { ...b.alice, id: document.id })).document, null, "the deletion on the replica");
      assertEqual(await ctx.call("sync.state", b.alice), { stale: false, purgedThrough: 0 }, "the replica's sync.state");
    },
  },
  {
    capabilities: ["purge", "tickets", "sync", "replicas"],
    name: "replicas.list says how far each other replica is known",
    async run(ctx) {
      const [a, b] = await twoReplicas(ctx);
      for (const [on, self, other] of [
        [a, a.instanceId, b.instanceId],
        [b, b.instanceId, a.instanceId],
      ] as const) {
        const { replicas } = await ctx.call("replicas.list", on.alice);
        const own = replicas.find((entry) => entry.instanceId === self);
        const theirs = replicas.find((entry) => entry.instanceId === other);
        assert(own !== undefined && theirs !== undefined, "both replicas are listed");
        assertEqual(own.knownThrough, undefined, "knownThrough for the replica asked");
        assert(typeof theirs.knownThrough === "number" && theirs.knownThrough >= 0, `knownThrough for the other replica is ${JSON.stringify(theirs.knownThrough)}`);
      }
      // b has pulled everything a had, so a's log is known on b as far as a's position.
      const { since } = await ctx.call("sync.position", { ...b.alice, sourceInstanceId: a.instanceId });
      const onB = (await ctx.call("replicas.list", b.alice)).replicas.find((entry) => entry.instanceId === a.instanceId);
      assertEqual(onB?.knownThrough, since, "knownThrough of the source after a complete pull");
    },
  },
];

export const COMPACT_CHECKS: readonly ContractCheck[] = [
  {
    capabilities: ["compact", "purge", "tickets", "sync", "conflicts", "documents", "acl"],
    name: "compact keeps everything",
    async run(ctx) {
      const [a, b] = await twoReplicas(ctx);
      const id = await conflicted(ctx, a, b);
      const { document } = await ctx.call("documents.create", { ...a.alice, content: { gone: true } });
      await ctx.call("documents.delete", { ...a.alice, id: document.id, ifVersion: document.version });
      await ctx.call("settings.save", { ...a.alice, settings: { purgeAfterDays: 30 } });
      await ctx.call("database.purge", a.alice);
      const before = await snapshot(ctx, a, id, b.instanceId);
      assertEqual(await ctx.call("database.compact", { handle: a.handle }), {}, "database.compact");
      assertEqual(await snapshot(ctx, a, id, b.instanceId), before, "the database after compact");
      // Sync still works after compact, and brings nothing new: only the
      // position moves, past what a's own last changes sent back.
      await pull(ctx, a, b);
      assertEqual(await pull(ctx, b, a), 0, "changes applied by a sync after compact");
      assertEqual({ ...(await snapshot(ctx, a, id, b.instanceId)), position: undefined }, { ...before, position: undefined }, "the database after compact and sync");
    },
  },
  {
    capabilities: ["compact", "documents"],
    name: "calls made while compact runs wait for it and succeed",
    async run(ctx) {
      const opened = await ctx.create(ALICE);
      const alice = { handle: opened.handle, principal: ALICE };
      const made = [];
      for (let n = 0; n < 4; n++) {
        made.push((await ctx.call("documents.create", { ...alice, content: { n } })).document);
      }
      const [first, second] = made;
      assert(first !== undefined && second !== undefined, "four documents made");
      const [got, compacted, saved, again, found] = await Promise.all([
        ctx.call("documents.get", { ...alice, id: first.id }),
        ctx.call("database.compact", { handle: opened.handle }),
        ctx.call("documents.save", { ...alice, id: second.id, ifVersion: second.version, content: { n: 10 } }),
        ctx.call("database.compact", { handle: opened.handle }),
        ctx.call("documents.find", { ...alice, limit: 100 }),
      ]);
      assertEqual([compacted, again], [{}, {}], "both compacts");
      assertEqual(got.document?.version, first.version, "a document read while compact runs");
      assertEqual(saved.document.content, { n: 10 }, "a document saved while compact runs");
      assertEqual(found.documents.map((doc) => doc.id).sort(), made.map((doc) => doc.id).sort(), "documents found while compact runs");
      const { document: read } = await ctx.call("documents.get", { ...alice, id: second.id });
      assertEqual(read?.version, saved.document.version, "the saved document afterwards");
    },
  },
  {
    capabilities: ["compact"],
    name: "compact on a closed handle is UNKNOWN_HANDLE",
    async run(ctx) {
      const { handle } = await ctx.create(ALICE);
      await ctx.call("database.close", { handle });
      await ctx.fails("UNKNOWN_HANDLE", "database.compact", { handle });
      await ctx.fails("UNKNOWN_HANDLE", "database.compact", { handle: "no-such-handle" });
    },
  },
];

export const RAISE_CHECKS: readonly ContractCheck[] = [
  {
    capabilities: ["raise", "documents"],
    name: "database.raise opens a database already at a level it serves, unchanged",
    async run(ctx) {
      const path = ctx.filePath();
      if (path === undefined) {
        return;
      }
      const storage = { kind: "sqlite" as const, path };
      const created = await ctx.call("database.create", { storage, principal: ALICE });
      const { document } = await ctx.call("documents.create", { handle: created.handle, principal: ALICE, content: { n: 1 } });
      await ctx.call("database.close", { handle: created.handle });
      const raised = await ctx.call("database.raise", { storage, principal: ALICE });
      assertEqual(
        { databaseId: raised.databaseId, instanceId: raised.instanceId, level: raised.level, raisedFrom: raised.raisedFrom },
        { databaseId: created.databaseId, instanceId: created.instanceId, level: created.level, raisedFrom: created.level },
        "database.raise of a database at a level it serves",
      );
      const { document: read } = await ctx.call("documents.get", { handle: raised.handle, principal: ALICE, id: document.id });
      assertEqual(read?.version, document.version, "the document's version after database.raise");
      await ctx.fails("ALREADY_OPEN", "database.raise", { storage, principal: ALICE });
      await ctx.fails("ALREADY_OPEN", "database.open", { storage });
      await ctx.call("database.close", { handle: raised.handle });
      await ctx.call("database.close", { handle: (await ctx.call("database.open", { storage })).handle });
    },
  },
  {
    capabilities: ["raise"],
    name: "database.raise never creates a database, and checks its input",
    async run(ctx) {
      const path = ctx.filePath();
      if (path !== undefined) {
        await ctx.fails("NO_DATABASE", "database.raise", { storage: { kind: "sqlite", path }, principal: ALICE });
        assert(!existsSync(path), "database.raise made a file");
      }
      if (ctx.info.storage.includes("memory")) {
        await ctx.fails("NO_DATABASE", "database.raise", { storage: { kind: "memory" }, principal: ALICE });
      }
      const op: OperationName = "database.raise";
      await ctx.fails("INVALID_INPUT", op, { storage: { kind: "memory" } });
      await ctx.fails("INVALID_INPUT", op, { principal: ALICE });
      await ctx.fails("INVALID_INPUT", op, { storage: { kind: "memory" }, principal: ALICE, extra: 1 });
    },
  },
];
