// JSON Schema (2020-12) for the API's request and response bodies. The same
// objects check requests at run time, check responses in tests, and go into
// openapi.json under components.schemas by the names in NAMED_SCHEMAS.
//
// Every object is closed (additionalProperties: false), so a field that isn't
// documented can't reach a client unnoticed.

import { STATUSES } from "../directory/person.js";

export type Schema = Readonly<Record<string, unknown>>;

function object(properties: Record<string, Schema>, required: readonly string[] = Object.keys(properties)): Schema {
  return { type: "object", properties, required, additionalProperties: false };
}

const string: Schema = { type: "string" };
const boolean: Schema = { type: "boolean" };
/** An ISO 8601 date and time in UTC, as Date.prototype.toISOString writes it. */
const timestamp: Schema = { type: "string", format: "date-time" };
const nullableString: Schema = { type: ["string", "null"] };

/** Every error response: a code to act on and a message for people. */
export const ErrorBody: Schema = object({
  error: object(
    {
      code: string,
      message: string,
      details: { type: "object" },
    },
    ["code", "message"],
  ),
});

export const Health: Schema = object({ status: { const: "ok" } });

/** The description of this API, as served. */
export const OpenApiDocument: Schema = { type: "object" };

/** The person logged in. */
export const Me: Schema = object({
  personId: string,
  displayName: nullableString,
  email: string,
  serverAdmin: boolean,
});

/** What everyone may see of a person whose ID they hold. */
export const PersonCard: Schema = object({
  personId: string,
  displayName: nullableString,
});

export const Login: Schema = object({ issuer: string, subject: string, addedAt: timestamp });

/** A person in full, for server admins. */
export const Person: Schema = object({
  personId: string,
  email: string,
  displayName: nullableString,
  status: { enum: [...STATUSES] },
  statusAt: timestamp,
  /** A person ID, or "setup" or "console". */
  statusBy: string,
  serverAdmin: boolean,
  invitedBy: string,
  invitedAt: timestamp,
  logins: { type: "array", items: Login },
});

export const PeoplePage: Schema = object({
  people: { type: "array", items: Person },
  /** Pass as "after" for the next page; null on the last page. */
  next: nullableString,
});

export const ServerAdminChange: Schema = object({ serverAdmin: boolean });

export const NewInvitation: Schema = object({ email: { type: "string", minLength: 1, maxLength: 320 }, serverAdmin: boolean }, ["email"]);

/** Names for openapi.json's components.schemas. */
export const NAMED_SCHEMAS: Readonly<Record<string, Schema>> = {
  Error: ErrorBody,
  Health,
  Me,
  PersonCard,
  Person,
  Login,
  PeoplePage,
  ServerAdminChange,
  NewInvitation,
};

/** Query parameters: each one optional, as text. */
export const PAGE_LIMIT = { default: 50, max: 1000 };
export const peopleQuery: Record<string, Schema> = {
  q: { type: "string", maxLength: 320, description: "Text in the email or display name, any case" },
  status: { enum: [...STATUSES] },
  limit: { type: "integer", minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default },
  after: { type: "string", maxLength: 2000, description: "The next value of the page before" },
};
export const invitationsQuery: Record<string, Schema> = {
  q: peopleQuery["q"] as Schema,
  limit: peopleQuery["limit"] as Schema,
  after: peopleQuery["after"] as Schema,
};

/** The error codes the API returns, with their HTTP status. */
export const ERROR_STATUS = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  ACCESS_DENIED: 403,
  BAD_ORIGIN: 403,
  NOT_FOUND: 404,
  PERSON_EXISTS: 409,
  NOT_INVITED: 409,
  LAST_ADMIN: 409,
  STALE_VERSION: 412,
  TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  IF_MATCH_REQUIRED: 428,
  INTERNAL: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;
