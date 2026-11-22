// The dev server's sample data, made once with a new data directory, so the
// admin UI has something to show and its browser tests something to find:
//
//   "Sales tickets"   a few tickets with text, numbers, true/false, empty,
//                     dates (one inside a JSON value), a child, an orphan,
//                     and a document in conflict
//   "Paging"          120 small documents, for Previous and Next
//   "Conflicts"       12 documents with two versions each (the browser
//                     tests resolve three per browser and width), one with
//                     three versions (one of them deletes it), and one with
//                     a version only Ned can read
//
// All belong to Ada Admin. Ivy gets no access, so her list stays empty; Ned
// may read and write "Conflicts" only. Documents are made through the driver
// as Ada (or Ned). Conflicts are made as servers will make them: other
// replicas, synced as "cromdb-server", change a document while this server
// changes it too, then they sync.

import type { Driver } from "@cromdb/driver";
import type { RunningServer } from "../dist/index.js";

const SERVER = "cromdb-server";

interface Handle {
  readonly handle: string;
  readonly principal: { readonly id: string };
}

type Content = Record<string, unknown>;

async function make(driver: Driver, as: Handle, content: Content, fieldTypes: Record<string, "datetime"> = {}, parentId?: string): Promise<string> {
  const { document } = await driver.call("documents.create", {
    ...as,
    content: content as never,
    fieldTypes,
    ...(parentId === undefined ? {} : { parentId }),
  });
  return document.id;
}

/** Pulls everything from one replica into another, as sync does. */
async function pull(driver: Driver, from: Handle, fromInstance: string, to: Handle): Promise<void> {
  const { hello } = await driver.call("sync.hello", from);
  await driver.call("sync.checkPeer", { ...to, hello });
  for (;;) {
    const { since } = await driver.call("sync.position", { ...to, sourceInstanceId: fromInstance });
    const { batch } = await driver.call("sync.export", { ...from, since });
    if (!(await driver.call("sync.apply", { ...to, batch })).hasMore) return;
  }
}

/** A change made on another replica: by whom, and what. */
interface Side {
  readonly personId: string;
  /** New content, or "delete". */
  readonly change: Content | "delete";
  readonly readers?: string[];
  readonly writers?: string[];
}

/**
 * Makes a document conflict: each side's change is made on a replica of its
 * own (made from a ticket and synced as cromdb-server, as servers will),
 * while the server saves its own change as personId; then every replica's
 * change is synced in. One version per side, plus the server's.
 */
async function makeConflict(driver: Driver, handle: string, personId: string, id: string, ours: Content, sides: readonly Side[]): Promise<void> {
  const here = { handle, principal: { id: SERVER } };
  const { instanceId } = await driver.call("database.info", { handle });
  const replicas: { handle: string; instanceId: string }[] = [];
  for (const side of sides) {
    const { ticket } = await driver.call("replicas.register", here);
    const opened = await driver.call("database.createFromTicket", { storage: { kind: "memory" }, principal: { id: SERVER }, ticket });
    await pull(driver, here, instanceId, { handle: opened.handle, principal: { id: SERVER } });
    const as = { handle: opened.handle, principal: { id: side.personId } };
    const theirs = await driver.call("documents.get", { ...as, id });
    const ifVersion = theirs.document?.version ?? "";
    if (side.change === "delete") {
      await driver.call("documents.delete", { ...as, id, ifVersion });
    } else {
      await driver.call("documents.save", {
        ...as,
        id,
        ifVersion,
        content: side.change as never,
        ...(side.readers === undefined ? {} : { readers: side.readers }),
        ...(side.writers === undefined ? {} : { writers: side.writers }),
      });
    }
    replicas.push({ handle: opened.handle, instanceId: opened.instanceId });
  }
  // Saved twice here, so this server's version has the most edits and ranks
  // first: which version is the document doesn't depend on the clock or on
  // random instance IDs, and the data is the same in every run.
  const asPerson = { handle, principal: { id: personId } };
  for (let time = 0; time < 2; time++) {
    const current = await driver.call("documents.get", { ...asPerson, id });
    await driver.call("documents.save", { ...asPerson, id, ifVersion: current.document?.version ?? "", content: ours as never });
  }
  for (const replica of replicas) {
    await pull(driver, { handle: replica.handle, principal: { id: SERVER } }, replica.instanceId, here);
    await driver.call("database.close", { handle: replica.handle });
  }
}

