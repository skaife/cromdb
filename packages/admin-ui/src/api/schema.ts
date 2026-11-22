// Generated from the server's openapi.json by scripts/gen-api.ts. Don't edit it:
// after changing the route table, run "npm run gen:api -w @cromdb/admin-ui".
// A test fails while it differs from what the route table gives.

export interface Schemas {
  Error: {
    error: {
      code: string;
      message: string;
      details?: {
        [key: string]: unknown;
      };
    };
  };
  Health: {
    status: "ok";
  };
  Me: {
    personId: string;
    displayName: string | null;
    email: string;
    serverAdmin: boolean;
    serverName: string;
  };
  About: {
    serverName: string;
  };
  PersonCard: {
    personId: string;
    displayName: string | null;
  };
  PersonCards: {
    people: Schemas["PersonCard"][];
  };
  Person: {
    personId: string;
    email: string;
    displayName: string | null;
    status: "invited" | "active" | "disabled";
    statusAt: string;
    statusBy: string;
    serverAdmin: boolean;
    invitedBy: string;
    invitedAt: string;
    logins: Schemas["Login"][];
  };
  Login: {
    issuer: string;
    subject: string;
    addedAt: string;
  };
  PeoplePage: {
    people: Schemas["Person"][];
    next: string | null;
  };
  ServerAdminChange: {
    serverAdmin: boolean;
  };
  NewInvitation: {
    email: string;
    serverAdmin?: boolean;
  };
  Access: {
    visible: boolean;
    read: boolean;
    write: boolean;
    create: boolean;
    admin: boolean;
  };
  Database: {
    databaseId: string;
    name: string;
    createdAt: string;
    createdBy: string;
    access: Schemas["Access"];
  };
  UnavailableDatabase: {
    databaseId: string;
    name: string;
    reason: string;
  };
  DatabaseList: {
    databases: Schemas["Database"][];
    unavailable: Schemas["UnavailableDatabase"][];
  };
  NewDatabase: {
    name: string;
  };
  DatabaseSummary: {
    replicas: number;
    conflicts: number;
    conflictsCapped: boolean;
  };
  DatabaseSettings: {
    databaseId: string;
    name: string;
    purgeAfterDays: number;
    level: number;
  };
  DatabaseSettingsChange: {
    name: string;
    purgeAfterDays: number;
  };
  Replica: {
    instanceId: string;
    name?: string;
    createdAt: string;
    thisCopy: boolean;
    knownThrough?: number;
  };
  ReplicaList: {
    replicas: Schemas["Replica"][];
    stale: boolean;
    staleSource?: string;
    purgedThrough: number;
  };
  AclLists: {
    admins: string[];
    creators: string[];
    writers: string[];
    readers: string[];
    noAccess: string[];
  };
  Acl: {
    admins: string[];
    creators: string[];
    writers: string[];
    readers: string[];
    noAccess: string[];
    version: string;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    updatedBy: string;
  };
  DocumentAccess: {
    read: boolean;
    update: boolean;
    delete: boolean;
  };
  Document: {
    id: string;
    parentId: string;
    version: string;
    deleted: boolean;
    content: {
      [key: string]: unknown;
    };
    fieldTypes: {
      [key: string]: "datetime";
    };
    readers: string[];
    writers: string[];
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    updatedBy: string;
    updatedOn: string;
    inConflict: boolean;
    access: Schemas["DocumentAccess"];
  };
  NewDocument: {
    content: {
      [key: string]: unknown;
    };
    fieldTypes?: {
      [key: string]: "datetime";
    };
    readers?: string[];
    writers?: string[];
    parentId?: string;
  };
  DocumentChange: {
    content: {
      [key: string]: unknown;
    };
    fieldTypes?: {
      [key: string]: "datetime";
    };
    readers?: string[];
    writers?: string[];
  };
  SavedDocument: {
    document: Schemas["Document"];
    editedThroughConflict: boolean;
  };
  Written: {
    editedThroughConflict: boolean;
  };
  FindRequest: {
    filter?: {
      parentId?: string;
      topLevel?: boolean;
      orphaned?: boolean;
      inConflict?: boolean;
      where?: {
        [key: string]: string | number | boolean | null;
      };
      whereTypes?: {
        [key: string]: "datetime";
      };
    };
    limit?: number;
    after?: string;
  };
  DocumentPage: {
    documents: Schemas["Document"][];
    next: string | null;
  };
  ConflictVersion: {
    document: Schemas["Document"];
    isPrimary: boolean;
    authorized: boolean;
    deleted: boolean;
  };
  Conflict: {
    primaryId: string;
    version: string;
    versions: Schemas["ConflictVersion"][];
  };
  Resolution: {
    chooseId: string;
  } | {
    content: {
      [key: string]: unknown;
    };
    fieldTypes?: {
      [key: string]: "datetime";
    };
    readers?: string[];
    writers?: string[];
  } | {
    delete: true;
  };
}

