import { copyFileSync, existsSync } from "node:fs";
import type { OperationName, Storage, SuspectData } from "../operations.js";
import { assert, assertEqual, type ContractContext } from "./context.js";
import type { ContractCheck } from "./index.js";
import { pull, replica, twoReplicas, type Replica } from "./replication.js";

const ALICE = { id: "alice" };
const BOB = { id: "bob" };
const UNKNOWN_REPLICA = "2f6f0c4e-4d7b-4a3e-9a9e-0b1c2d3e4f50";

function file(path: string): Storage {
  return { kind: "sqlite", path };
}

/**
 * a, and b made from a's ticket in a file, which then goes its own way: it
 * makes a document only it has and edits one both had, and is closed. n is a
 * new replica of a, up to date with it. undefined if the driver handles no
 * files.
 */
async function oldCopy(ctx: ContractContext) {
  const path = ctx.filePath();
  if (path === undefined) {
    return undefined;
  }
  const a = replica(await ctx.create(ALICE));
  const b = replica(await ctx.call("database.createFromTicket", { storage: file(path), principal: ALICE, ticket: (await ctx.call("replicas.register", a.alice)).ticket }));
  const { document: shared } = await ctx.call("documents.create", { ...a.alice, content: { n: "shared" } });
  await pull(ctx, a, b);
  const { document: onlyB } = await ctx.call("documents.create", { ...b.alice, content: { only: "b" } });
  await ctx.call("documents.save", { ...b.alice, id: shared.id, ifVersion: shared.version, content: { n: "edited on b" } });
  await ctx.call("database.close", { handle: b.handle });
  const n = replica(await ctx.call("database.createFromTicket", { storage: ctx.storage(), principal: ALICE, ticket: (await ctx.call("replicas.register", a.alice)).ticket }));
  await pull(ctx, a, n);
  return { a, n, from: file(path), old: b.instanceId, onlyB: onlyB.id, shared: shared.id };
}

/** Every pending suspect on the replica, a page of one at a time. */
async function allSuspects(ctx: ContractContext, on: Replica): Promise<SuspectData[]> {
  const found: SuspectData[] = [];
  let after: string | undefined;
  for (let pages = 0; ; pages++) {
    assert(pages < 100, "suspects.list never ended");
    const page = await ctx.call("suspects.list", { ...on.alice, limit: 1, ...(after === undefined ? {} : { after }) });
    found.push(...page.suspects);
    if (page.next === null) {
      return found;
    }
    after = page.next;
  }
}

function byDocument(suspects: readonly SuspectData[]): Map<string, SuspectData> {
  return new Map(suspects.map((suspect) => [suspect.documentId, suspect]));
}

