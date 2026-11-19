// Admission: who a successful login is, in the directory.
//
//   - A login (issuer, subject) that already belongs to a person is that
//     person, refused if disabled. Email isn't looked at.
//   - Otherwise exactly one person with that email and status "invited"
//     becomes "active", with this login and a display name (the token's
//     "name", else the email).
//   - No such person: refused, nothing written. An active person with the
//     same email is not linked: logins are never linked by email after the
//     first admission.
//   - More than one invited person with the email: refused until a server
//     admin revokes all but one.

import type { Directory, PersonEntry } from "../directory/directory.js";
import { normalizeEmail } from "../text.js";
import type { LoginIdentity } from "./id-token.js";

export type Refusal = "disabled" | "not-invited" | "ambiguous";

export type Admission =
  | { readonly ok: true; readonly entry: PersonEntry; readonly admitted: boolean }
  | { readonly ok: false; readonly refusal: Refusal; readonly reason: string };

function hasLogin(entry: PersonEntry, identity: LoginIdentity): boolean {
  return entry.person.logins.some((login) => login.issuer === identity.issuer && login.subject === identity.subject);
}

export async function admit(directory: Directory, identity: LoginIdentity, now: Date): Promise<Admission> {
  const known = directory.index.byLogin(identity.issuer, identity.subject);
  if (known !== undefined && known.person.status === "active") {
    return { ok: true, entry: known, admitted: false };
  }
  if (known !== undefined && known.person.status === "disabled") {
    return { ok: false, refusal: "disabled", reason: `person ${known.person.personId} is disabled` };
  }
  // An invited person who already holds this login is admitted like any
  // invitation.
  const invited =
    known !== undefined ? [known] : directory.index.byEmail(identity.email).filter((entry) => entry.person.status === "invited");
  if (invited.length > 1) {
    return {
      ok: false,
      refusal: "ambiguous",
      reason: `more than one invitation has this email (${invited.map((entry) => entry.person.personId).join(", ")})`,
    };
  }
  const [invitation] = invited;
  if (invitation === undefined) {
    return { ok: false, refusal: "not-invited", reason: "no invitation has this email, and no person has this login" };
  }
  const at = now.toISOString();
  const entry = await directory.update(invitation.person.personId, now, (person) => {
    if (person.status !== "invited") {
      return person;
    }
    const already = person.logins.some((login) => login.issuer === identity.issuer && login.subject === identity.subject);
    return {
      ...person,
      status: "active",
      statusAt: at,
      statusBy: person.personId,
      logins: already ? person.logins : [...person.logins, { issuer: identity.issuer, subject: identity.subject, addedAt: at }],
      displayName: identity.name ?? normalizeEmail(identity.email),
      displayNameAt: at,
    };
  });
  // Another login may have admitted this person meanwhile, or an admin may
  // have revoked the invitation: only this login, active, gets in.
  if (entry.person.status === "active" && hasLogin(entry, identity)) {
    return { ok: true, entry, admitted: true };
  }
  if (entry.person.status === "disabled") {
    return { ok: false, refusal: "disabled", reason: `person ${entry.person.personId} was disabled during the login` };
  }
  return { ok: false, refusal: "not-invited", reason: `person ${entry.person.personId} was admitted with another login during this one` };
}