/** Each API operation's method and path. */
export const OPERATIONS = {
  health: { method: "GET", path: "/api/v0/health", ifMatch: false },
  openapi: { method: "GET", path: "/api/v0/openapi.json", ifMatch: false },
  about: { method: "GET", path: "/api/v0/server/about", ifMatch: false },
  me: { method: "GET", path: "/api/v0/me", ifMatch: false },
  listPeople: { method: "GET", path: "/api/v0/people", ifMatch: false },
  getPersonCards: { method: "GET", path: "/api/v0/people/cards", ifMatch: false },
  getPersonCard: { method: "GET", path: "/api/v0/people/{personId}", ifMatch: false },
  getPerson: { method: "GET", path: "/api/v0/people/{personId}/details", ifMatch: false },
  disablePerson: { method: "POST", path: "/api/v0/people/{personId}/disable", ifMatch: true },
  enablePerson: { method: "POST", path: "/api/v0/people/{personId}/enable", ifMatch: true },
  setServerAdmin: { method: "PUT", path: "/api/v0/people/{personId}/server-admin", ifMatch: true },
  listInvitations: { method: "GET", path: "/api/v0/invitations", ifMatch: false },
  invite: { method: "POST", path: "/api/v0/invitations", ifMatch: false },
  revokeInvitation: { method: "DELETE", path: "/api/v0/invitations/{personId}", ifMatch: true },
  listDatabases: { method: "GET", path: "/api/v0/databases", ifMatch: false },
  createDatabase: { method: "POST", path: "/api/v0/databases", ifMatch: false },
  getDatabase: { method: "GET", path: "/api/v0/databases/{databaseId}", ifMatch: false },
  getDatabaseSummary: { method: "GET", path: "/api/v0/databases/{databaseId}/summary", ifMatch: false },
  getDatabaseSettings: { method: "GET", path: "/api/v0/databases/{databaseId}/settings", ifMatch: false },
  saveDatabaseSettings: { method: "PUT", path: "/api/v0/databases/{databaseId}/settings", ifMatch: true },
  listReplicas: { method: "GET", path: "/api/v0/databases/{databaseId}/replicas", ifMatch: false },
  getAcl: { method: "GET", path: "/api/v0/databases/{databaseId}/acl", ifMatch: false },
  saveAcl: { method: "PUT", path: "/api/v0/databases/{databaseId}/acl", ifMatch: true },
  createDocument: { method: "POST", path: "/api/v0/databases/{databaseId}/documents", ifMatch: false },
  getDocument: { method: "GET", path: "/api/v0/databases/{databaseId}/documents/{documentId}", ifMatch: false },
  saveDocument: { method: "PUT", path: "/api/v0/databases/{databaseId}/documents/{documentId}", ifMatch: true },
  deleteDocument: { method: "DELETE", path: "/api/v0/databases/{databaseId}/documents/{documentId}", ifMatch: true },
  findDocuments: { method: "POST", path: "/api/v0/databases/{databaseId}/find", ifMatch: false },
  getConflict: { method: "GET", path: "/api/v0/databases/{databaseId}/documents/{documentId}/conflict", ifMatch: false },
  resolveConflict: { method: "POST", path: "/api/v0/databases/{databaseId}/documents/{documentId}/conflict/resolve", ifMatch: true },
} as const;