export const BACKUP_CHECKS: readonly ContractCheck[] = [
  {
    capabilities: ["backup", "documents", "purge", "sync"],
    name: "database.backup makes a backup that reads, but takes no writes and doesn't sync",
    async run(ctx) {
      const path = ctx.filePath();
      if (path === undefined) {
        return;
      }
      const a = replica(await ctx.create(ALICE));
      const { document } = await ctx.call("documents.create", { ...a.alice, content: { n: 1 } });
      assertEqual(await ctx.call("database.backup", { ...a.alice, target: file(path) }), {}, "database.backup");
      const { document: later } = await ctx.call("documents.create", { ...a.alice, content: { n: 2 } });
      const opened = await ctx.call("database.open", { storage: file(path) });
      assertEqual([opened.databaseId, opened.instanceId], [a.databaseId, a.instanceId], "the backup's database and instance IDs");
      const backup = { handle: opened.handle, principal: ALICE };
      assertEqual((await ctx.call("documents.get", { ...backup, id: document.id })).document?.content, { n: 1 }, "a document in the backup");
      assertEqual((await ctx.call("documents.get", { ...backup, id: later.id })).document, null, "a document made after the backup");
      assertEqual(
        await ctx.call("sync.state", backup),
        { stale: false, purgedThrough: 0, backupOf: a.instanceId, rewound: false, retired: false },
        "the backup's sync.state",
      );
      await ctx.fails("READ_ONLY", "documents.create", { ...backup, content: { n: 3 } });
      await ctx.fails("SYNC_MISMATCH", "sync.hello", backup);
      assertEqual(await ctx.call("sync.state", a.alice), { stale: false, purgedThrough: 0, rewound: false, retired: false }, "the backed-up database's sync.state");
    },
  },
  {
    capabilities: ["backup", "acl"],
    name: "database.backup is for admins, into empty storage it opens and closes itself",
    async run(ctx) {
      const path = ctx.filePath();
      const other = ctx.filePath();
      if (path === undefined || other === undefined) {
        return;
      }
      const opened = await ctx.create(ALICE);
      const alice = { handle: opened.handle, principal: ALICE };
      await ctx.setAcl(alice, { readers: ["alice", "bob"] });
      await ctx.fails("ACCESS_DENIED", "database.backup", { handle: opened.handle, principal: BOB, target: file(path) });
      assert(!existsSync(path), "a refused backup left a file");
      await ctx.fails("NOT_SUPPORTED", "database.backup", { ...alice, target: { kind: "memory" } });
      const busy = await ctx.call("database.create", { storage: file(other), principal: ALICE });
      await ctx.fails("ALREADY_OPEN", "database.backup", { ...alice, target: file(other) });
      await ctx.call("database.close", { handle: busy.handle });
      await ctx.fails("ALREADY_EXISTS", "database.backup", { ...alice, target: file(other) });
      await ctx.call("database.backup", { ...alice, target: file(path) });
      // The backup was closed again, so it can be opened.
      await ctx.call("database.close", { handle: (await ctx.call("database.open", { storage: file(path) })).handle });
      const op: OperationName = "database.backup";
      await ctx.fails("INVALID_INPUT", op, alice);
      await ctx.fails("INVALID_INPUT", op, { ...alice, target: file(path), extra: 1 });
    },
  },
  {
    capabilities: ["backup", "documents", "replicas", "purge"],
    name: "database.adopt makes a backup a writable replica with a new instance ID, and retires the old one",
    async run(ctx) {
      const path = ctx.filePath();
      if (path === undefined) {
        return;
      }
      const a = replica(await ctx.create(ALICE));
      const { document } = await ctx.call("documents.create", { ...a.alice, content: { n: 1 } });
      await ctx.call("database.backup", { ...a.alice, target: file(path) });
      const adopted = await ctx.call("database.adopt", { storage: file(path), principal: ALICE });
      assert(adopted.instanceId !== a.instanceId, "the adopted replica kept the backed-up replica's instance ID");
      assertEqual([adopted.databaseId, adopted.retired], [a.databaseId, a.instanceId], "the adopted replica's database and the replica it retired");
      const on = { handle: adopted.handle, principal: ALICE };
      assertEqual((await ctx.call("documents.get", { ...on, id: document.id })).document?.content, { n: 1 }, "a document in the adopted replica");
      await ctx.call("documents.create", { ...on, content: { n: 2 } });
      assertEqual(await ctx.call("sync.state", on), { stale: false, purgedThrough: 0, rewound: false, retired: false }, "the adopted replica's sync.state");
      const { replicas } = await ctx.call("replicas.list", on);
      const listed = Object.fromEntries(replicas.map((entry) => [entry.instanceId, [entry.status, entry.introducedBy ?? null]]));
      assertEqual(listed, { [a.instanceId]: ["retired", null], [adopted.instanceId]: ["active", a.instanceId] }, "the adopted replica's replicas");
      await ctx.fails("ALREADY_OPEN", "database.adopt", { storage: file(path), principal: ALICE });
      await ctx.call("database.close", { handle: adopted.handle });
      const reopened = await ctx.call("database.open", { storage: file(path) });
      assertEqual(reopened.instanceId, adopted.instanceId, "the adopted replica's instance ID, opened again");
    },
  },
  {
    capabilities: ["backup", "acl", "documents"],
    name: "database.adopt refuses what isn't a backup, and non-admins, writing nothing",
    async run(ctx) {
      const plain = ctx.filePath();
      const path = ctx.filePath();
      const missing = ctx.filePath();
      if (plain === undefined || path === undefined || missing === undefined) {
        return;
      }
      const made = await ctx.call("database.create", { storage: file(plain), principal: ALICE });
      await ctx.call("database.close", { handle: made.handle });
      await ctx.fails("NOT_SUPPORTED", "database.adopt", { storage: file(plain), principal: ALICE });
      const plainAgain = await ctx.call("database.open", { storage: file(plain) });
      assertEqual(plainAgain.instanceId, made.instanceId, "a database refused adoption, opened again");
      await ctx.call("database.close", { handle: plainAgain.handle });

      const opened = await ctx.create(ALICE);
      const alice = { handle: opened.handle, principal: ALICE };
      await ctx.setAcl(alice, { readers: ["alice", "bob"] });
      await ctx.call("database.backup", { ...alice, target: file(path) });
      await ctx.fails("ACCESS_DENIED", "database.adopt", { storage: file(path), principal: BOB });
      const still = await ctx.call("database.open", { storage: file(path) });
      assertEqual(still.instanceId, opened.instanceId, "a backup refused adoption, opened again");
      await ctx.fails("READ_ONLY", "documents.create", { handle: still.handle, principal: ALICE, content: { n: 1 } });
      await ctx.call("database.close", { handle: still.handle });

      await ctx.fails("NO_DATABASE", "database.adopt", { storage: file(missing), principal: ALICE });
      assert(!existsSync(missing), "database.adopt made a file");
      await ctx.fails("INVALID_INPUT", "database.adopt", { storage: file(path) });
    },
  },
];

