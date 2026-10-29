// The demo end to end: three replica processes, driven over HTTP only.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { REPLICA_NAMES, personFor, serviceFor, type ReplicaName } from "../server/identities.ts";
import { answers, startDemo, type Demo } from "./helpers.ts";

const ALICE = personFor("A");
const BOB = personFor("B");
const CAROL = personFor("C");

async function sync(demo: Demo, from: ReplicaName, peer: ReplicaName): Promise<void> {
  const { status, body } = await demo.call(from, "POST", "/api/sync", { peer });
  assert.equal(status, 200, JSON.stringify(body));
}

async function notesOn(demo: Demo, name: ReplicaName): Promise<any[]> {
  const { status, body } = await demo.call(name, "GET", "/api/notes");
  assert.equal(status, 200);
  return body.notes;
}

async function noteOn(demo: Demo, name: ReplicaName, id: string): Promise<any> {
  const { status, body } = await demo.call(name, "GET", `/api/notes/${id}`);
  assert.equal(status, 200, JSON.stringify(body));
  return body.note;
}

async function edit(demo: Demo, name: ReplicaName, note: any, text: string): Promise<any> {
  const { status, body } = await demo.call(name, "PUT", `/api/notes/${note.id}`, {
    title: note.content.title,
    text,
    vectorClock: note.vectorClock,
  });
  assert.equal(status, 200, JSON.stringify(body));
  return body;
}

async function conflictOn(demo: Demo, name: ReplicaName, id: string): Promise<any> {
  const { status, body } = await demo.call(name, "GET", `/api/notes/${id}/conflict`);
  assert.equal(status, 200, JSON.stringify(body));
  return body;
}

describe("scene 1: it just works", () => {
  it("passes one note around the triangle, each edit made after seeing the last", async () => {
    const demo = await startDemo();
    try {
      const created = await demo.call("A", "POST", "/api/notes", { title: "Picnic", text: "Sandwiches." });
      assert.equal(created.status, 201);
      const id: string = created.body.note.id;
      assert.equal(created.body.note.updatedBy, ALICE);

      await sync(demo, "B", "A");
      const onB = await noteOn(demo, "B", id);
      assert.equal(onB.updatedBy, ALICE);
      const bob = await edit(demo, "B", onB, "Sandwiches. Lemonade.");
      assert.equal(bob.note.updatedBy, BOB);
      assert.equal(bob.editedThroughConflict, false);

      // Saving again from the version loaded before Bob's edit is refused.
      const stale = await demo.call("B", "PUT", `/api/notes/${id}`, {
        title: "Picnic",
        text: "Something else",
        vectorClock: onB.vectorClock,
      });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, "STALE_DOCUMENT");

      await sync(demo, "C", "B");
      const onC = await noteOn(demo, "C", id);
      assert.equal(onC.updatedBy, BOB);
      const carol = await edit(demo, "C", onC, "Sandwiches. Lemonade. A blanket.");
      assert.equal(carol.note.updatedBy, CAROL);
      assert.equal(carol.editedThroughConflict, false);

      await sync(demo, "A", "C");
      assert.equal((await noteOn(demo, "A", id)).updatedBy, CAROL);
      await sync(demo, "B", "C");

      for (const name of REPLICA_NAMES) {
        const notes = await notesOn(demo, name);
        assert.equal(notes.length, 1, name);
        assert.equal(notes[0].content.text, "Sandwiches. Lemonade. A blanket.", name);
        assert.equal(notes[0].updatedBy, CAROL, name);
        assert.equal(notes[0].inConflict, false, name);
        assert.equal((await conflictOn(demo, name, id)).inConflict, false, name);
      }
    } finally {
      await demo.stop();
    }
  });
});

