// The dev server's sample data, made once with a new data directory, so the
// admin UI has something to show and its browser tests something to find:
//
//   "Sales tickets"   a few tickets with text, numbers, true/false, empty,
//                     dates (one inside a JSON value), a child, an orphan,
//                     and a document in conflict
//   "Paging"          120 small documents, for Previous and Next
//
// Both belong to Ada Admin. Ivy and Ned get no access, so their lists stay
// empty. Documents are made through the driver as Ada; the conflict is made
// as servers will make one: a second replica, synced as "cromdb-server",
// saves the document while this server saves it too, then the two sync.

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

/** Saves the document both here and on a second replica, then syncs the second one's change in. */
async function makeConflict(driver: Driver, handle: string, personId: string, id: string): Promise<void> {
  const here = { handle, principal: { id: SERVER } };
  const { ticket } = await driver.call("replicas.register", here);
  const opened = await driver.call("database.createFromTicket", { storage: { kind: "memory" }, principal: { id: SERVER }, ticket });
  const there = { handle: opened.handle, principal: { id: SERVER } };
  const { instanceId } = await driver.call("database.info", { handle });
  await pull(driver, here, instanceId, there);
  const asPerson = (h: string) => ({ handle: h, principal: { id: personId } });
  const theirs = await driver.call("documents.get", { ...asPerson(opened.handle), id });
  await driver.call("documents.save", {
    ...asPerson(opened.handle),
    id,
    ifVersion: theirs.document?.version ?? "",
    content: { title: "Quote for 40 chairs", status: "open", priority: 1, customer: "Harbor Cafe", note: "They want oak, not pine" },
  });
  const ours = await driver.call("documents.get", { ...asPerson(handle), id });
  await driver.call("documents.save", {
    ...asPerson(handle),
    id,
    ifVersion: ours.document?.version ?? "",
    content: { title: "Quote for 40 chairs", status: "quoted", priority: 2, customer: "Harbor Cafe", note: "Sent the quote" },
  });
  await pull(driver, there, opened.instanceId, here);
  await driver.call("database.close", { handle: opened.handle });
}

export async function makeDevData(server: RunningServer, personId: string, now: Date): Promise<void> {
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
  await makeConflict(driver, sales.handle, personId, chairs);

  const paging = await server.databases.create({ name: "Paging", personId, now });
  const pagingAs = { handle: paging.handle, principal: { id: personId } };
  for (let n = 1; n <= 120; n++) {
    await make(driver, pagingAs, { title: `Item ${String(n).padStart(3, "0")}`, n, even: n % 2 === 0 });
  }
}