export const RECOVER_CHECKS: readonly ContractCheck[] = [
  {
    capabilities: ["recover", "tickets", "sync", "documents"],
    name: "database.recover keeps the versions only an old copy had as suspects, listed and found by key",
    async run(ctx) {
      const setup = await oldCopy(ctx);
      if (setup === undefined) {
        return;
      }
      const { n, from, old, onlyB, shared } = setup;
      assertEqual(await ctx.call("database.recover", { ...n.alice, from }), { suspects: 2, known: 0, seen: 0 }, "database.recover");
      const suspects = await allSuspects(ctx, n);
      const found = byDocument(suspects);
      assertEqual(suspects.length, 2, "suspects listed");
      assertEqual([found.get(onlyB)?.reason, found.get(shared)?.reason], ["absent", "concurrent"], "the suspects' reasons");
      assertEqual([found.get(onlyB)?.document.content, found.get(shared)?.document.content], [{ only: "b" }, { n: "edited on b" }], "the suspects' content");
      assertEqual(found.get(onlyB)?.current, null, "current for a document absent here");
      assert(typeof found.get(shared)?.current === "string", "current for a document here is its version");
      assert(suspects.every((suspect) => suspect.from === old), "every suspect is from the old copy");
      for (const suspect of suspects) {
        assertEqual((await ctx.call("suspects.get", { ...n.alice, key: suspect.key })).suspect, suspect, "suspects.get of a listed suspect");
      }
      assertEqual((await ctx.call("documents.get", { ...n.alice, id: onlyB })).document, null, "a suspect's document, before it is accepted");
      assertEqual(await ctx.call("database.recover", { ...n.alice, from }), { suspects: 0, known: 0, seen: 2 }, "database.recover again");
      assertEqual((await ctx.call("suspects.list", { ...n.alice, limit: 10 })).suspects.length, 2, "suspects after recovering again");
    },
  },
  {
    capabilities: ["recover", "tickets", "sync", "documents"],
    name: "a suspect is accepted, or accepted with content, as a write that replicates",
    async run(ctx) {
      const setup = await oldCopy(ctx);
      if (setup === undefined) {
        return;
      }
      const { a, n, from, onlyB, shared } = setup;
      await ctx.call("database.recover", { ...n.alice, from });
      const found = byDocument(await allSuspects(ctx, n));
      const absent = found.get(onlyB);
      const concurrent = found.get(shared);
      assert(absent !== undefined && concurrent !== undefined && concurrent.current !== null, "both suspects found");
      assertEqual(await ctx.call("suspects.accept", { ...n.alice, key: absent.key }), { editedThroughConflict: false }, "suspects.accept");
      assertEqual((await ctx.call("documents.get", { ...n.alice, id: onlyB })).document?.content, { only: "b" }, "an accepted suspect's document");
      assertEqual((await ctx.call("suspects.get", { ...n.alice, key: absent.key })).suspect, null, "suspects.get once accepted");
      await ctx.fails("NOT_FOUND", "suspects.accept", { ...n.alice, key: absent.key });
      await ctx.fails("STALE_DOCUMENT", "suspects.accept", { ...n.alice, key: concurrent.key, ifVersion: "not the version" });
      await ctx.call("suspects.acceptWithContent", { ...n.alice, key: concurrent.key, ifVersion: concurrent.current, content: { n: "merged" } });
      assertEqual((await ctx.call("documents.get", { ...n.alice, id: shared })).document?.content, { n: "merged" }, "a suspect accepted with content");
      assertEqual((await ctx.call("suspects.list", { ...n.alice, limit: 10 })).suspects, [], "suspects once both are decided");
      await pull(ctx, n, a);
      assertEqual((await ctx.call("documents.get", { ...a.alice, id: onlyB })).document?.content, { only: "b" }, "the accepted document, on another replica");
      assertEqual((await ctx.call("documents.get", { ...a.alice, id: shared })).document?.content, { n: "merged" }, "the merged document, on another replica");
    },
  },
  {
    capabilities: ["recover", "tickets", "sync", "documents"],
    name: "a discarded suspect writes nothing and is never offered again",
    async run(ctx) {
      const setup = await oldCopy(ctx);
      if (setup === undefined) {
        return;
      }
      const { n, from, onlyB, shared } = setup;
      await ctx.call("database.recover", { ...n.alice, from });
      const before = (await ctx.call("documents.get", { ...n.alice, id: shared })).document;
      for (const suspect of await allSuspects(ctx, n)) {
        assertEqual(await ctx.call("suspects.discard", { ...n.alice, key: suspect.key }), {}, "suspects.discard");
        await ctx.fails("NOT_FOUND", "suspects.discard", { ...n.alice, key: suspect.key });
      }
      assertEqual((await ctx.call("suspects.list", { ...n.alice, limit: 10 })).suspects, [], "suspects once discarded");
      assertEqual((await ctx.call("documents.get", { ...n.alice, id: onlyB })).document, null, "a discarded suspect's document");
      assertEqual((await ctx.call("documents.get", { ...n.alice, id: shared })).document, before, "a document whose suspect was discarded");
      assertEqual((await ctx.call("database.recover", { ...n.alice, from })).suspects, 0, "new suspects from recovering again");
      assertEqual((await ctx.call("suspects.list", { ...n.alice, limit: 10 })).suspects, [], "suspects after recovering again");
    },
  },
  {
    capabilities: ["recover", "acl", "tickets", "sync", "documents"],
    name: "recover and suspects are for admins, from another copy of this database",
    async run(ctx) {
      const setup = await oldCopy(ctx);
      const other = ctx.filePath();
      const missing = ctx.filePath();
      if (setup === undefined || other === undefined || missing === undefined) {
        return;
      }
      const { n, from } = setup;
      await ctx.setAcl(n.alice, { readers: ["alice", "bob"] });
      const bob = { handle: n.handle, principal: BOB };
      await ctx.fails("ACCESS_DENIED", "database.recover", { ...bob, from });
      await ctx.call("database.recover", { ...n.alice, from });
      const [suspect] = await allSuspects(ctx, n);
      assert(suspect !== undefined, "a suspect found");
      await ctx.fails("ACCESS_DENIED", "suspects.list", { ...bob, limit: 10 });
      await ctx.fails("ACCESS_DENIED", "suspects.get", { ...bob, key: suspect.key });
      await ctx.fails("ACCESS_DENIED", "suspects.discard", { ...bob, key: suspect.key });

      const another = await ctx.call("database.create", { storage: file(other), principal: ALICE });
      await ctx.fails("ALREADY_OPEN", "database.recover", { ...n.alice, from: file(other) });
      await ctx.call("database.close", { handle: another.handle });
      await ctx.fails("SYNC_MISMATCH", "database.recover", { ...n.alice, from: file(other) });
      await ctx.fails("NO_DATABASE", "database.recover", { ...n.alice, from: file(missing) });
      assert(!existsSync(missing), "database.recover made a file");
      await ctx.fails("NO_DATABASE", "database.recover", { ...n.alice, from: { kind: "memory" } });

      assertEqual((await ctx.call("suspects.get", { ...n.alice, key: "no such suspect" })).suspect, null, "suspects.get of an unknown key");
      await ctx.fails("NOT_FOUND", "suspects.accept", { ...n.alice, key: "no such suspect" });
      await ctx.fails("INVALID_INPUT", "suspects.list", { ...n.alice, limit: 0 });
      await ctx.fails("INVALID_INPUT", "suspects.list", { ...n.alice, limit: 1001 });
      await ctx.fails("INVALID_INPUT", "suspects.get", { ...n.alice, key: "" });
      await ctx.fails("INVALID_INPUT", "suspects.discard", { ...n.alice, key: suspect.key, extra: 1 });
      await ctx.fails("INVALID_INPUT", "database.recover", n.alice);
    },
  },
];

