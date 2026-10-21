// Basic use: open a database file, create documents, read, edit and find them.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SqliteAdapter } from "../src/index.js";

export async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cromdb-basic-"));
  try {
    // Open (or create) a database file. The first session to open a new
    // database becomes its only admin and its only creator.
    const adapter = SqliteAdapter.open(join(dir, "notes.db"));
    const alice = Session.named("alice");
    const db = await alice.openDatabase(adapter);

    // Let every named user create documents, not just alice.
    const acl = await db.getAcl();
    acl.creators = ["*"];
    await acl.save();

    // Create a document. readers and writers default to ["*"].
    const note = await db.create({ title: "Groceries", items: ["milk"], done: false });
    console.log(`alice created ${note.id}`);

    // Read it back, edit it in place, and save.
    const loaded = await db.get<{ title: string; items: string[]; done: boolean }>(note.id);
    if (loaded === undefined) {
      throw new Error("note not found");
    }
    loaded.content.items.push("eggs");
    await loaded.save();
    console.log(`items now: ${loaded.content.items.join(", ")}`);

    // Another user, on the same database file.
    const bob = await Session.named("bob").openDatabase(adapter);
    await bob.create({ title: "Bob's list", items: [], done: false }, { readers: ["bob"], writers: ["bob"] });

    // find returns only what the session can read.
    const open = await db.find({ where: { done: false } });
    console.log(`alice sees ${open.count} open note(s)`);
    for await (const doc of await bob.find({ where: { done: false } })) {
      console.log(`bob sees: ${String(doc.content["title"])}`);
    }

    adapter.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
