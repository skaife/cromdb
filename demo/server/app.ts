// The HTTP API of one replica: /api/* for the page, /sync/* for the other
// replicas. Notes are written only as the person, and sync runs only as the
// service, each through its own Database.

import express, { type NextFunction, type Request, type Response } from "express";
import { CromDBError, type Database, type Document } from "cromdb";
import { HttpError, toErrorResponse } from "./errors.ts";
import { syncWith, type Peer } from "./sync.ts";

export interface Note extends Record<string, unknown> {
  title: string;
  text: string;
}

export interface ReplicaOptions {
  readonly name: string;
  /** Opened as the person. Writes notes. */
  readonly person: Database;
  /** Opened as the service, an admin. Syncs. */
  readonly service: Database;
  readonly dataFile: string;
  readonly peers: readonly Peer[];
  /** The port listened on, once known. */
  readonly port: () => number | undefined;
  /** Origins of the page, the only browser origins allowed, and only on /api. */
  readonly pageOrigins: readonly string[];
}

// Readers and writers of every note. "*" is every named principal; the access
// checks still run.
const EVERYONE = ["*"];

function noteJson(doc: Document<Note>, inConflict: boolean) {
  return {
    id: doc.id,
    content: doc.content,
    deleted: doc.deleted,
    inConflict,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt.toISOString(),
    updatedBy: doc.updatedBy,
    updatedAt: doc.updatedAt.toISOString(),
    updatedOn: doc.updatedOn,
    // Send it back with a save or delete, to show what the edit was based on.
    version: doc.version,
  };
}

function body(req: Request): Record<string, unknown> {
  const value: unknown = req.body;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readNote(value: unknown): Note {
  if (typeof value !== "object" || value === null) {
    throw new HttpError(400, "BAD_REQUEST", "A note is { title, text }, both strings");
  }
  const { title, text } = value as Record<string, unknown>;
  if (typeof title !== "string" || typeof text !== "string") {
    throw new HttpError(400, "BAD_REQUEST", "A note is { title, text }, both strings");
  }
  return { title, text };
}

function readCount(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new HttpError(400, "BAD_REQUEST", `${name} must be a non-negative integer`);
  }
  return Number(value);
}

