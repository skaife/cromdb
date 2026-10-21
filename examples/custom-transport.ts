// Custom transport: sync two replicas with only JSON text passing between them.
import { Session, SqliteAdapter, type Database } from "../src/index.js";

// Stands in for the network. A real app would send the text over HTTP or
// similar, with the two replicas in different processes or on different
// machines.
function send(text: string): string {
  return text;
}

// Pulls source's changes into target until there are none left. The target
// needs the source's instanceId, which the source tells it (each batch
// carries it as sourceInstanceId, too).
async function pull(target: Database, source: Database): Promise<number> {
  let applied = 0;
  for (;;) {
    // The receiver says how far it has got.
    const since = await target.syncPosition(source.instanceId);
    const request = JSON.parse(send(JSON.stringify({ since }))) as { since: number };

    // The source answers with the changes after that.
    const batch = await source.exportChanges({ since: request.since });
    const response: unknown = JSON.parse(send(JSON.stringify(batch)));

    // The receiver applies them, and stores its new position.
    const result = await target.applyChanges(response);
    applied += result.applied;
    if (!result.hasMore) {
      return applied;
    }
  }
}

export async function main(): Promise<void> {
  const alice = Session.named("alice");
  const adapterA = SqliteAdapter.open(":memory:");
  const adapterB = SqliteAdapter.open(":memory:");
  const a = await alice.openDatabase(adapterA);
  await a.createReplica(adapterB);
  const b = await alice.openDatabase(adapterB);

  await a.create({ city: "Lisbon" });
  await b.create({ city: "Osaka" });

  // Pull each way. All four calls are admin only.
  console.log(`b applied ${await pull(b, a)} change(s) from a`);
  console.log(`a applied ${await pull(a, b)} change(s) from b`);
  console.log(`a has ${(await a.find()).count} documents, b has ${(await b.find()).count}`);

  adapterA.close();
  adapterB.close();
}