export interface Operations {
  health: {
    params: Record<string, never>;
    query: Record<string, never>;
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["Health"];
      500: Schemas["Error"];
    };
  };
  openapi: {
    params: Record<string, never>;
    query: Record<string, never>;
    body: undefined;
    ifMatch: false;
    responses: {
      200: {
        [key: string]: unknown;
      };
      500: Schemas["Error"];
    };
  };
  about: {
    params: Record<string, never>;
    query: Record<string, never>;
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["About"];
      500: Schemas["Error"];
    };
  };
  me: {
    params: Record<string, never>;
    query: Record<string, never>;
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["Me"];
      401: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  listPeople: {
    params: Record<string, never>;
    query: {
      q?: string;
      status?: "invited" | "active" | "disabled";
      limit?: number;
      after?: string;
    };
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["PeoplePage"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  getPersonCards: {
    params: Record<string, never>;
    query: {
      ids?: string;
    };
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["PersonCards"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  getPersonCard: {
    params: { personId: string; };
    query: Record<string, never>;
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["PersonCard"];
      401: Schemas["Error"];
      404: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  getPerson: {
    params: { personId: string; };
    query: Record<string, never>;
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["Person"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      404: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  disablePerson: {
    params: { personId: string; };
    query: Record<string, never>;
    body: undefined;
    ifMatch: true;
    responses: {
      200: Schemas["Person"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      404: Schemas["Error"];
      409: Schemas["Error"];
      412: Schemas["Error"];
      413: Schemas["Error"];
      415: Schemas["Error"];
      428: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  enablePerson: {
    params: { personId: string; };
    query: Record<string, never>;
    body: undefined;
    ifMatch: true;
    responses: {
      200: Schemas["Person"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      404: Schemas["Error"];
      412: Schemas["Error"];
      413: Schemas["Error"];
      415: Schemas["Error"];
      428: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  setServerAdmin: {
    params: { personId: string; };
    query: Record<string, never>;
    body: Schemas["ServerAdminChange"];
    ifMatch: true;
    responses: {
      200: Schemas["Person"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      404: Schemas["Error"];
      409: Schemas["Error"];
      412: Schemas["Error"];
      413: Schemas["Error"];
      415: Schemas["Error"];
      428: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  listInvitations: {
    params: Record<string, never>;
    query: {
      q?: string;
      limit?: number;
      after?: string;
    };
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["PeoplePage"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  invite: {
    params: Record<string, never>;
    query: Record<string, never>;
    body: Schemas["NewInvitation"];
    ifMatch: false;
    responses: {
      201: Schemas["Person"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      409: Schemas["Error"];
      413: Schemas["Error"];
      415: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  revokeInvitation: {
    params: { personId: string; };
    query: Record<string, never>;
    body: undefined;
    ifMatch: true;
    responses: {
      200: Schemas["Person"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      404: Schemas["Error"];
      409: Schemas["Error"];
      412: Schemas["Error"];
      413: Schemas["Error"];
      415: Schemas["Error"];
      428: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  listDatabases: {
    params: Record<string, never>;
    query: Record<string, never>;
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["DatabaseList"];
      401: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  createDatabase: {
    params: Record<string, never>;
    query: Record<string, never>;
    body: Schemas["NewDatabase"];
    ifMatch: false;
    responses: {
      201: Schemas["Database"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      413: Schemas["Error"];
      415: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  getDatabase: {
    params: { databaseId: string; };
    query: Record<string, never>;
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["Database"];
      401: Schemas["Error"];
      404: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  getDatabaseSummary: {
    params: { databaseId: string; };
    query: Record<string, never>;
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["DatabaseSummary"];
      401: Schemas["Error"];
      404: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  getDatabaseSettings: {
    params: { databaseId: string; };
    query: Record<string, never>;
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["DatabaseSettings"];
      401: Schemas["Error"];
      404: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  saveDatabaseSettings: {
    params: { databaseId: string; };
    query: Record<string, never>;
    body: Schemas["DatabaseSettingsChange"];
    ifMatch: true;
    responses: {
      200: Schemas["DatabaseSettings"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      404: Schemas["Error"];
      412: Schemas["Error"];
      413: Schemas["Error"];
      415: Schemas["Error"];
      428: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  listReplicas: {
    params: { databaseId: string; };
    query: Record<string, never>;
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["ReplicaList"];
      401: Schemas["Error"];
      404: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  getAcl: {
    params: { databaseId: string; };
    query: Record<string, never>;
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["Acl"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      404: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  saveAcl: {
    params: { databaseId: string; };
    query: Record<string, never>;
    body: Schemas["AclLists"];
    ifMatch: true;
    responses: {
      200: Schemas["Acl"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      404: Schemas["Error"];
      412: Schemas["Error"];
      413: Schemas["Error"];
      415: Schemas["Error"];
      428: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  createDocument: {
    params: { databaseId: string; };
    query: Record<string, never>;
    body: Schemas["NewDocument"];
    ifMatch: false;
    responses: {
      201: Schemas["Document"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      404: Schemas["Error"];
      413: Schemas["Error"];
      415: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  getDocument: {
    params: { databaseId: string; documentId: string; };
    query: Record<string, never>;
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["Document"];
      401: Schemas["Error"];
      404: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  saveDocument: {
    params: { databaseId: string; documentId: string; };
    query: Record<string, never>;
    body: Schemas["DocumentChange"];
    ifMatch: true;
    responses: {
      200: Schemas["SavedDocument"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      404: Schemas["Error"];
      409: Schemas["Error"];
      412: Schemas["Error"];
      413: Schemas["Error"];
      415: Schemas["Error"];
      428: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  deleteDocument: {
    params: { databaseId: string; documentId: string; };
    query: Record<string, never>;
    body: undefined;
    ifMatch: true;
    responses: {
      200: Schemas["Written"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      404: Schemas["Error"];
      409: Schemas["Error"];
      412: Schemas["Error"];
      413: Schemas["Error"];
      415: Schemas["Error"];
      428: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  findDocuments: {
    params: { databaseId: string; };
    query: Record<string, never>;
    body: Schemas["FindRequest"];
    ifMatch: false;
    responses: {
      200: Schemas["DocumentPage"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      404: Schemas["Error"];
      413: Schemas["Error"];
      415: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  getConflict: {
    params: { databaseId: string; documentId: string; };
    query: Record<string, never>;
    body: undefined;
    ifMatch: false;
    responses: {
      200: Schemas["Conflict"];
      401: Schemas["Error"];
      404: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
  resolveConflict: {
    params: { databaseId: string; documentId: string; };
    query: Record<string, never>;
    body: Schemas["Resolution"];
    ifMatch: true;
    responses: {
      200: Schemas["Written"];
      400: Schemas["Error"];
      401: Schemas["Error"];
      403: Schemas["Error"];
      404: Schemas["Error"];
      412: Schemas["Error"];
      413: Schemas["Error"];
      415: Schemas["Error"];
      428: Schemas["Error"];
      500: Schemas["Error"];
    };
  };
}
