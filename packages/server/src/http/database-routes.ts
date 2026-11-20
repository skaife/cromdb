// The routes for databases, their ACLs, documents and conflicts.
//
// The engine decides who may do what in a database, for the person logged
// in: every driver call here is made as that person, never as
// "cromdb-server". The server decides only who the person is, that only
// server admins create databases, and the rules for "cromdb-server" and
// "anonymous" in an ACL.
//
// A person who can't see a database gets 404 from every route under it, as
// for a database that doesn't exist, whatever else is wrong with the
// request, so nobody can probe which databases there are.

import { DriverError, type AclData, type AclLists, type DocumentData, type Input, type OperationName, type Output } from "@cromdb/driver";
import type { OpenDatabase } from "../databases.js";
import { SERVER_PRINCIPAL } from "../directory/directory.js";
import { compareStrings } from "../text.js";
import { ApiError } from "./errors.js";
import type { Context, ResponseDoc, Route } from "./route.js";
import {
  Acl,
  AclLists as AclListsSchema,
  Conflict,
  Database,
  DatabaseList,
  Document,
  DocumentChange,
  DocumentPage,
  ErrorBody,
  FindRequest,
  NewDatabase,
  NewDocument,
  PAGE_LIMIT,
  Resolution,
  SavedDocument,
  Written,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Shapes, copied field by field from the driver's output

type Access = Output<"access.mine">;

function accessJson(access: Access) {
  return { visible: access.visible, read: access.read, write: access.write, create: access.create, admin: access.admin };
}

function databaseJson(database: OpenDatabase, access: Access) {
  const { record } = database;
  return { databaseId: record.databaseId, name: record.name, createdAt: record.createdAt, createdBy: record.createdBy, access: accessJson(access) };
}

function aclJson(acl: AclData) {
  return {
    admins: [...acl.admins],
    creators: [...acl.creators],
    writers: [...acl.writers],
    readers: [...acl.readers],
    noAccess: [...acl.noAccess],
    version: acl.version,
    createdAt: acl.createdAt,
    createdBy: acl.createdBy,
    updatedAt: acl.updatedAt,
    updatedBy: acl.updatedBy,
  };
}

export function documentJson(document: DocumentData) {
  return {
    id: document.id,
    parentId: document.parentId,
    version: document.version,
    deleted: document.deleted,
    content: document.content,
    fieldTypes: { ...document.fieldTypes },
    readers: [...document.readers],
    writers: [...document.writers],
    createdAt: document.createdAt,
    createdBy: document.createdBy,
    updatedAt: document.updatedAt,
    updatedBy: document.updatedBy,
    access: { read: document.access.read, update: document.access.update, delete: document.access.delete },
  };
}

// ---------------------------------------------------------------------------
// From a request to a driver call

function personId(context: Context): string {
  if (context.person === undefined) {
    throw new Error("A database route ran without a person");
  }
  return context.person.person.personId;
}

/** The same answer for a database that doesn't exist and one the person can't see. */
function noDatabase(databaseId: string): ApiError {
  return new ApiError("NOT_FOUND", `There is no database ${databaseId} that you can see`);
}

/** The open database the path names, or 404. A database the server couldn't open is 404 too. */
function database(context: Context): OpenDatabase {
  const databaseId = context.params["databaseId"] ?? "";
  const state = context.services.databases.get(databaseId);
  if (state === undefined || state.status !== "open") {
    throw noDatabase(databaseId);
  }
  return state;
}

type OnDatabase = "handle" | "principal";

/** One driver call on the database, as the person logged in. */
function call<Op extends OperationName>(context: Context, db: OpenDatabase, op: Op, input: Omit<Input<Op>, OnDatabase>): Promise<Output<Op>> {
  return context.services.databases.driver.call(op, { ...input, handle: db.handle, principal: { id: personId(context) } } as Input<Op>);
}

/** What the person may do in the database. Never refused: someone without access gets all false. */
function mine(context: Context, db: OpenDatabase): Promise<Access> {
  return call(context, db, "access.mine", {});
}

/**
 * A driver call whose refusals become the API's: any refusal is 404 for a
 * person who can't see the database. Otherwise ACCESS_DENIED is 403,
 * NOT_FOUND 404, STALE_DOCUMENT 412 STALE_VERSION, READ_ONLY 409, and input
 * the engine refuses 400. Anything else is a fault (500, logged).
 */
async function run<Op extends OperationName>(context: Context, db: OpenDatabase, op: Op, input: Omit<Input<Op>, OnDatabase>): Promise<Output<Op>> {
  try {
    return await call(context, db, op, input);
  } catch (error) {
    if (!(error instanceof DriverError)) {
      throw error;
    }
    if (!(await mine(context, db)).visible) {
      throw noDatabase(db.record.databaseId);
    }
    switch (error.code) {
      case "ACCESS_DENIED":
        throw new ApiError("ACCESS_DENIED", error.message);
      case "NOT_FOUND":
        throw new ApiError("NOT_FOUND", error.message);
      case "STALE_DOCUMENT":
        throw new ApiError("STALE_VERSION", `${error.message}; read it again`);
      case "READ_ONLY":
        throw new ApiError("READ_ONLY", error.message);
      case "INVALID_INPUT":
      case "INVALID_ACCESS_LIST":
        throw new ApiError("INVALID_INPUT", error.message);
      default:
        throw error;
    }
  }
}

/** The documentId path parameter. */
function documentId(context: Context): string {
  return context.params["documentId"] ?? "";
}

/** The optional fields of a document write, as given. */
function documentFields(body: { fieldTypes?: Record<string, "datetime">; readers?: string[]; writers?: string[] }) {
  return {
    ...(body.fieldTypes === undefined ? {} : { fieldTypes: body.fieldTypes }),
    ...(body.readers === undefined ? {} : { readers: body.readers }),
    ...(body.writers === undefined ? {} : { writers: body.writers }),
  };
}

// ---------------------------------------------------------------------------
// The server's rules for a database's ACL

/**
 * Refuses an ACL the server can't keep: "cromdb-server" must stay an admin
 * and out of noAccess, or sync between servers would stop; and the server has
 * no anonymous sessions, so "anonymous" in a list would admit nobody here but
 * everyone on a replica opened outside a server.
 */
export function aclProblem(lists: AclLists): { path: string; problem: string } | undefined {
  for (const [name, list] of Object.entries(lists) as [keyof AclLists, readonly string[]][]) {
    const index = list.findIndex((entry) => entry.toLowerCase() === "anonymous");
    if (index >= 0) {
      return {
        path: `/${name}/${index}`,
        problem: 'is "anonymous": the server has no anonymous sessions. Use "*" for everyone who logs in, or name the people',
      };
    }
  }
  if (!lists.admins.includes(SERVER_PRINCIPAL.id)) {
    return { path: "/admins", problem: `must include "${SERVER_PRINCIPAL.id}", which servers sync the database as` };
  }
  const blocked = lists.noAccess.indexOf(SERVER_PRINCIPAL.id);
  if (blocked >= 0) {
    return { path: `/noAccess/${blocked}`, problem: `is "${SERVER_PRINCIPAL.id}", which servers sync the database as; it can't be locked out` };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The table

const json = (description: string, schema: ResponseDoc["json"], extra: Partial<ResponseDoc> = {}): ResponseDoc => ({ description, json: schema, ...extra });
const error = (description: string): ResponseDoc => json(description, ErrorBody);

const NO_DATABASE = "There is no such database, or you can't see it.";
const notFound = error(`NOT_FOUND: ${NO_DATABASE}`);
const notFoundDocument = error(`NOT_FOUND: ${NO_DATABASE} Or no document with this ID that you can read.`);
const databaseParam = { databaseId: "The database's ID" };
const documentParams = { ...databaseParam, documentId: "The document's ID" };
const conflictRefused = error("ACCESS_DENIED: you can't write this document.");

export const DATABASE_ROUTES: readonly Route[] = [
  {
    method: "get",
    path: "/api/v0/databases",
    operationId: "listDatabases",
    summary: "The databases you can see, by name, with what you may do in each. Server admins also see the ones the server couldn't open.",
    tag: "databases",
    auth: "person",
    responses: { 200: json("The databases.", DatabaseList) },
    handler: async (context) => {
      const databases = [];
      const unavailable = [];
      for (const state of context.services.databases.list()) {
        if (state.status === "open") {
          const access = await mine(context, state);
          if (access.visible) databases.push(databaseJson(state, access));
        } else if (context.person?.person.serverAdmin === true) {
          unavailable.push({ databaseId: state.record.databaseId, name: state.record.name, reason: state.reason });
        }
      }
      const byName = (a: { name: string; databaseId: string }, b: { name: string; databaseId: string }) =>
        compareStrings(a.name, b.name) || compareStrings(a.databaseId, b.databaseId);
      return { status: 200, json: { databases: databases.sort(byName), unavailable: unavailable.sort(byName) } };
    },
  },
  {
    method: "post",
    path: "/api/v0/databases",
    operationId: "createDatabase",
    summary: 'Makes a database. You are its first admin, creator, writer and reader; "cromdb-server" is an admin too, for sync.',
    tag: "databases",
    auth: "serverAdmin",
    body: NewDatabase,
    responses: { 201: json("The new database; Location is where it is.", Database, { location: true }) },
    handler: async (context) => {
      const name = (context.body as { name: string }).name.trim();
      if (name === "") {
        throw new ApiError("INVALID_INPUT", "name must not be blank", { path: "/name" });
      }
      const db = await context.services.databases.create({ name, personId: personId(context), now: context.services.now() });
      return { status: 201, json: databaseJson(db, await mine(context, db)), location: `/api/v0/databases/${db.record.databaseId}` };
    },
  },
  {
    method: "get",
    path: "/api/v0/databases/{databaseId}",
    operationId: "getDatabase",
    summary: "A database, with what you may do in it.",
    tag: "databases",
    auth: "person",
    pathParams: databaseParam,
    responses: { 200: json("The database.", Database), 404: notFound },
    handler: async (context) => {
      const db = database(context);
      const access = await mine(context, db);
      if (!access.visible) {
        throw noDatabase(db.record.databaseId);
      }
      return { status: 200, json: databaseJson(db, access) };
    },
  },
  {
    method: "get",
    path: "/api/v0/databases/{databaseId}/acl",
    operationId: "getAcl",
    summary: "The database's access lists. For its admins.",
    tag: "databases",
    auth: "person",
    pathParams: databaseParam,
    responses: {
      200: json("The access lists; ETag is their version.", Acl, { etag: true }),
      403: error("ACCESS_DENIED: you aren't an admin of this database."),
      404: notFound,
    },
    handler: async (context) => {
      const { acl } = await run(context, database(context), "acl.get", {});
      return { status: 200, json: aclJson(acl), etag: acl.version };
    },
  },
  {
    method: "put",
    path: "/api/v0/databases/{databaseId}/acl",
    operationId: "saveAcl",
    summary:
      'Replaces the database\'s access lists, all five. For its admins. "cromdb-server" must stay in admins and out of noAccess, and "anonymous" isn\'t taken.',
    tag: "databases",
    auth: "person",
    ifMatch: true,
    pathParams: databaseParam,
    body: AclListsSchema,
    responses: {
      200: json("The access lists; ETag is their new version.", Acl, { etag: true }),
      403: error("ACCESS_DENIED: you aren't an admin of this database, or you would lock yourself out."),
      404: notFound,
    },
    handler: async (context) => {
      const db = database(context);
      if (!(await mine(context, db)).visible) {
        throw noDatabase(db.record.databaseId);
      }
      const lists = context.body as AclLists;
      const problem = aclProblem(lists);
      if (problem !== undefined) {
        throw new ApiError("INVALID_INPUT", `The body at "${problem.path}" ${problem.problem}`, { path: problem.path });
      }
      const { acl } = await run(context, db, "acl.save", {
        ifVersion: context.ifMatch ?? "",
        admins: lists.admins,
        creators: lists.creators,
        writers: lists.writers,
        readers: lists.readers,
        noAccess: lists.noAccess,
      });
      return { status: 200, json: aclJson(acl), etag: acl.version };
    },
  },
  {
    method: "post",
    path: "/api/v0/databases/{databaseId}/documents",
    operationId: "createDocument",
    summary: 'Makes a document. Readers and writers default to "*", everyone with access to the database; you are always among the writers.',
    tag: "documents",
    auth: "person",
    pathParams: databaseParam,
    body: NewDocument,
    responses: {
      201: json("The new document; Location is where it is, ETag its version.", Document, { etag: true, location: true }),
      403: error("ACCESS_DENIED: you can't make documents in this database."),
      404: notFound,
    },
    handler: async (context) => {
      const db = database(context);
      const body = context.body as Input<"documents.create">;
      let created: Output<"documents.create">;
      try {
        created = await run(context, db, "documents.create", {
          content: body.content,
          ...documentFields(body as Parameters<typeof documentFields>[0]),
          ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
        });
      } catch (error) {
        // The database is there and visible, so what isn't found is the parent.
        if (error instanceof ApiError && error.code === "NOT_FOUND" && body.parentId !== undefined) {
          throw new ApiError("INVALID_INPUT", `${error.message}, or you can't read it`, { path: "/parentId" });
        }
        throw error;
      }
      const { document } = created;
      return {
        status: 201,
        json: documentJson(document),
        etag: document.version,
        location: `/api/v0/databases/${db.record.databaseId}/documents/${document.id}`,
      };
    },
  },
  {
    method: "get",
    path: "/api/v0/databases/{databaseId}/documents/{documentId}",
    operationId: "getDocument",
    summary: "A document you can read. A version in a conflict can be read too, by its own ID; it is read-only.",
    tag: "documents",
    auth: "person",
    pathParams: documentParams,
    responses: { 200: json("The document; ETag is its version.", Document, { etag: true }), 404: notFoundDocument },
    handler: async (context) => {
      const db = database(context);
      const { document } = await run(context, db, "documents.get", { id: documentId(context) });
      if (document === null) {
        throw new ApiError("NOT_FOUND", `There is no document ${documentId(context)} that you can read`);
      }
      return { status: 200, json: documentJson(document), etag: document.version };
    },
  },
  {
    method: "put",
    path: "/api/v0/databases/{databaseId}/documents/{documentId}",
    operationId: "saveDocument",
    summary: "Replaces a document's content, and its readers or writers if given.",
    tag: "documents",
    auth: "person",
    ifMatch: true,
    pathParams: documentParams,
    body: DocumentChange,
    responses: {
      200: json("The document saved; ETag is its new version. editedThroughConflict: the document was in conflict, and stays so.", SavedDocument, { etag: true }),
      403: conflictRefused,
      404: notFoundDocument,
      409: error("READ_ONLY: this is a version in a conflict; resolve the conflict instead."),
    },
    handler: async (context) => {
      const body = context.body as Input<"documents.save">;
      const { document, editedThroughConflict } = await run(context, database(context), "documents.save", {
        id: documentId(context),
        ifVersion: context.ifMatch ?? "",
        content: body.content,
        ...documentFields(body as Parameters<typeof documentFields>[0]),
      });
      return { status: 200, json: { document: documentJson(document), editedThroughConflict }, etag: document.version };
    },
  },
  {
    method: "delete",
    path: "/api/v0/databases/{databaseId}/documents/{documentId}",
    operationId: "deleteDocument",
    summary: "Deletes a document.",
    tag: "documents",
    auth: "person",
    ifMatch: true,
    pathParams: documentParams,
    responses: {
      200: json("Deleted.", Written),
      403: conflictRefused,
      404: notFoundDocument,
      409: error("READ_ONLY: this is a version in a conflict; resolve the conflict instead."),
    },
    handler: async (context) => {
      const { editedThroughConflict } = await run(context, database(context), "documents.delete", { id: documentId(context), ifVersion: context.ifMatch ?? "" });
      return { status: 200, json: { editedThroughConflict } };
    },
  },
  {
    method: "post",
    path: "/api/v0/databases/{databaseId}/find",
    operationId: "findDocuments",
    summary: `Documents you can read that match the filter, oldest first, in pages (limit ${PAGE_LIMIT.default} by default, at most ${PAGE_LIMIT.max}). A POST, because filters are JSON; it changes nothing.`,
    tag: "documents",
    auth: "person",
    pathParams: databaseParam,
    body: FindRequest,
    responses: { 200: json("A page of documents.", DocumentPage), 404: notFound },
    handler: async (context) => {
      const body = context.body as { filter?: Input<"documents.find">["filter"]; limit?: number; after?: string };
      const page = await run(context, database(context), "documents.find", {
        limit: body.limit ?? PAGE_LIMIT.default,
        ...(body.filter === undefined ? {} : { filter: body.filter }),
        ...(body.after === undefined ? {} : { after: body.after }),
      });
      return { status: 200, json: { documents: page.documents.map(documentJson), next: page.next } };
    },
  },
  {
    method: "get",
    path: "/api/v0/databases/{databaseId}/documents/{documentId}/conflict",
    operationId: "getConflict",
    summary: "A document's conflict: every version of it you can read.",
    tag: "documents",
    auth: "person",
    pathParams: documentParams,
    responses: {
      200: json("The conflict; ETag is its version, to send when resolving it.", Conflict, { etag: true }),
      404: error(`NOT_FOUND: ${NO_DATABASE} Or no document with this ID that you can read, or it isn't in conflict.`),
    },
    handler: async (context) => {
      const { conflict } = await run(context, database(context), "conflicts.get", { id: documentId(context) });
      if (conflict === null) {
        throw new ApiError("NOT_FOUND", `Document ${documentId(context)} isn't in conflict, or you can't read it`);
      }
      return {
        status: 200,
        json: {
          primaryId: conflict.primaryId,
          version: conflict.version,
          versions: conflict.versions.map((version) => ({
            document: documentJson(version.document),
            isPrimary: version.isPrimary,
            authorized: version.authorized,
            deleted: version.deleted,
          })),
        },
        etag: conflict.version,
      };
    },
  },
  {
    method: "post",
    path: "/api/v0/databases/{databaseId}/documents/{documentId}/conflict/resolve",
    operationId: "resolveConflict",
    summary: "Resolves a document's conflict: with one of its versions (chooseId), with new content, or by deleting the document.",
    tag: "documents",
    auth: "person",
    ifMatch: true,
    pathParams: documentParams,
    body: Resolution,
    responses: {
      200: json("Resolved.", Written),
      403: conflictRefused,
      404: error(`NOT_FOUND: ${NO_DATABASE} Or no document with this ID that you can read, or no version chooseId in its conflict.`),
    },
    handler: async (context) => {
      const db = database(context);
      const id = documentId(context);
      const conflictVersion = context.ifMatch ?? "";
      const body = context.body as { chooseId?: string; delete?: true } & Partial<Input<"conflicts.resolveWithContent">>;
      let written;
      if (body.chooseId !== undefined) {
        written = await run(context, db, "conflicts.resolveWith", { id, conflictVersion, chosenId: body.chooseId });
      } else if (body.delete === true) {
        written = await run(context, db, "conflicts.resolveByDeleting", { id, conflictVersion });
      } else {
        written = await run(context, db, "conflicts.resolveWithContent", {
          id,
          conflictVersion,
          content: body.content ?? {},
          ...documentFields(body as Parameters<typeof documentFields>[0]),
        });
      }
      return { status: 200, json: { editedThroughConflict: written.editedThroughConflict } };
    },
  },
];