export const RETIRE_CHECKS: readonly ContractCheck[] = [
  {
    capabilities: ["tickets", "sync", "replicas"],
    name: "replicas.list shows each replica's status and the replica that introduced it",
    async run(ctx) {
      const [a, b] = await twoReplicas(ctx);
      for (const on of [a, b]) {
        const { replicas } = await ctx.call("replicas.list", on.alice);
        const listed = Object.fromEntries(replicas.map((entry) => [entry.instanceId, [entry.status, entry.introducedBy ?? null]]));
        assertEqual(listed, { [a.instanceId]: ["active", null], [b.instanceId]: ["active", a.instanceId] }, "replicas.list");
      }
    },
  },
  {
    capabilities: ["retire", "tickets", "sync", "replicas", "purge", "documents"],
    name: "replicas.retire retires another replica, which others then refuse and which stops once it learns",
    async run(ctx) {
      const [a, b] = await twoReplicas(ctx);
      assertEqual(await ctx.call("replicas.retire", { ...a.alice, instanceId: b.instanceId }), {}, "replicas.retire");
      const status = (await ctx.call("replicas.list", a.alice)).replicas.find((entry) => entry.instanceId === b.instanceId)?.status;
      assertEqual(status, "retired", "the retired replica's status");
      const { hello } = await ctx.call("sync.hello", b.alice);
      await ctx.fails("SYNC_MISMATCH", "sync.checkPeer", { ...a.alice, hello });
      // b can still pull from a, and learns it is retired.
      await pull(ctx, a, b);
      assertEqual(await ctx.call("sync.state", b.alice), { stale: false, purgedThrough: 0, rewound: false, retired: true }, "the retired replica's sync.state");
      await ctx.fails("READ_ONLY", "documents.create", { ...b.alice, content: { n: 1 } });
      await ctx.fails("SYNC_MISMATCH", "sync.hello", b.alice);
      assertEqual(await ctx.call("replicas.retire", { ...a.alice, instanceId: b.instanceId }), {}, "retiring it again");
    },
  },
  {
    capabilities: ["retire", "acl"],
    name: "replicas.retire is for admins, for replicas known here other than the one asked",
    async run(ctx) {
      const opened = await ctx.create(ALICE);
      const alice = { handle: opened.handle, principal: ALICE };
      await ctx.fails("NOT_SUPPORTED", "replicas.retire", { ...alice, instanceId: opened.instanceId });
      await ctx.fails("NOT_FOUND", "replicas.retire", { ...alice, instanceId: UNKNOWN_REPLICA });
      await ctx.setAcl(alice, { readers: ["alice", "bob"] });
      await ctx.fails("ACCESS_DENIED", "replicas.retire", { handle: opened.handle, principal: BOB, instanceId: UNKNOWN_REPLICA });
      await ctx.fails("INVALID_INPUT", "replicas.retire", alice);
    },
  },
];

