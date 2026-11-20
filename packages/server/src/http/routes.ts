// The route table: every route the server answers, with its handler. See
// route.ts for what an entry is.

import { admit } from "../auth/admission.js";
import { safeReturnTo } from "../auth/checks.js";
import { serializeCookie } from "../auth/cookies.js";
import { LOGIN_STATE_SECONDS } from "../auth/login-states.js";
import { LoginError, OidcClient } from "../auth/oidc.js";
import type { PersonEntry } from "../directory/directory.js";
import type { Person as StoredPerson, Status } from "../directory/person.js";
import { compareStrings, emailProblem, normalizeEmail } from "../text.js";
import { DATABASE_ROUTES } from "./database-routes.js";
import { ApiError } from "./errors.js";
import { homePage, loginRefusedPage, OUTCOME_STATUS, type LoginOutcome } from "./pages.js";
import type { Context, Reply, ResponseDoc, Route, Services } from "./route.js";
import {
  Health,
  invitationsQuery,
  Me,
  NewInvitation,
  OpenApiDocument,
  PAGE_LIMIT,
  PeoplePage,
  peopleQuery,
  Person,
  PersonCard,
  ServerAdminChange,
  ErrorBody,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Shapes

/** A person as the API shows them to server admins: copied field by field. */
export function personJson(person: StoredPerson) {
  return {
    personId: person.personId,
    email: person.email,
    displayName: person.displayName,
    status: person.status,
    statusAt: person.statusAt,
    statusBy: person.statusBy,
    serverAdmin: person.serverAdmin,
    invitedBy: person.invitedBy,
    invitedAt: person.invitedAt,
    logins: person.logins.map((login) => ({ issuer: login.issuer, subject: login.subject, addedAt: login.addedAt })),
  };
}

/** A person's version for ETag and If-Match: the conflict's version while the document is in conflict. */
export function personVersion(entry: PersonEntry): string {
  return entry.conflictVersion ?? entry.version;
}

const personReply = (entry: PersonEntry, status = 200): Reply => ({ status, json: personJson(entry.person), etag: personVersion(entry) });

// ---------------------------------------------------------------------------
// People lists

function encodeCursor(person: StoredPerson): string {
  return Buffer.from(JSON.stringify([person.email, person.personId]), "utf8").toString("base64url");
}

function decodeCursor(after: string): [string, string] {
  try {
    const value: unknown = JSON.parse(Buffer.from(after, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string") {
      return [value[0], value[1]];
    }
  } catch {
    // Not one of ours; refused below.
  }
  throw new ApiError("INVALID_INPUT", 'The query parameter "after" is not a value this server gave as "next"', { parameter: "after" });
}

function byEmail(a: StoredPerson, b: StoredPerson): number {
  return compareStrings(a.email, b.email) || compareStrings(a.personId, b.personId);
}

/** One page of people, in email order, filtered by status and by text in the email or display name. */
function listPeople(context: Context, status: Status | undefined) {
  const q = typeof context.query["q"] === "string" ? context.query["q"].normalize("NFC").toLowerCase() : undefined;
  const limit = typeof context.query["limit"] === "number" ? context.query["limit"] : PAGE_LIMIT.default;
  const after = typeof context.query["after"] === "string" ? decodeCursor(context.query["after"]) : undefined;
  const people = context.services.directory.index
    .all()
    .map((entry) => entry.person)
    .filter((person) => status === undefined || person.status === status)
    .filter((person) => q === undefined || person.email.includes(q) || (person.displayName ?? "").normalize("NFC").toLowerCase().includes(q))
    .filter((person) => after === undefined || compareStrings(person.email, after[0]) > 0 || (person.email === after[0] && compareStrings(person.personId, after[1]) > 0))
    .sort(byEmail);
  const shown = people.slice(0, limit);
  const last = shown.at(-1);
  return { people: shown.map(personJson), next: people.length > limit && last !== undefined ? encodeCursor(last) : null };
}

// ---------------------------------------------------------------------------
// Changes to people, by server admins

function activeAdmins(context: Context): number {
  return context.services.directory.index.all().filter((entry) => entry.person.status === "active" && entry.person.serverAdmin).length;
}

function find(context: Context): PersonEntry {
  const personId = context.params["personId"] ?? "";
  const entry = context.services.directory.index.get(personId);
  if (entry === undefined) {
    throw new ApiError("NOT_FOUND", `There is no person ${personId}`);
  }
  return entry;
}

/**
 * Changes a person, if If-Match is still their version when the change is
 * made (changes run one at a time, so the checks inside hold when written).
 */
async function changePerson(context: Context, change: (person: StoredPerson, at: string) => StoredPerson): Promise<PersonEntry> {
  const target = find(context);
  const now = context.services.now();
  return context.services.directory.update(target.person.personId, now, (person, entry) => {
    if (personVersion(entry) !== context.ifMatch) {
      throw new ApiError("STALE_VERSION", "The person has changed since you read them; read them again");
    }
    return change(person, now.toISOString());
  });
}

function refuseLastAdmin(context: Context, person: StoredPerson, what: string): void {
  if (person.status === "active" && person.serverAdmin && activeAdmins(context) <= 1) {
    throw new ApiError("LAST_ADMIN", `${what} would leave no active server admin. Make someone else a server admin first.`);
  }
}

function actor(context: Context): string {
  if (context.person === undefined) {
    throw new Error("A server-admin route ran without a person");
  }
  return context.person.person.personId;
}

// ---------------------------------------------------------------------------
// Login

function loginCookie(services: Services, value: string, maxAge: number): string {
  return serializeCookie(services.cookies.login, value, { path: "/auth", maxAge, secure: services.secure });
}

function sessionCookie(services: Services, value: string, maxAge: number): string {
  return serializeCookie(services.cookies.session, value, { path: "/", maxAge, secure: services.secure });
}

function refused(services: Services, outcome: LoginOutcome, reason: string, cookies: readonly string[] = []): Reply {
  services.log(`Login refused (${outcome}): ${reason}`);
  return { status: OUTCOME_STATUS[outcome], html: loginRefusedPage(services.settings.serverName, outcome), cookies };
}

async function login(context: Context): Promise<Reply> {
  const { services } = context;
  const values = OidcClient.newLogin();
  let url: URL;
  try {
    url = await services.oidc.authorizationUrl(values);
  } catch (error) {
    if (error instanceof LoginError) {
      return refused(services, error.refusal, error.message);
    }
    throw error;
  }
  const id = services.loginStates.add({ ...values, returnTo: safeReturnTo(context.query["returnTo"]) }, services.now());
  return { status: 302, location: url.href, cookies: [loginCookie(services, id, LOGIN_STATE_SECONDS)] };
}

async function callback(context: Context): Promise<Reply> {
  const { services } = context;
  // The login cookie is used once, whatever happens.
  const clear = [loginCookie(services, "", 0)];
  if (context.loginIds.length !== 1) {
    return refused(services, "invalid", context.loginIds.length === 0 ? "the browser sent no login cookie" : "the browser sent more than one login cookie", clear);
  }
  const state = services.loginStates.take(context.loginIds[0] ?? "", services.now());
  if (state === undefined) {
    return refused(services, "invalid", "the login cookie names no login in progress (unknown, used, or expired)", clear);
  }
  let identity;
  try {
    identity = await services.oidc.finish(context.rawQuery, state);
  } catch (error) {
    if (error instanceof LoginError) {
      return refused(services, error.refusal, error.message, clear);
    }
    throw error;
  }
  const admission = await admit(services.directory, identity, services.now());
  if (!admission.ok) {
    return refused(services, admission.refusal, admission.reason, clear);
  }
  const { personId } = admission.entry.person;
  const token = await services.sessions.create(personId);
  services.log(`Login: person ${personId}${admission.admitted ? " (admitted from an invitation)" : ""}`);
  return { status: 302, location: state.returnTo, cookies: [...clear, sessionCookie(services, token, services.sessions.maxAgeSeconds)] };
}

async function logout(context: Context): Promise<Reply> {
  const { services } = context;
  for (const id of context.sessionIds) {
    await services.sessions.end(id);
  }
  const home = `${services.settings.publicUrl}/`;
  const provider = await services.oidc.endSessionUrl(home);
  return { status: 303, location: provider?.href ?? "/", cookies: [sessionCookie(services, "", 0)] };
}

// ---------------------------------------------------------------------------
// The table

const json = (description: string, schema: ResponseDoc["json"], extra: Partial<ResponseDoc> = {}): ResponseDoc => ({ description, json: schema, ...extra });
const notFound = json("NOT_FOUND: there is no such person.", ErrorBody);
const personId = { personId: "The person's ID" };

const SERVER_ROUTES: readonly Route[] = [
  {
    method: "get",
    path: "/",
    operationId: "home",
    summary: "The home page: who is logged in, or a link to log in.",
    tag: "browser",
    auth: "none",
    responses: { 200: { description: "An HTML page.", html: true } },
    handler: (context) => ({
      status: 200,
      html: homePage(context.services.settings.serverName, context.person === undefined ? undefined : (context.person.person.displayName ?? context.person.person.email)),
    }),
  },
  {
    method: "get",
    path: "/auth/login",
    operationId: "login",
    summary: "Starts a login: sends the browser to the login service.",
    tag: "browser",
    auth: "none",
    query: { returnTo: { type: "string", description: "A path on this server to return to; anything else returns to /" } },
    responses: {
      302: { description: "To the login service, with the login cookie set.", redirect: true, setsCookie: true },
      502: { description: "The login service can't be reached: an HTML page.", html: true },
    },
    handler: login,
  },
  {
    method: "get",
    path: "/auth/callback",
    operationId: "loginCallback",
    summary: "Where the login service sends the browser back: finishes the login.",
    tag: "browser",
    auth: "none",
    query: {
      code: { type: "string" },
      state: { type: "string" },
      iss: { type: "string" },
      error: { type: "string" },
    },
    responses: {
      302: { description: "Logged in: to the page the login started from, with the session cookie set.", redirect: true, setsCookie: true },
      400: { description: "The login expired or is not valid: an HTML page.", html: true, setsCookie: true },
      403: { description: "Not admitted (not invited, disabled, email not verified, more than one invitation): an HTML page.", html: true, setsCookie: true },
      502: { description: "The login service can't be reached: an HTML page.", html: true, setsCookie: true },
    },
    handler: callback,
  },
  {
    method: "post",
    path: "/auth/logout",
    operationId: "logout",
    summary: "Ends the session, then sends the browser to the login service to end its session too.",
    tag: "browser",
    auth: "none",
    responses: { 303: { description: "To the login service's logout, or to / without one; the session cookie is removed.", redirect: true, setsCookie: true } },
    handler: logout,
  },
  {
    method: "get",
    path: "/api/v0/health",
    operationId: "health",
    summary: "Whether the server is up.",
    tag: "server",
    auth: "none",
    responses: { 200: json("The server is up.", Health) },
    handler: () => ({ status: 200, json: { status: "ok" } }),
  },
  {
    method: "get",
    path: "/api/v0/openapi.json",
    operationId: "openapi",
    summary: "This description of the API, OpenAPI 3.1.",
    tag: "server",
    auth: "none",
    responses: { 200: json("The description.", OpenApiDocument) },
    handler: (context) => ({ status: 200, json: context.services.openapi }),
  },
  {
    method: "get",
    path: "/api/v0/me",
    operationId: "me",
    summary: "The person logged in.",
    tag: "people",
    auth: "person",
    responses: { 200: json("The person logged in.", Me) },
    handler: (context) => {
      const person = (context.person as PersonEntry).person;
      return { status: 200, json: { personId: person.personId, displayName: person.displayName, email: person.email, serverAdmin: person.serverAdmin } };
    },
  },
  {
    method: "get",
    path: "/api/v0/people",
    operationId: "listPeople",
    summary: "People on this server, in email order; search by email or display name.",
    tag: "people",
    auth: "serverAdmin",
    query: peopleQuery,
    strictQuery: true,
    responses: { 200: json("A page of people.", PeoplePage) },
    handler: (context) => {
      const status = context.query["status"] as Status | undefined;
      return { status: 200, json: listPeople(context, status) };
    },
  },
  {
    method: "get",
    path: "/api/v0/people/{personId}",
    operationId: "getPersonCard",
    summary: "A person's ID and display name: all anyone may see of a person.",
    tag: "people",
    auth: "person",
    pathParams: personId,
    responses: { 200: json("The person's card.", PersonCard), 404: notFound },
    handler: (context) => {
      const { person } = find(context);
      return { status: 200, json: { personId: person.personId, displayName: person.displayName } };
    },
  },
  {
    method: "get",
    path: "/api/v0/people/{personId}/details",
    operationId: "getPerson",
    summary: "A person in full.",
    tag: "people",
    auth: "serverAdmin",
    pathParams: personId,
    responses: { 200: json("The person; ETag is their version.", Person, { etag: true }), 404: notFound },
    handler: (context) => personReply(find(context)),
  },
  {
    method: "post",
    path: "/api/v0/people/{personId}/disable",
    operationId: "disablePerson",
    summary: "Disables a person and ends their sessions. Refused for the last active server admin.",
    tag: "people",
    auth: "serverAdmin",
    ifMatch: true,
    pathParams: personId,
    responses: {
      200: json("The person, disabled; ETag is their new version.", Person, { etag: true }),
      404: notFound,
      409: json("LAST_ADMIN: they are the last active server admin.", ErrorBody),
    },
    handler: async (context) => {
      const by = actor(context);
      const entry = await changePerson(context, (person, at) => {
        if (person.status === "disabled") return person;
        refuseLastAdmin(context, person, "Disabling them");
        return { ...person, status: "disabled", statusAt: at, statusBy: by };
      });
      const ended = await context.services.sessions.endFor(entry.person.personId);
      context.services.log(`Person ${entry.person.personId} disabled by ${by}; ${ended} sessions ended`);
      return personReply(entry);
    },
  },
  {
    method: "post",
    path: "/api/v0/people/{personId}/enable",
    operationId: "enablePerson",
    summary: "Enables a disabled person: active if they have logged in before, else invited again.",
    tag: "people",
    auth: "serverAdmin",
    ifMatch: true,
    pathParams: personId,
    responses: { 200: json("The person; ETag is their new version.", Person, { etag: true }), 404: notFound },
    handler: async (context) => {
      const by = actor(context);
      const entry = await changePerson(context, (person, at) =>
        person.status !== "disabled" ? person : { ...person, status: person.logins.length > 0 ? "active" : "invited", statusAt: at, statusBy: by },
      );
      return personReply(entry);
    },
  },
  {
    method: "put",
    path: "/api/v0/people/{personId}/server-admin",
    operationId: "setServerAdmin",
    summary: "Makes a person a server admin, or not. Refused for the last active server admin.",
    tag: "people",
    auth: "serverAdmin",
    ifMatch: true,
    pathParams: personId,
    body: ServerAdminChange,
    responses: {
      200: json("The person; ETag is their new version.", Person, { etag: true }),
      404: notFound,
      409: json("LAST_ADMIN: they are the last active server admin.", ErrorBody),
    },
    handler: async (context) => {
      const { serverAdmin } = context.body as { serverAdmin: boolean };
      const entry = await changePerson(context, (person, at) => {
        if (person.serverAdmin === serverAdmin) return person;
        if (!serverAdmin) refuseLastAdmin(context, person, "Removing their server admin role");
        return { ...person, serverAdmin, serverAdminAt: at };
      });
      return personReply(entry);
    },
  },
  {
    method: "get",
    path: "/api/v0/invitations",
    operationId: "listInvitations",
    summary: "People invited who haven't logged in yet, in email order.",
    tag: "invitations",
    auth: "serverAdmin",
    query: invitationsQuery,
    strictQuery: true,
    responses: { 200: json("A page of invited people.", PeoplePage) },
    handler: (context) => ({ status: 200, json: listPeople(context, "invited") }),
  },
  {
    method: "post",
    path: "/api/v0/invitations",
    operationId: "invite",
    summary: "Invites someone by email. They are admitted when they first log in with that email, verified.",
    tag: "invitations",
    auth: "serverAdmin",
    body: NewInvitation,
    responses: {
      201: json("The invited person; Location is their details, ETag their version.", Person, { etag: true, location: true }),
      409: json("PERSON_EXISTS: someone with this email is invited, active, or disabled after logging in (details.personId).", ErrorBody),
    },
    handler: async (context) => {
      const body = context.body as { email: string; serverAdmin?: boolean };
      const email = normalizeEmail(body.email);
      const problem = emailProblem(email);
      if (problem !== undefined) {
        throw new ApiError("INVALID_INPUT", `email ${problem}`, { path: "/email" });
      }
      const { directory } = context.services;
      const entry = await directory.invite({
        email,
        serverAdmin: body.serverAdmin ?? false,
        by: actor(context),
        now: context.services.now(),
        check: () => {
          // A disabled invitation never used doesn't count; anyone else does.
          const existing = directory.index.byEmail(email).find((other) => other.person.status !== "disabled" || other.person.logins.length > 0);
          if (existing !== undefined) {
            throw new ApiError("PERSON_EXISTS", `Someone with this email is already ${existing.person.status}`, { personId: existing.person.personId });
          }
        },
      });
      return { ...personReply(entry, 201), location: `/api/v0/people/${entry.person.personId}/details` };
    },
  },
  {
    method: "delete",
    path: "/api/v0/invitations/{personId}",
    operationId: "revokeInvitation",
    summary: "Revokes an invitation: the person becomes disabled, so it can't come back from another server.",
    tag: "invitations",
    auth: "serverAdmin",
    ifMatch: true,
    pathParams: personId,
    responses: {
      200: json("The person, disabled; ETag is their new version.", Person, { etag: true }),
      404: notFound,
      409: json("NOT_INVITED: the person is not (or no longer) invited.", ErrorBody),
    },
    handler: async (context) => {
      const by = actor(context);
      const entry = await changePerson(context, (person, at) => {
        if (person.status !== "invited") {
          throw new ApiError("NOT_INVITED", `The person is ${person.status}, not invited`);
        }
        return { ...person, status: "disabled", statusAt: at, statusBy: by };
      });
      return personReply(entry);
    },
  },
];

/** Every route the server answers. */
export const ROUTES: readonly Route[] = [...SERVER_ROUTES, ...DATABASE_ROUTES];
