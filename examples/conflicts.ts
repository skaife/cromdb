// Conflicts: the same document edited on two replicas, then resolved.
import { Session, SqliteAdapter, sync } from "../src/index.js";

type Task = { title: string; status: string };

export async function main(): Promise<void> {
  const alice = Session.named("alice");
  const adapterA = SqliteAdapter.open(":memory:");
  const adapterB = SqliteAdapter.open(":memory:");
  const a = await alice.openDatabase(adapterA);
  await a.createReplica(adapterB);
  const b = await alice.openDatabase(adapterB);

  const task = await a.create<Task>({ title: "Ship 0.1.0", status: "open" });
  await sync(a, b);

  // Both replicas edit the same document before syncing.
  const onA = await a.get<Task>(task.id);
  const onB = await b.get<Task>(task.id);
  if (onA === undefined || onB === undefined) {
    throw new Error("task not found");
  }
  onA.content.status = "done";
  await onA.save();
  onB.content.status = "blocked";
  await onB.save();
  await sync(a, b);

  // Neither edit is lost. Every replica shows the same version as the
  // document (the primary) and keeps the other as a conflict version.
  const inConflict = await a.find({ inConflict: true });
  console.log(`documents in conflict: ${inConflict.count}`);
  const current = await a.get<Task>(task.id);
  const conflict = await current?.conflict();
  if (current === undefined || conflict === undefined) {
    throw new Error("expected a conflict");
  }
  for (const version of conflict.versions) {
    console.log(`${version.isPrimary ? "primary " : "conflict"}: ${version.document.content.status}`);
  }

  // Editing a document in conflict works, and says the conflict remains.
  current.content.title = "Ship 0.1.0 (reviewed)";
  const { editedThroughConflict } = await current.save();
  console.log(`edited through conflict: ${editedThroughConflict}`);

  // A person or the app decides. Here, keep "done" with the new title.
  const fresh = await (await a.get<Task>(task.id))?.conflict();
  await fresh?.resolveWithContent({ content: { title: "Ship 0.1.0 (reviewed)", status: "done" } });
  await sync(a, b);

  const resolved = await b.get<Task>(task.id);
  console.log(`on b: ${resolved?.content.status}, in conflict: ${(await resolved?.conflict()) !== undefined}`);

  adapterA.close();
  adapterB.close();
}