describe("scene 2: the replicas disagree", () => {
  it("shows the same conflict everywhere, then agrees once it is resolved", async () => {
    const demo = await startDemo();
    try {
      const created = await demo.call("A", "POST", "/api/notes", { title: "Meeting", text: "Tuesday." });
      const id: string = created.body.note.id;
      await sync(demo, "B", "A");
      await sync(demo, "C", "A");

      // B and C go offline and both edit the note.
      for (const name of ["B", "C"] as const) {
        assert.equal((await demo.call(name, "POST", "/api/online", { online: false })).body.online, false);
      }
      await edit(demo, "B", await noteOn(demo, "B", id), "Tuesday at 10.");
      await edit(demo, "C", await noteOn(demo, "C", id), "Wednesday.");
      for (const name of ["B", "C"] as const) {
        await demo.call(name, "POST", "/api/online", { online: true });
      }

      // B syncs with A: A takes Bob's edit, no conflict yet.
      await sync(demo, "B", "A");
      const onA = await noteOn(demo, "A", id);
      assert.equal(onA.updatedBy, BOB);
      assert.equal(onA.inConflict, false);

      // C syncs with A: A and C now see the conflict, B doesn't yet.
      await sync(demo, "C", "A");
      assert.equal((await noteOn(demo, "A", id)).inConflict, true);
      assert.equal((await noteOn(demo, "C", id)).inConflict, true);
      assert.equal((await noteOn(demo, "B", id)).inConflict, false);

      // B syncs again: all three show the same conflict.
      await sync(demo, "B", "A");
      const conflicts = await Promise.all(REPLICA_NAMES.map((name) => conflictOn(demo, name, id)));
      for (const conflict of conflicts) {
        assert.equal(conflict.inConflict, true);
        assert.equal(conflict.versions.length, 2);
        assert.deepEqual(conflict.primaryId, conflicts[0].primaryId);
        assert.deepEqual(conflict.versions, conflicts[0].versions);
        assert.equal(conflict.snapshot, conflicts[0].snapshot);
      }
      const versions: any[] = conflicts[0].versions;
      assert.deepEqual(versions.map((v) => v.updatedBy).sort(), [BOB, CAROL]);
      assert.equal(versions.filter((v) => v.isPrimary).length, 1);
      const primaryText = versions.find((v) => v.isPrimary).content.text;
      for (const name of REPLICA_NAMES) {
        const [note] = await notesOn(demo, name);
        assert.equal(note.inConflict, true, name);
        assert.equal(note.content.text, primaryText, name);
      }

      // Alice resolves on A.
      const resolved = await demo.call("A", "POST", `/api/notes/${id}/resolve`, {
        snapshot: conflicts[0].snapshot,
        content: { title: "Meeting", text: "Wednesday at 10." },
      });
      assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
      assert.equal(resolved.body.note.inConflict, false);
      assert.equal(resolved.body.note.updatedBy, ALICE);

      await sync(demo, "B", "A");
      await sync(demo, "C", "A");
      for (const name of REPLICA_NAMES) {
        const notes = await notesOn(demo, name);
        assert.equal(notes.length, 1, name);
        assert.equal(notes[0].content.text, "Wednesday at 10.", name);
        assert.equal(notes[0].updatedBy, ALICE, name);
        assert.equal(notes[0].inConflict, false, name);
        assert.equal((await conflictOn(demo, name, id)).inConflict, false, name);
      }
    } finally {
      await demo.stop();
    }
  });

  it("refuses a resolve based on versions that have changed since", async () => {
    const demo = await startDemo();
    try {
      const created = await demo.call("A", "POST", "/api/notes", { title: "Plan", text: "One." });
      const id: string = created.body.note.id;
      await sync(demo, "B", "A");
      await edit(demo, "A", created.body.note, "Two.");
      await edit(demo, "B", await noteOn(demo, "B", id), "Three.");
      await sync(demo, "B", "A");
      const before = await conflictOn(demo, "A", id);
      assert.equal(before.inConflict, true);
      await edit(demo, "B", await noteOn(demo, "B", id), "Four.");
      await sync(demo, "B", "A");

      const stale = await demo.call("A", "POST", `/api/notes/${id}/resolve`, { snapshot: before.snapshot, with: 0 });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, "STALE_DOCUMENT");
      const fresh = await conflictOn(demo, "A", id);
      const ok = await demo.call("A", "POST", `/api/notes/${id}/resolve`, { snapshot: fresh.snapshot, with: 0 });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.note.inConflict, false);
    } finally {
      await demo.stop();
    }
  });
});

