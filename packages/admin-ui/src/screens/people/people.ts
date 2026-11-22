// How people are shown on the People and Invitations pages: their status,
// who did something (a person, or the server's setup or console), and the
// identity providers they log in with.

import type { NameBook, NameLabel } from "../../api/names.ts";
import type { Schemas } from "../../api/schema.ts";
import { formatDay } from "../../app/format.ts";

export type Person = Schemas["Person"];
export type Status = Person["status"];

export const STATUSES: readonly Status[] = ["active", "invited", "disabled"];

export const STATUS_LABEL: Readonly<Record<Status, string>> = { active: "Active", invited: "Invited", disabled: "Disabled" };

/** "Active since Nov 12", "Invited Nov 11", "Disabled Nov 18". */
export function statusLine(person: Pick<Person, "status" | "statusAt">, now: Date = new Date()): string {
  const day = formatDay(person.statusAt, now);
  return person.status === "active" ? `Active since ${day}` : `${STATUS_LABEL[person.status]} ${day}`;
}

/** A person's name for headings and buttons: their display name, else their email. */
export function personTitle(person: Pick<Person, "displayName" | "email">): string {
  return person.displayName !== null && person.displayName !== "" ? person.displayName : person.email;
}

/** Who did something: a person, or what the server records for its own setup and console. */
export function actorLabel(book: NameBook, id: string, me: string | undefined): NameLabel {
  if (id === "setup") return { text: "the server's setup" };
  if (id === "console") return { text: "the server console" };
  return book.label(id, me);
}

/** An identity provider as people know it: its address without the scheme ("id.example.com/realms/staff"). */
export function issuerLabel(issuer: string): string {
  try {
    const url = new URL(issuer);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.host}${path}`;
  } catch {
    return issuer;
  }
}

/** Why an email can't be invited as typed, or undefined. The server checks it too. */
export function inviteEmailProblem(text: string): string | undefined {
  const email = text.trim();
  if (email === "") return "Give the email of the person to invite.";
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return "Give one email address, like name@example.com.";
  return undefined;
}