export function createApp(options: ReplicaOptions) {
  const { name, person, service, peers } = options;
  let online = true;

  /** Loads the note for a write, checking it is still the version the client loaded. */
  async function loadForWrite(id: string, version: unknown): Promise<Document<Note>> {
    if (typeof version !== "string") {
      throw new HttpError(400, "BAD_REQUEST", "Send the version of the note as loaded");
    }
    let doc: Document<Note> | undefined;
    try {
      doc = await person.get<Note>(id, { ifVersion: version });
    } catch (error) {
      if (error instanceof CromDBError && error.code === "STALE_DOCUMENT") {
        const current = await person.get<Note>(id);
        throw new HttpError(
          409,
          "STALE_DOCUMENT",
          `Note ${JSON.stringify(id)} has changed since it was loaded (by ${current?.updatedBy ?? "someone"}); load it again`,
        );
      }
      throw error;
    }
    if (doc === undefined) {
      throw new HttpError(404, "NOT_FOUND", `No note ${JSON.stringify(id)}`);
    }
    return doc;
  }

  async function isInConflict(doc: Document<Note>): Promise<boolean> {
    return (await doc.conflict()) !== undefined;
  }

  function info() {
    return {
      name,
      person: person.session.principal,
      service: service.session.principal,
      port: options.port(),
      pid: process.pid,
      dataFile: options.dataFile,
      databaseId: service.databaseId,
      instanceId: service.instanceId,
      online,
      peers,
    };
  }

  const app = express();

  // CORS: the page, on its own port, calls /api directly. Any other origin,
  // and any browser request to /sync, is refused before it runs.
  app.use((req, res, next) => {
    res.setHeader("Vary", "Origin");
    const origin = req.headers.origin;
    if (origin === undefined) {
      next();
      return;
    }
    if (!options.pageOrigins.includes(origin) || !req.path.startsWith("/api/")) {
      next(new HttpError(403, "ORIGIN_REFUSED", `Requests from ${origin} to ${req.path} are not allowed`));
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: "10mb" }));

  // For the page.

  app.get("/api/info", (_req, res) => {
    res.json(info());
  });

  app.post("/api/online", (req, res) => {
    const value = body(req).online;
    if (typeof value !== "boolean") {
      throw new HttpError(400, "BAD_REQUEST", "Send { online: true } or { online: false }");
    }
    online = value;
    res.json(info());
  });

  app.get("/api/notes", async (_req, res) => {
    // A deleted note still in conflict is listed too, so it can be resolved.
    const inConflict = new Map<string, Document<Note>>();
    for await (const doc of await person.find<Note>({ inConflict: true })) {
      inConflict.set(doc.id, doc);
    }
    const notes = [];
    for await (const doc of await person.find<Note>()) {
      notes.push(noteJson(doc, inConflict.has(doc.id)));
      inConflict.delete(doc.id);
    }
    for (const doc of inConflict.values()) {
      notes.push(noteJson(doc, true));
    }
    notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    res.json({ notes });
  });

  app.get("/api/notes/:id", async (req, res) => {
    const doc = await person.get<Note>(req.params.id);
    if (doc === undefined) {
      throw new HttpError(404, "NOT_FOUND", `No note ${JSON.stringify(req.params.id)}`);
    }
    res.json({ note: noteJson(doc, await isInConflict(doc)) });
  });

  app.post("/api/notes", async (req, res) => {
    const doc = await person.create<Note>(readNote(body(req)), { readers: EVERYONE, writers: EVERYONE });
    res.status(201).json({ note: noteJson(doc, false) });
  });

  app.put("/api/notes/:id", async (req, res) => {
    const doc = await loadForWrite(req.params.id, body(req).version);
    doc.content = readNote(body(req));
    const { editedThroughConflict } = await doc.save();
    res.json({ note: noteJson(doc, editedThroughConflict), editedThroughConflict });
  });

  app.delete("/api/notes/:id", async (req, res) => {
    const doc = await loadForWrite(req.params.id, body(req).version);
    const { editedThroughConflict } = await doc.delete();
    res.json({ editedThroughConflict });
  });

  app.get("/api/notes/:id/conflict", async (req, res) => {
    const doc = await person.get<Note>(req.params.id);
    if (doc === undefined) {
      throw new HttpError(404, "NOT_FOUND", `No note ${JSON.stringify(req.params.id)}`);
    }
    const conflict = await doc.conflict();
    if (conflict === undefined) {
      res.json({ inConflict: false });
      return;
    }
    res.json({
      inConflict: true,
      primaryId: conflict.primaryId,
      // Send it back with a resolve, to show which versions it was based on.
      version: conflict.version,
      versions: conflict.versions.map((version, index) => ({
        index,
        id: version.document.id,
        content: version.document.content,
        isPrimary: version.isPrimary,
        authorized: version.authorized,
        deleted: version.deleted,
        updatedBy: version.document.updatedBy,
        updatedAt: version.document.updatedAt.toISOString(),
        updatedOn: version.document.updatedOn,
        vectorClock: version.document.vectorClock,
      })),
    });
  });

  // { version, with: <version index> } | { version, content: { title, text } } | { version, delete: true }
  app.post("/api/notes/:id/resolve", async (req, res) => {
    const choice = body(req);
    const doc = await person.get<Note>(req.params.id);
    if (doc === undefined) {
      throw new HttpError(404, "NOT_FOUND", `No note ${JSON.stringify(req.params.id)}`);
    }
    if (typeof choice.version !== "string") {
      throw new HttpError(400, "BAD_REQUEST", "Send the version of the conflict as loaded");
    }
    let conflict;
    try {
      conflict = await doc.conflict({ ifVersion: choice.version });
    } catch (error) {
      if (error instanceof CromDBError && error.code === "STALE_DOCUMENT") {
        if ((await doc.conflict()) === undefined) {
          throw new HttpError(409, "NOT_IN_CONFLICT", `Note ${JSON.stringify(req.params.id)} is not in conflict`);
        }
        throw new HttpError(409, "STALE_DOCUMENT", "The conflict has changed since it was loaded; load it again");
      }
      throw error;
    }
    if (conflict === undefined) {
      throw new HttpError(409, "NOT_IN_CONFLICT", `Note ${JSON.stringify(req.params.id)} is not in conflict`);
    }
    const given = ["with", "content", "delete"].filter((key) => Object.hasOwn(choice, key));
    if (given.length !== 1) {
      throw new HttpError(400, "BAD_REQUEST", "Send exactly one of with, content and delete");
    }
    if (Object.hasOwn(choice, "with")) {
      const index = choice.with;
      const version = typeof index === "number" ? conflict.versions[index] : undefined;
      if (version === undefined) {
        throw new HttpError(400, "BAD_REQUEST", `with must be the index of one of the ${conflict.versions.length} versions`);
      }
      await conflict.resolveWith(version.document);
    } else if (Object.hasOwn(choice, "content")) {
      await conflict.resolveWithContent({ content: readNote(choice.content) });
    } else if (choice.delete === true) {
      await conflict.resolveByDeleting();
    } else {
      throw new HttpError(400, "BAD_REQUEST", "delete must be true");
    }
    // undefined once the note is deleted and no longer in conflict.
    const resolved = await person.get<Note>(conflict.primaryId);
    res.json({ note: resolved === undefined ? null : noteJson(resolved, await isInConflict(resolved)) });
  });

  // { peer: "<name>" }: pull from that peer, then push to it.
  app.post("/api/sync", async (req, res) => {
    const peerName = body(req).peer;
    const peer = peers.find((p) => p.name === peerName);
    if (peer === undefined) {
      throw new HttpError(400, "UNKNOWN_PEER", `No peer ${JSON.stringify(peerName)}; peers are ${peers.map((p) => p.name).join(", ")}`);
    }
    if (!online) {
      throw new HttpError(409, "OFFLINE", `Replica ${name} is offline`);
    }
    res.json(await syncWith(service, peer));
  });

  // For the other replicas. All run as the service.

  app.use("/sync", (_req, _res, next) => {
    next(online ? undefined : new HttpError(503, "OFFLINE", `Replica ${name} is offline`));
  });

  app.get("/sync/position", async (req, res) => {
    const source = req.query.source;
    if (typeof source !== "string") {
      throw new HttpError(400, "BAD_REQUEST", "source must be an instance ID");
    }
    res.json({ instanceId: service.instanceId, position: await service.syncPosition(source) });
  });

  app.get("/sync/changes", async (req, res) => {
    const since = readCount(req.query.since, "since");
    const limit = readCount(req.query.limit, "limit");
    res.json(await service.exportChanges({ since, limit }));
  });

  app.post("/sync/changes", async (req, res) => {
    res.json(await service.applyChanges(req.body));
  });

  app.use((req, _res, next) => {
    next(new HttpError(404, "NOT_FOUND", `No route ${req.method} ${req.path}`));
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, body } = toErrorResponse(error, name);
    res.status(status).json(body);
  });

  return app;
}
