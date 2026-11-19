// The directory of people: a level-2 CromDB database reached only through the
// driver, always as "cromdb-server". The server keeps an index of it in
// memory, built at start and updated on every write.
//
// Reads merge: a person whose document is in conflict is every authorized
// version merged (merge.ts), not the engine's interim winner. Only the
// directory's home server will resolve its conflicts (S5); every other
// server merges as it reads. In S3 there is one server, so it is the home.

import { randomUUID } from "node:crypto";
import { DriverError, type DocumentData, type Driver } from "@cromdb/driver";
import { normalizeEmail } from "../text.js";
import { mergePeople } from "./merge.js";
import { loginKey, personContent, readPerson, type Person } from "./person.js";

/** The principal the server uses for its own databases and for sync. */
export const SERVER_PRINCIPAL = { id: "cromdb-server" } as const;
const SERVER_ONLY = [SERVER_PRINCIPAL.id];
const PAGE = 1000;
const WRITE_ATTEMPTS = 3;

export interface PersonEntry {
  readonly person: Person;
  readonly documentId: string;
  readonly version: string;
  /** The conflict's version when the document is in conflict, else null. */
  readonly conflictVersion: string | null;
}

/** A refusal to show a person at the console or (later) in the API. */
export class DirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectoryError";
  }
}

export type Log = (message: string) => void;

/** The in-memory index: by person ID, by login, and by email. */
export class PeopleIndex {
  readonly #byId = new Map<string, PersonEntry>();
  readonly #byLogin = new Map<string, string>();
  readonly #byEmail = new Map<string, Set<string>>();

  set(entry: PersonEntry): void {
    this.delete(entry.person.personId);
    const { person } = entry;
    this.#byId.set(person.personId, entry);
    for (const login of person.logins) {
      this.#byLogin.set(loginKey(login.issuer, login.subject), person.personId);
    }
    const ids = this.#byEmail.get(person.email) ?? new Set<string>();
    ids.add(person.personId);
    this.#byEmail.set(person.email, ids);
  }

  delete(personId: string): void {
    const old = this.#byId.get(personId);
    if (old === undefined) return;
    this.#byId.delete(personId);
    for (const login of old.person.logins) {
      const key = loginKey(login.issuer, login.subject);
      if (this.#byLogin.get(key) === personId) this.#byLogin.delete(key);
    }
    const ids = this.#byEmail.get(old.person.email);
    ids?.delete(personId);
    if (ids?.size === 0) this.#byEmail.delete(old.person.email);
  }

  get(personId: string): PersonEntry | undefined {
    return this.#byId.get(personId);
  }

  byLogin(issuer: string, subject: string): PersonEntry | undefined {
    const personId = this.#byLogin.get(loginKey(issuer, subject));
    return personId === undefined ? undefined : this.#byId.get(personId);
  }

  /** Everyone with this email address, in any status. email is normalized here. */
  byEmail(email: string): PersonEntry[] {
    const ids = this.#byEmail.get(normalizeEmail(email)) ?? new Set<string>();
    return [...ids].map((id) => this.#byId.get(id)).filter((entry) => entry !== undefined);
  }

  all(): PersonEntry[] {
    return [...this.#byId.values()];
  }

  get size(): number {
    return this.#byId.size;
  }
}

export interface DirectoryOptions {
  readonly driver: Driver;
  /** The directory's open handle. */
  readonly handle: string;
  /** This server's serverId, written as changedOn. */
  readonly serverId: string;
  readonly log: Log;
}

export class Directory {
  readonly #driver: Driver;
  readonly #handle: string;
  readonly #serverId: string;
  readonly #log: Log;
  readonly index = new PeopleIndex();

  private constructor(options: DirectoryOptions) {
    this.#driver = options.driver;
    this.#handle = options.handle;
    this.#serverId = options.serverId;
    this.#log = options.log;
  }

  /** The directory on an open handle, with its index loaded. */
  static async load(options: DirectoryOptions): Promise<Directory> {
    const directory = new Directory(options);
    await directory.reload();
    return directory;
  }

  get #on() {
    return { handle: this.#handle, principal: SERVER_PRINCIPAL };
  }

  async #find(filter: { inConflict?: boolean }): Promise<DocumentData[]> {
    const documents: DocumentData[] = [];
    let after: string | undefined;
    do {
      const page = await this.#driver.call("documents.find", {
        ...this.#on,
        filter: { ...filter, where: { type: "person" } },
        limit: PAGE,
        ...(after === undefined ? {} : { after }),
      });
      documents.push(...page.documents);
      after = page.next ?? undefined;
    } while (after !== undefined);
    return documents;
  }

