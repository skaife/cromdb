import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { fakeFetch, type Answer, type Sent } from "./fake-server.ts";
import { Routed } from "./routed.tsx";

const ADA_ME = { personId: "p-ada", displayName: "Ada Admin", email: "ada@example.com", serverAdmin: true, serverName: "office-1" };
const ISSUER = "https://id.example.com/realms/staff/";

function person(id: string, fields: Partial<Record<string, unknown>> = {}) {
  return {
    personId: id,
    email: `${id.slice(2)}@example.com`,
    displayName: null,
    status: "active",
    statusAt: "2026-11-12T10:00:00Z",
    statusBy: id,
    serverAdmin: false,
    invitedBy: "p-ada",
    invitedAt: "2026-11-11T10:00:00Z",
    logins: [{ issuer: ISSUER, subject: `sub-${id}`, addedAt: "2026-11-12T10:00:00Z" }],
    ...fields,
  };
}

const ADA = person("p-ada", { displayName: "Ada Admin", serverAdmin: true, invitedBy: "setup" });
const BOB = person("p-bob", { displayName: "Bob Baker" });
const DANA = person("p-dana", { displayName: "Dana Dean", status: "disabled", statusAt: "2026-11-18T10:00:00Z", statusBy: "p-ada" });
const FRANK = person("p-frank", { status: "invited", statusAt: "2026-11-19T10:00:00Z", statusBy: "p-ada", logins: [] });
const CARDS = { people: [{ personId: "p-ada", displayName: "Ada Admin" }] };

function start(path: string, routes: Record<string, Answer | ((sent: Sent) => Answer)>) {
  const server = fakeFetch({
    "GET /api/v0/me": { body: ADA_ME },
    "GET /api/v0/people/cards": { body: CARDS },
    "GET /api/v0/people": { body: { people: [ADA, BOB, DANA, FRANK], next: null } },
    "GET /api/v0/invitations": { body: { people: [FRANK], next: null } },
    "GET /api/v0/people/p-bob/details": { body: BOB, headers: { etag: '"bob-v1"' } },
    "GET /api/v0/people/p-frank/details": { body: FRANK, headers: { etag: '"frank-v1"' } },
    ...routes,
  });
  vi.stubGlobal("fetch", server.fetch);
  render(
    <Routed path={path}>
      <App />
    </Routed>,
  );
  return server;
}

const query = (sent: readonly Sent[], path: string) => sent.filter((s) => s.method === "GET" && s.url.split("?")[0] === path).map((s) => new URL(s.url, "http://x").searchParams);