describe("offline and unreachable replicas", () => {
  let demo: Demo;
  after(async () => {
    await demo?.stop();
  });

  it("gives each replica its own process", async () => {
    demo = await startDemo();
    const infos = await Promise.all(REPLICA_NAMES.map(async (name) => (await demo.call(name, "GET", "/api/info")).body));
    for (const [i, name] of REPLICA_NAMES.entries()) {
      assert.equal(infos[i].name, name);
      assert.equal(infos[i].pid, demo.pids[name]);
      assert.equal(infos[i].person, personFor(name));
      assert.equal(infos[i].service, serviceFor(name));
    }
    assert.equal(new Set(infos.map((info) => info.pid)).size, 3);
    assert.ok(!infos.some((info) => info.pid === process.pid));
    assert.equal(new Set(infos.map((info) => info.instanceId)).size, 3);
    assert.equal(new Set(infos.map((info) => info.databaseId)).size, 1);
  });

  it("refuses sync while offline, both ways, and syncs again once back", async () => {
    await demo.call("A", "POST", "/api/notes", { title: "Offline", text: "Test." });
    const off = await demo.call("B", "POST", "/api/online", { online: false });
    assert.equal(off.body.online, false);

    const toB = await demo.call("A", "POST", "/api/sync", { peer: "B" });
    assert.equal(toB.status, 502);
    assert.equal(toB.body.error.code, "PEER_OFFLINE");
    assert.equal(toB.body.error.replica, "B");

    const fromB = await demo.call("B", "POST", "/api/sync", { peer: "A" });
    assert.equal(fromB.status, 409);
    assert.equal(fromB.body.error.code, "OFFLINE");

    for (const path of ["/sync/position?source=x", "/sync/changes?since=0"]) {
      const direct = await demo.call("B", "GET", path);
      assert.equal(direct.status, 503, path);
      assert.equal(direct.body.error.code, "OFFLINE", path);
    }
    assert.equal((await notesOn(demo, "B")).length, 0);

    await demo.call("B", "POST", "/api/online", { online: true });
    await sync(demo, "A", "B");
    assert.equal((await notesOn(demo, "B")).length, 1);
  });

  it("reports a killed replica unreachable, quickly", async () => {
    await demo.kill("C");
    for (const from of ["A", "B"] as const) {
      const start = performance.now();
      const answer = await demo.call(from, "POST", "/api/sync", { peer: "C" });
      const elapsed = performance.now() - start;
      assert.equal(answer.status, 502);
      assert.equal(answer.body.error.code, "PEER_UNREACHABLE");
      assert.equal(answer.body.error.replica, "C");
      assert.ok(elapsed < 2000, `took ${elapsed} ms`);
    }
    // The other two still sync.
    await sync(demo, "A", "B");
  });
});

describe("errors", () => {
  it("answers CromDB and request errors as JSON with a code", async () => {
    const demo = await startDemo();
    try {
      const missing = await demo.call("A", "GET", "/api/notes/nope");
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.code, "NOT_FOUND");

      const bad = await demo.call("A", "POST", "/api/notes", { title: 1 });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.code, "BAD_REQUEST");

      const unknown = await demo.call("A", "POST", "/api/sync", { peer: "Z" });
      assert.equal(unknown.status, 400);
      assert.equal(unknown.body.error.code, "UNKNOWN_PEER");

      // A batch whose start doesn't match what A has applied from B.
      const info = (await demo.call("B", "GET", "/api/info")).body;
      const batch = (await demo.call("B", "GET", "/sync/changes?since=0")).body;
      assert.equal(batch.sourceInstanceId, info.instanceId);
      const position = (await demo.call("A", "GET", `/sync/position?source=${info.instanceId}`)).body.position;
      assert.notEqual(position, 0);
      const mismatch = await demo.call("A", "POST", "/sync/changes", batch);
      assert.equal(mismatch.status, 409);
      assert.equal(mismatch.body.error.code, "SYNC_MISMATCH");
      assert.equal(mismatch.body.error.replica, "A");

      const malformed = await demo.call("A", "POST", "/sync/changes", { format: 99 });
      assert.equal(malformed.status, 400);
      assert.equal(malformed.body.error.code, "INVALID_BATCH");
    } finally {
      await demo.stop();
    }
  });
});

describe("identities", () => {
  it("never shows a note written by a service", () => {
    const services = new Set(REPLICA_NAMES.map(serviceFor));
    const seen = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          if ((key === "updatedBy" || key === "createdBy") && typeof inner === "string") {
            seen.add(inner);
          }
          // Sync batches carry system documents, which the services do write.
          if (key !== "documents") {
            walk(inner);
          }
        }
      }
    };
    answers.forEach((answer) => walk(answer.body));
    assert.ok(seen.size > 0);
    for (const name of seen) {
      assert.ok(!services.has(name), `${name} wrote a note`);
    }
    assert.deepEqual([...seen].sort(), [ALICE, BOB, CAROL]);
  });
});