export async function makeDevData(server: RunningServer, personId: string, now: Date, nedId: string): Promise<void> {
  const driver = server.databases.driver;

  const sales = await server.databases.create({ name: "Sales tickets", personId, now });
  const as = { handle: sales.handle, principal: { id: personId } };
  await make(driver, as, { title: "Printer jams on tray 2", status: "open", priority: 2, urgent: true, due: "2026-11-24T17:00:00.000Z", assignee: null }, { "/due": "datetime" });
  const chairs = await make(driver, as, { title: "Quote for 40 chairs", status: "open", priority: 1, customer: "Harbor Cafe" });
  const renewal = await make(
    driver,
    as,
    { title: "Renewal: Harbor Cafe", status: "open", priority: 3, contact: { name: "Rosa Diaz", phone: "555-0142", since: "2024-03-01T09:00:00.000Z" }, tags: ["renewal", "cafe"] },
    { "/contact/since": "datetime" },
  );
  await make(driver, as, { title: "Call back about the renewal", status: "open" }, {}, renewal);
  await make(driver, as, { title: "Wrong invoice address", status: "closed", priority: 2, amount: 412.5 });
  const oldParent = await make(driver, as, { title: "Office move (cancelled)", status: "closed" });
  await make(driver, as, { title: "Book the van", status: "open" }, {}, oldParent);
  const parent = await driver.call("documents.get", { ...as, id: oldParent });
  await driver.call("documents.delete", { ...as, id: oldParent, ifVersion: parent.document?.version ?? "" });
  await makeConflict(driver, sales.handle, personId, chairs, { title: "Quote for 40 chairs", status: "quoted", priority: 2, customer: "Harbor Cafe", note: "Sent the quote" }, [
    { personId, change: { title: "Quote for 40 chairs", status: "open", priority: 1, customer: "Harbor Cafe", note: "They want oak, not pine" } },
  ]);

  const paging = await server.databases.create({ name: "Paging", personId, now });
  const pagingAs = { handle: paging.handle, principal: { id: personId } };
  for (let n = 1; n <= 120; n++) {
    await make(driver, pagingAs, { title: `Item ${String(n).padStart(3, "0")}`, n, even: n % 2 === 0 });
  }

  // Conflicts to resolve. Ned may read and write here, for the version only he can read.
  const conflicts = await server.databases.create({ name: "Conflicts", personId, now });
  const conflictsAs = { handle: conflicts.handle, principal: { id: personId } };
  const { acl } = await driver.call("acl.get", conflictsAs);
  await driver.call("acl.save", {
    ...conflictsAs,
    ifVersion: acl.version,
    admins: [...acl.admins],
    creators: [...acl.creators],
    writers: [...acl.writers, nedId],
    readers: [...acl.readers, nedId],
    noAccess: [...acl.noAccess],
  });
  for (let n = 1; n <= 12; n++) {
    const title = `Conflict ${String(n).padStart(2, "0")}`;
    const id = await make(driver, conflictsAs, { title, colour: "blue", size: 3 });
    await makeConflict(driver, conflicts.handle, personId, id, { title, colour: "green", size: 3, note: "Changed here" }, [
      { personId, change: { title, colour: "red", size: 4 } },
    ]);
  }
  const three = await make(driver, conflictsAs, { title: "Three versions", step: 1 });
  await makeConflict(driver, conflicts.handle, personId, three, { title: "Three versions", step: 2, where: "here" }, [
    { personId, change: { title: "Three versions", step: 2, where: "office" } },
    { personId, change: "delete" },
  ]);
  const hidden = await make(driver, conflictsAs, { title: "A version you can't read", secret: false });
  await makeConflict(driver, conflicts.handle, personId, hidden, { title: "A version you can't read", secret: false, by: "Ada, here" }, [
    { personId, change: { title: "A version you can't read", secret: false, by: "Ada, elsewhere" } },
    { personId: nedId, change: { title: "Ned's own", secret: true }, readers: [nedId], writers: [nedId] },
  ]);
}
