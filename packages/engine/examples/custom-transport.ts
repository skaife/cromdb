// Custom transport: sync two replicas with only JSON text passing between them.
import { Session, SqliteAdapter, type Database, type SyncHello } from "../src/index.js";

// Stands in for the network. A real app would send the text over HTTP or
// similar, with the two replicas in different processes or on different
// machines.
function send(text: string): string {
  return text;
}

// The handshake, one round trip before any batch: each side sends its hello
// and checks the other's, so a replica that can't sync with the other (another
// database, or one that needs upgrading) fails here with a clear error.
async function handshake(a: Database, b: Database): Promise<number> {
  // a sends its hello; b checks it and answers with its own.
  const helloA = JSON.parse(send(JSON.stringify(await a.syncHello()))) as SyncHello;
  await b.checkPeer(helloA);
  const helloB = JSON.parse(send(JSON.stringify(await b.syncHello()))) as SyncHello;

  // a checks b's answer. Both now know the level they sync at.
  const { level } = await a.checkPeer(helloB);
  return level;
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
  const alice = Session.withId("alice");
  const adapterA = SqliteAdapter.open(":memory:");
  const adapterB = SqliteAdapter.open(":memory:");
  const a = await alice.openDatabase(adapterA);
  await a.createReplica(adapterB);
  const b = await alice.openDatabase(adapterB);

  await a.create({ city: "Lisbon" });
  await b.create({ city: "Osaka" });

  // Handshake first, then pull each way. All these calls are admin only.
  console.log(`syncing at level ${await handshake(a, b)}`);
  console.log(`b applied ${await pull(b, a)} change(s) from a`);
  console.log(`a applied ${await pull(a, b)} change(s) from b`);
  console.log(`a has ${(await a.find()).count} documents, b has ${(await b.find()).count}`);

  adapterA.close();
  adapterB.close();
}