  #read(document: DocumentData): Person | undefined {
    const read = readPerson(document.content);
    if ("problem" in read) {
      this.#log(`Directory document ${document.id} is skipped: ${read.problem}`);
      return undefined;
    }
    return read.person;
  }

  /** The entry for a document read fresh: merged if it is in conflict. */
  async #entry(document: DocumentData): Promise<PersonEntry | undefined> {
    const { conflict } = await this.#driver.call("conflicts.get", { ...this.#on, id: document.id });
    if (conflict === null) {
      const person = this.#read(document);
      return person === undefined ? undefined : { person, documentId: document.id, version: document.version, conflictVersion: null };
    }
    const versions = conflict.versions
      .filter((version) => version.authorized && !version.deleted)
      .map((version) => this.#read(version.document))
      .filter((person) => person !== undefined);
    const ids = new Set(versions.map((person) => person.personId));
    if (versions.length === 0 || ids.size !== 1) {
      this.#log(`Directory document ${document.id} is skipped: its versions don't name one person`);
      return undefined;
    }
    return { person: mergePeople(versions), documentId: document.id, version: document.version, conflictVersion: conflict.version };
  }

  /** Reads every person again. */
  async reload(): Promise<void> {
    const conflicted = new Set((await this.#find({ inConflict: true })).map((document) => document.id));
    const entries: PersonEntry[] = [];
    for (const document of await this.#find({})) {
      const entry = conflicted.has(document.id) ? await this.#entry(document) : this.#readEntry(document);
      if (entry !== undefined) entries.push(entry);
    }
    for (const old of this.index.all()) this.index.delete(old.person.personId);
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.person.personId)) {
        this.#log(`Directory document ${entry.documentId} is skipped: another document has person ${entry.person.personId}`);
        continue;
      }
      seen.add(entry.person.personId);
      this.index.set(entry);
    }
  }

  #readEntry(document: DocumentData): PersonEntry | undefined {
    const person = this.#read(document);
    return person === undefined ? undefined : { person, documentId: document.id, version: document.version, conflictVersion: null };
  }

  /** A new person with status "invited". */
  async invite(input: { email: string; serverAdmin: boolean; by: string; now: Date }): Promise<PersonEntry> {
    const at = input.now.toISOString();
    const person: Person = {
      personId: randomUUID(),
      email: normalizeEmail(input.email),
      emailAt: at,
      status: "invited",
      statusAt: at,
      statusBy: input.by,
      serverAdmin: input.serverAdmin,
      serverAdminAt: at,
      displayName: null,
      displayNameAt: at,
      logins: [],
      invitedBy: input.by,
      invitedAt: at,
      changedAt: at,
      changedOn: this.#serverId,
    };
    const { document } = await this.#driver.call("documents.create", {
      ...this.#on,
      ...personContent(person),
      readers: SERVER_ONLY,
      writers: SERVER_ONLY,
    });
    const entry: PersonEntry = { person, documentId: document.id, version: document.version, conflictVersion: null };
    this.index.set(entry);
    return entry;
  }

  /**
   * Changes a person: change gets the person as stored now (merged) and
   * returns the new person, or the same object for no change. The changed
   * fields' times are change's to set; changedAt and changedOn are set here.
   * If someone else wrote the document in between, it is read again and
   * change runs again.
   */
  async update(personId: string, now: Date, change: (person: Person) => Person): Promise<PersonEntry> {
    let entry = this.index.get(personId);
    for (let attempt = 1; entry !== undefined; attempt++) {
      const changed = change(entry.person);
      if (changed === entry.person) {
        return entry;
      }
      const person: Person = { ...changed, personId, changedAt: now.toISOString(), changedOn: this.#serverId };
      const written = personContent(person);
      try {
        if (entry.conflictVersion === null) {
          await this.#driver.call("documents.save", {
            ...this.#on,
            id: entry.documentId,
            ifVersion: entry.version,
            ...written,
            readers: SERVER_ONLY,
            writers: SERVER_ONLY,
          });
        } else {
          // The merged person resolves the conflict. Only the directory's
          // home server does this (S5); in S3 every server is.
          await this.#driver.call("conflicts.resolveWithContent", {
            ...this.#on,
            id: entry.documentId,
            conflictVersion: entry.conflictVersion,
            ...written,
            readers: SERVER_ONLY,
            writers: SERVER_ONLY,
          });
        }
      } catch (error) {
        if (error instanceof DriverError && error.code === "STALE_DOCUMENT" && attempt < WRITE_ATTEMPTS) {
          entry = await this.#refresh(entry.documentId);
          continue;
        }
        throw error;
      }
      const fresh = await this.#refresh(entry.documentId);
      if (fresh === undefined) {
        throw new DirectoryError(`Person ${personId} could not be read back after the change`);
      }
      return fresh;
    }
    throw new DirectoryError(`There is no person ${personId}`);
  }

  /** Reads one document again and updates the index. */
  async #refresh(documentId: string): Promise<PersonEntry | undefined> {
    const { document } = await this.#driver.call("documents.get", { ...this.#on, id: documentId });
    const entry = document === null || document.deleted ? undefined : await this.#entry(document);
    if (entry !== undefined) {
      this.index.set(entry);
    }
    return entry;
  }

  /**
   * Makes the person with this email a server admin, for the console's
   * "admin grant". A disabled person is enabled again (active if they have
   * logged in before, else invited). Someone unknown is invited as a server
   * admin.
   */
  async grantAdmin(email: string, now: Date): Promise<{ entry: PersonEntry; invited: boolean; enabled: boolean; changed: boolean }> {
    const matches = this.index.byEmail(email);
    if (matches.length > 1) {
      throw new DirectoryError(
        `More than one person has the email ${normalizeEmail(email)} (${matches.map((m) => m.person.personId).join(", ")}). Disable all but one first.`,
      );
    }
    const [match] = matches;
    if (match === undefined) {
      const entry = await this.invite({ email, serverAdmin: true, by: "console", now });
      return { entry, invited: true, enabled: false, changed: true };
    }
    const at = now.toISOString();
    let enabled = false;
    const entry = await this.update(match.person.personId, now, (person) => {
      enabled = person.status === "disabled";
      if (person.serverAdmin && !enabled) {
        return person;
      }
      return {
        ...person,
        ...(person.serverAdmin ? {} : { serverAdmin: true, serverAdminAt: at }),
        ...(enabled ? { status: person.logins.length > 0 ? "active" : "invited", statusAt: at, statusBy: "console" } : {}),
      };
    });
    return { entry, invited: false, enabled, changed: entry !== match };
  }
}