export const STATE_CHECKS: readonly ContractCheck[] = [
  {
    capabilities: ["purge", "tickets", "sync", "documents"],
    name: "a copy that went back is caught at its next sync, marked rewound, and takes no writes",
    async run(ctx) {
      const path = ctx.filePath();
      const copy = ctx.filePath();
      if (path === undefined || copy === undefined) {
        return;
      }
      const a = replica(await ctx.create(ALICE));
      const b = replica(await ctx.call("database.createFromTicket", { storage: file(path), principal: ALICE, ticket: (await ctx.call("replicas.register", a.alice)).ticket }));
      await pull(ctx, a, b);
      await pull(ctx, b, a);
      await ctx.call("database.close", { handle: b.handle });
      copyFileSync(path, copy);
      const live = replica(await ctx.call("database.open", { storage: file(path) }));
      await ctx.call("documents.create", { ...live.alice, content: { later: true } });
      await pull(ctx, live, a);
      const restored = replica(await ctx.call("database.open", { storage: file(copy) }));
      const { hello } = await ctx.call("sync.hello", a.alice);
      await ctx.fails("REWIND_DETECTED", "sync.checkPeer", { ...restored.alice, hello });
      assertEqual(await ctx.call("sync.state", restored.alice), { stale: false, purgedThrough: 0, rewound: true, retired: false }, "the copy's sync.state");
      await ctx.fails("READ_ONLY", "documents.create", { ...restored.alice, content: { n: 1 } });
    },
  },
];