describe("People", () => {
  it("lists everyone with their status and role, and searches as the filter is typed", async () => {
    const server = start("/server/people", {});
    const table = await screen.findByRole("table", { name: "People, in email order" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "Ada Adminada@example.comActiveYes",
      "Bob Bakerbob@example.comActiveNo",
      "Dana Deandana@example.comDisabledNo",
      "No name yetfrank@example.comInvitedNo",
    ]);
    expect(screen.getByRole("link", { name: "No name yet: frank@example.com" })).toBeTruthy();
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Filter by name or email" }), "ba");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "Active");
    await waitFor(() => expect(query(server.sent, "/api/v0/people").at(-1)?.get("q")).toBe("ba"));
    await waitFor(() => expect(query(server.sent, "/api/v0/people").at(-1)?.get("status")).toBe("active"));
    // Typing waits for a pause: not one request per letter.
    expect(query(server.sent, "/api/v0/people").filter((q) => q.get("q") === "b")).toHaveLength(0);
  });

  it("opens a person in the panel with their details", async () => {
    start("/server/people/p-bob", {});
    const panel = await screen.findByRole("complementary", { name: "Person" });
    expect(await within(panel).findByRole("heading", { name: "Bob Baker", level: 2 })).toBeTruthy();
    const facts = panel.querySelector("dl") as HTMLElement;
    expect(facts.textContent).toMatch(/Emailbob@example\.com/);
    expect(facts.textContent).toMatch(/Person IDp-bob/);
    expect(facts.textContent).toMatch(/StatusActive since Nov 12/);
    expect(facts.textContent).toMatch(/Invited byyou, Nov 11/);
    expect(facts.textContent).toMatch(/Loginsid\.example\.com\/realms\/staff, linked Nov 12/);
    expect(facts.textContent).toMatch(/Server adminNo/);
    expect(within(panel).getByRole("button", { name: "Disable" })).toBeTruthy();
  });

  it("makes someone a server admin after asking, with the version it read", async () => {
    const server = start("/server/people/p-bob", {
      "PUT /api/v0/people/p-bob/server-admin": { body: { ...BOB, serverAdmin: true }, headers: { etag: '"bob-v2"' } },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Make server admin" }));
    const dialog = screen.getByRole("alertdialog", { name: "Make Bob Baker a server admin?" });
    await user.click(within(dialog).getByRole("button", { name: "Make server admin" }));
    expect(await screen.findByText("Made a server admin.")).toBeTruthy();
    const put = server.sent.find((s) => s.method === "PUT");
    expect(put?.headers["if-match"]).toBe('"bob-v1"');
    expect(put?.body).toEqual({ serverAdmin: true });
    expect(screen.getByRole("button", { name: "Remove server admin" })).toBeTruthy();
  });

  it("shows the server's reason when the last server admin can't be disabled", async () => {
    start("/server/people/p-bob", {
      "POST /api/v0/people/p-bob/disable": { status: 409, body: { error: { code: "LAST_ADMIN", message: "Disabling them would leave no active server admin" } } },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disable" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Disable Bob Baker?" })).getByRole("button", { name: "Disable" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Disabling them would leave no active server admin");
  });

  it("reads the person again when they changed since the panel opened", async () => {
    let reads = 0;
    start("/server/people/p-bob", {
      "GET /api/v0/people/p-bob/details": () => {
        reads += 1;
        return reads === 1 ? { body: BOB, headers: { etag: '"bob-v1"' } } : { body: { ...BOB, status: "disabled", statusBy: "p-ada" }, headers: { etag: '"bob-v2"' } };
      },
      "POST /api/v0/people/p-bob/disable": { status: 412, body: { error: { code: "STALE_VERSION", message: "Changed" } } },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disable" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Disable" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed since the panel opened, so nothing was changed/);
    expect(await screen.findByRole("button", { name: "Enable" })).toBeTruthy();
  });

  it("enables someone without asking", async () => {
    const server = start("/server/people/p-dana", {
      "GET /api/v0/people/p-dana/details": { body: DANA, headers: { etag: '"dana-v1"' } },
      "POST /api/v0/people/p-dana/enable": { body: { ...DANA, status: "active" }, headers: { etag: '"dana-v2"' } },
    });
    const user = userEvent.setup();
    expect((await screen.findByText(/^Disabled Nov 18/)).textContent).toBe("Disabled Nov 18 by you");
    await user.click(screen.getByRole("button", { name: "Enable" }));
    expect(await screen.findByText("Enabled.")).toBeTruthy();
    expect(server.sent.find((s) => s.method === "POST")?.headers["if-match"]).toBe('"dana-v1"');
  });
});

describe("Invitations", () => {
  it("lists the invitations not yet used", async () => {
    start("/server/invitations", {});
    const table = await screen.findByRole("table", { name: "Invitations not yet used, in email order" });
    const row = within(table).getAllByRole("row")[1] as HTMLElement;
    await waitFor(() => expect(row.textContent).toBe("frank@example.comNoNov 11 by youRevoke"));
  });

  it("invites by email, and says so", async () => {
    const server = start("/server/invitations", {
      "POST /api/v0/invitations": { status: 201, body: { ...FRANK, email: "gina@example.com", serverAdmin: true }, headers: { etag: '"gina-v1"' } },
    });
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Email to invite" }), " gina@example.com ");
    await user.click(screen.getByRole("checkbox", { name: "Server admin" }));
    await user.click(screen.getByRole("button", { name: "Invite" }));
    expect(await screen.findByText("Invited gina@example.com as a server admin.")).toBeTruthy();
    expect(server.sent.find((s) => s.method === "POST")?.body).toEqual({ email: "gina@example.com", serverAdmin: true });
    expect(screen.getByRole("textbox", { name: "Email to invite" })).toHaveProperty("value", "");
  });

  it("checks the email before sending it", async () => {
    const server = start("/server/invitations", {});
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Email to invite" }), "gina");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    expect(screen.getByText("Give one email address, like name@example.com.")).toBeTruthy();
    expect(server.sent.filter((s) => s.method === "POST")).toHaveLength(0);
  });

  it("links to the person when someone with the email is already there", async () => {
    start("/server/invitations", {
      "POST /api/v0/invitations": { status: 409, body: { error: { code: "PERSON_EXISTS", message: "Someone with this email is already active", details: { personId: "p-bob" } } } },
    });
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Email to invite" }), "bob@example.com");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Someone with this email is already active Open them in People");
    expect(within(alert).getByRole("link", { name: "Open them in People" }).getAttribute("href")).toBe("/server/people/p-bob");
  });

  it("revokes after asking, reading the person first for their version", async () => {
    const server = start("/server/invitations", {
      "DELETE /api/v0/invitations/p-frank": { body: { ...FRANK, status: "disabled" }, headers: { etag: '"frank-v2"' } },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Revoke the invitation for frank@example.com" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Revoke the invitation for frank@example.com?" })).getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("Revoked the invitation for frank@example.com.")).toBeTruthy();
    expect(server.sent.find((s) => s.method === "DELETE")?.headers["if-match"]).toBe('"frank-v1"');
  });
});
