// Replication: make a second replica, edit both, and sync them.
import { Session, SqliteAdapter, sync } from "../src/index.js";

export async function main(): Promise<void> {
  const alice = Session.named("alice");

  // The first replica, and an empty adapter for the second.
  const adapterA = SqliteAdapter.open(":memory:");
  const adapterB = SqliteAdapter.open(":memory:");
  const a = await alice.openDatabase(adapterA);

  // createReplica copies the database into the empty adapter (admin only).
  await a.createReplica(adapterB);
  const b = await alice.openDatabase(adapterB);
  console.log(`replica ${b.instanceId} of database ${b.databaseId}`);

  // Each replica can be edited on its own, including while offline.
  await a.create({ city: "Lisbon" });
  await b.create({ city: "Osaka" });

  // sync pulls each way. Both sessions must be admins.
  await sync(a, b);
  console.log(`a has ${(await a.find()).count} documents, b has ${(await b.find()).count}`);

  // pullFrom pulls one way and reports what it did.
  await a.create({ city: "Quito" });
  const result = await b.pullFrom(a);
  console.log(`b applied ${result.applied} change(s) in ${result.batches} batch(es)`);

  adapterA.close();
  adapterB.close();
}