export const SPACE_CHECKS: readonly ContractCheck[] = [
  {
    capabilities: ["space", "compact", "documents"],
    name: "database.space reports the storage's size and free space, which compact gives back",
    async run(ctx) {
      const opened = await ctx.create(ALICE);
      const alice = { handle: opened.handle, principal: ALICE };
      for (let n = 0; n < 50; n++) {
        const { document } = await ctx.call("documents.create", { ...alice, content: { n, pad: "x".repeat(200) } });
        await ctx.call("documents.delete", { ...alice, id: document.id, ifVersion: document.version });
      }
      const before = await ctx.call("database.space", { handle: opened.handle });
      assert(before.totalBytes > 0 && before.freeBytes <= before.totalBytes, `database.space gave ${JSON.stringify(before)}`);
      await ctx.call("database.compact", { handle: opened.handle });
      const after = await ctx.call("database.space", { handle: opened.handle });
      assert(after.totalBytes > 0 && after.freeBytes <= before.freeBytes, `database.space after compact gave ${JSON.stringify(after)}, before ${JSON.stringify(before)}`);
      await ctx.fails("INVALID_INPUT", "database.space", { handle: opened.handle, principal: ALICE });
    },
  },
  {
    capabilities: ["space"],
    name: "database.space on a closed handle is UNKNOWN_HANDLE",
    async run(ctx) {
      const { handle } = await ctx.create(ALICE);
      await ctx.call("database.close", { handle });
      await ctx.fails("UNKNOWN_HANDLE", "database.space", { handle });
    },
  },
];
