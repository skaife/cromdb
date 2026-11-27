# @cromdb/server

> **Status: 0.x, private.** This package isn't published. It is the start of
> CromDB Server. It can be set up and started, people can log in through an
> OpenID Connect provider, server admins can invite and manage people and
> make databases, and people can use the databases they have access to,
> all through the API or the admin UI it serves at `/`. There is no syncing
> between servers yet, so the admin UI's Servers page lists this server
> only. Not for production use. Its shapes may change before 1.0.

CromDB Server will serve CromDB databases to people over HTTP, with logins
through an OpenID Connect provider such as Keycloak. It reaches every
database, including its own, through a CromDB [driver](../driver/README.md)
([level 4](../driver-level-4/README.md)), never through the engine or SQLite
directly.

## What works

- `cromdb-server setup` makes a new data directory: it asks each question,
  or takes each answer from a flag so it can run without a terminal. It
  checks the login provider's discovery document and keys, and the
  certificate and key files if the server serves HTTPS itself. If anything
  fails, it removes what it made.
- `cromdb-server start` serves over HTTP or HTTPS. Renewed certificate files
  (from certbot, say) are loaded without a restart, once both files make a
  usable pair again. It keeps an idle connection open 65 seconds, longer
  than a proxy's usual 60 (see Docker below).
- `cromdb-server run` is what the Docker image runs: on an empty data
  directory it sets up from `CROMDB_*` variables first, never asking, then
  starts. `cromdb-server health` asks the server on this machine whether it
  is up, for the image's health check.
- A Docker image of one server (see Docker below).
- Login through the OpenID Connect provider (see Login below), sessions, and
  logout.
- The API under `/api/v0` for the person logged in, people, invitations,
  databases, their access lists, documents and conflicts (see The API
  below), described by `GET /api/v0/openapi.json`.
- The admin UI (the `@cromdb/admin-ui` package), served at `/`:
  a sign-in screen, the menu, the Databases list with New database and each
  database's replica and conflict counts, and a database's tabs. Documents:
  the documents in pages with a filter and extra columns, and an inspector
  beside them to read, edit, make and delete documents, and to resolve a
  document's conflict (keep one version, save new content, or delete it).
  Access (for the database's admins): who may do what, as a grid of the
  five lists. Replicas: the copies this server's copy knows of. Settings:
  the name and how long deletions are kept. For server admins, People:
  everyone on the server, filtered by name, email and status, with a
  person's details beside the list, where they can be made or stopped
  being a server admin and disabled or enabled; and Invitations: invite
  someone by email, and the invitations not yet used, with Revoke; Settings:
  every setting but the client secret, which can only be replaced, with
  each one that waits for a restart marked, and Restart now when something
  starts the server again (see Settings while it runs); Status: the
  versions, whether a newer version is published (when the update check is
  on), the databases the server couldn't open, and what the last
  maintenance did to each database; and Servers, which lists this server
  only until servers sync with each other. Leaving a screen with unsaved
  changes asks first. See The admin UI below.
- `cromdb-server config list | get KEY | set KEY VALUE` reads and changes the
  settings. Secrets are never shown or taken on the command line.
- `cromdb-server admin grant EMAIL` makes someone a server admin, inviting
  them if they are unknown. It is the way back in when no server admin can
  log in.
- `cromdb-server version` shows the versions of the server, driver and engine.
- One program at a time per data directory: the server and every command
  lock its database files while they run (see The data directory).
- A daily purge of every database the server holds, and compaction of a
  file with enough free space (see Maintenance).
- An update check, off unless turned on, that says on the Status page when
  a newer version is published (see Updates).

## Not yet

Syncing between servers (and with it the rest of the Servers page and the
Status page's peers), joining an existing
deployment, an image for arm64 (the Docker image is linux/amd64 only), and
rate limiting (put a reverse proxy in front
if you need it).

## The data directory

`--data DIR` (or `CROMDB_DATA`) names it on every command. It holds:

- `server.cromdb`: the server database, a CromDB database with the server's
  identity, settings, secrets and the list of databases it serves. Only the
  server itself ("cromdb-server") can read it, and it is never synced.
- `directory.cromdb`: the people who may use the server, also a CromDB
  database only the server can read.
- `databases/`: one file per database the server serves. The server
  database lists which file holds which database; a file it doesn't list is
  never served (the server logs it at start).

A data directory made by an earlier server, whose databases are at level 3
(cromdb 0.6.0's level), is raised to level 4 the first time this server
opens it: `server.cromdb` by the first command, the directory and each
database at the first start. Each raise is logged ("Raised the directory
(...) from level 3 to level 4"). It is one way: an earlier server can't open
the files afterwards. A database that can't be raised (one at level 2, say)
is logged and not served; the others are.

`serverDbPurgeAfterDays` (7 by default, 1 to 3650) is how many days
`server.cromdb` keeps a tombstone, such as an ended session's, before it may
be purged. The server applies it to `server.cromdb` at setup, at each
start, and when it is saved in the admin UI. Other databases keep their own setting (90 days unless changed).

On Linux and macOS the directory is made readable by its owner only. Secrets
(the provider's client secret) are stored in `server.cromdb` in plain text,
protected by those permissions.

**Stop the server before running `config` or `admin`.** The server reads its
settings and people when it starts, so changes made with them take effect at
the next start. Settings saved in the admin UI are different: see Settings
while it runs.
The server and every command lock the data directory's database files while
they use them, so a command run while the server is running, or a second
server on the same data directory, stops with "The server is running, or
another command is using this data directory. Stop it first." The lock is
SQLite's own: it goes when the program exits, however it exits. Keep the data
directory on a local disk; SQLite's locks aren't reliable on network file
systems.

## Maintenance

Once a day the server purges each database it holds: `server.cromdb`, the
directory, then every database it serves. Purge removes tombstones (what a
deleted document leaves) older than the database's own setting, and change
entries that later ones replaced. After each purge the server measures the
database's file: when at least a quarter of it, and at least 64 MB, is free
space, it compacts the file, giving that space back to the disk. Compacting
blocks the whole server until it ends, which can take a while on a large
database; that is why it runs only then.

- **When.** At `maintenanceHour` (0 to 23, 3 by default) in
  `maintenanceTimeZone`: an IANA time zone such as `Europe/Paris` or `UTC`,
  or `local` (the default) for the server process's own zone (from `TZ` or
  the system). If the process's zone isn't known, the server uses UTC and
  says so at start, where it also logs when maintenance is due. The server
  checks a minute after it starts and then every hour, so a server that was
  down at that hour runs at its next check, once, however many days it
  missed. A day whose hour is skipped when clocks change still gets its run,
  right after the change; an hour that happens twice runs only the first
  time.
- **Log.** One line per database ("Purged database "Notes" (...): 12
  tombstones, 40 entries, horizon 1234, 35 ms"), and a line for each
  compaction (with the file's size before and after) and each failure. A failure on one database doesn't stop the
  others. Databases the server couldn't open are skipped, and the log says
  so.
- **Record.** The last run's results are kept in `server.cromdb`, and the
  admin UI's Status page shows them.
- **Who.** Maintenance runs as "cromdb-server", which is an admin of every
  database the server holds. It is the server's own housekeeping, done for
  no person: it reads nothing for anyone, and writes no document in a
  person's database.
- **Shutdown** during a run waits for the database it is on, and the run
  doesn't count: the next start runs it again.

## Updates

The update check is off unless a server admin turns it on: `updateCheck`,
under Updates in the admin UI's Settings, or `config set updateCheck yes`.
It takes effect at once. When it is on, the server asks GitHub a minute
later, and then once a day, for this repository's `server-vX.Y.Z` tags: one
unauthenticated `GET` of
`https://api.github.com/repos/skaife/cromdb/git/matching-refs/tags/server-v`,
saying only that it is `cromdb-server`. It sends nothing about this server
beyond that request. If a tag is newer than the running version, the Status
page says so, with a link to what changed (this package's
[CHANGELOG.md](CHANGELOG.md) at that tag) and the steps to upgrade. A check
that can't reach GitHub is logged once and tried again the next day; it
never blocks anything. The result is kept in memory only, so a restart
checks again. The server never downloads or installs an update.

### Upgrading

With Docker, see Upgrading in the [Docker guide](../../docker/README.md).
Run from this repository, stop the server, copy the data directory
somewhere safe (a newer server may convert the data at its first start, and
an older one can't open it afterwards), check out the new `server-vX.Y.Z`
tag, run `npm ci` and `npm run build`, and start it again.

### Releasing

The steps for a new version, X.Y.Z. The image goes out before the tag, so
that no server's update check announces a version that can't be pulled
yet.

0. On cromdb-vm, from `main` at the release commit (the one that raises
   `@cromdb/server` to X.Y.Z), once CI is green on it.
1. Build the image and run the smoke test:

   ```sh
   docker build -t ghcr.io/skaife/cromdb-server:X.Y.Z -t ghcr.io/skaife/cromdb-server:latest .
   node packages/server/scripts/docker-smoke.ts ghcr.io/skaife/cromdb-server:X.Y.Z
   ```

2. Log in to the registry (the password is a classic GitHub token with
   `write:packages`), push both tags (`compose.yaml` falls back to
   `latest`), and log out:

   ```sh
   docker login ghcr.io -u skaife
   docker push ghcr.io/skaife/cromdb-server:X.Y.Z
   docker push ghcr.io/skaife/cromdb-server:latest
   docker logout ghcr.io
   ```

3. Then an annotated tag on the release commit, pushed:

   ```sh
   git tag -a server-vX.Y.Z <commit> -m "@cromdb/server X.Y.Z"
   git push origin server-vX.Y.Z
   ```

A brand-new package on ghcr.io starts private: make it public once, in the
package's settings on GitHub.

## Login

The server logs people in with the provider set up by `setup`, using the
authorization code flow with PKCE (S256), state and nonce. Register at the
provider the redirect URI `<public URL>/auth/callback` and the post-logout
redirect URI `<public URL>/`, and give the client the `email` scope.

The server checks the ID token's signature against the provider's keys
(RS256 or ES256 only), its issuer, audience, authorized party, expiry and
issue time (60 seconds of clock difference allowed) and nonce, and wants an
email the provider has verified. It keeps no access or refresh token.

Who gets in:

- A login the server has seen before is that person, unless they are
  disabled.
- Otherwise, the one person invited with the login's email becomes active,
  with this login. Logins are never linked by email after that, so a second
  account with the same email is refused.
- Anyone else is refused, and nothing is written. So is everyone with an
  email that has more than one invitation, until a server admin revokes all
  but one.

## Settings while it runs

Server admins change the settings in the admin UI (or with
`PUT /api/v0/server/settings`), checked exactly as `config set` checks them:
the certificate and key files when they change, and a changed issuer
against its discovery document. An `http://` public address or issuer that
leaves this machine is saved only after a question (`allowPlainHttp`).

- **At once:** `serverName`, `sessionIdleMinutes` and `sessionMaxDays`
  (sessions already open are judged by the new lengths from their next
  request), the three maintenance settings, and `updateCheck`.
- **At the next start:** `publicUrl`, `listen`, `tls`, `trustProxy`,
  `oidcIssuer`, `oidcClientId` and the client secret. The settings page
  marks each of these "restart", and says when one is saved but not yet in
  effect. A replaced client secret counts as waiting too, until the next
  start. When the server was started with `--listen` (as the Docker image
  is), the page shows that address read only: the `listen` setting isn't
  used then.

The client secret is write-only: it can be replaced, and is never shown or
returned. **Restart** (`POST /api/v0/server/restart`) stops the server
cleanly, as on SIGTERM, and exits 0, so that what supervises it starts it
again. The server offers it only when the environment variable
`CROMDB_RESTART_ON_EXIT` is `1`, which says something will (a container
that restarts, or a systemd unit with `Restart=always`). Without it the
route answers `409` (`NOT_SUPERVISED`) and the page asks you to restart the
server yourself.

## Sessions

A session lasts until it has gone unused for `sessionIdleMinutes` (12 hours
by default) or is `sessionMaxDays` old (7 days), whichever comes first.
Logging out, or being disabled, ends it. The cookie is HttpOnly and
SameSite=Lax; with an https public URL it is `__Host-cromdb-session` and
Secure. Sessions are kept in `server.cromdb` under a hash of their ID, so
they survive a restart.

The time a session was last used is written at most every 15 minutes, and
at shutdown. After a crash a session can end up to 15 minutes early, never
late.

## The API

Everything under `/api/v0` is JSON, and needs a session except `health`,
`openapi.json` and `server/about`. `GET /api/v0/openapi.json` describes every route, its
request and each response (OpenAPI 3.1).

- `GET /server/about`: the server's name, for anyone, logged in or not.
- `GET /me`: the person logged in, and the server's name.
- `GET /people/{personId}`: a person's ID and display name, for anyone.
  `GET /people/cards?ids=a,b,c` gives up to 100 of them at once. There is
  no list of people for anyone but server admins.
- Server admins only: `GET /people` (search by email or name),
  `GET /people/{personId}/details`, `POST /people/{personId}/disable` and
  `/enable`, `PUT /people/{personId}/server-admin`, and `GET`, `POST` and
  `DELETE` on `/invitations`. The last active server admin can't be disabled
  or lose the role through the API; `cromdb-server admin grant` is the way
  back.
- Server admins only: `GET` and `PUT /server/settings` (every setting
  but the client secret, as saved and as in effect now; see Settings while
  it runs), `PUT /server/client-secret` (write-only), `POST
  /server/restart`, and `GET /server/status` (the versions, the update
  check's result, the databases the server couldn't open, and the last
  maintenance run).

Databases (`{db}` is the database's ID):

- `GET /databases`: the databases you can see, with what you may do in each
  (`visible`, `read`, `write`, `create`, `admin`). Server admins also see
  the ones the server couldn't open, such as a database at another level
  than 3.
- `POST /databases` (server admins): makes a database. You are its first
  admin, creator, writer and reader, and nobody else has access until you
  change its ACL. `cromdb-server` is an admin too, for syncing between
  servers later.
- `GET /databases/{db}`: one database, with what you may do in it.
- `GET` and `PUT /databases/{db}/acl` (the database's admins): its five
  lists, `admins`, `creators`, `writers`, `readers` and `noAccess`, replaced
  all together. The server refuses an ACL without `cromdb-server` in
  `admins`, or with it in `noAccess`. It also refuses `anonymous` in any
  list: the server has no anonymous sessions, so `anonymous` would admit
  nobody here but everyone on a copy opened outside a server. Use `*` for
  everyone who logs in.
- `GET /databases/{db}/summary`: how many replicas the database has, and
  how many documents in conflict you can read, counted up to 1000
  (`conflictsCapped` says when there are more). It reads every such
  document, so it is slow for a large database.
- `GET /databases/{db}/settings`: the database's name, `purgeAfterDays`
  and level. `PUT` (the database's admins) changes the name and
  `purgeAfterDays`. The name is this server's only. `purgeAfterDays` is
  shared by every replica: when two admins change it before their replicas
  sync, the larger value wins.
- `GET /databases/{db}/replicas`: every replica this server's copy knows
  of, which one is this copy, how far this copy is known to hold each
  other one's changes (`knownThrough`), and whether this copy is stale.

Documents, in a database you can see:

- `POST /databases/{db}/documents`: makes one. `readers` and `writers`
  default to `["*"]`, everyone the database admits; the database's lists
  always come first, so a document can only narrow them.
- `GET`, `PUT` and `DELETE /databases/{db}/documents/{id}`.
  Every document the API returns has `updatedOn`, the instance ID of the
  replica it was last changed on, and `inConflict`, whether it has
  conflict versions to resolve.
- `POST /databases/{db}/find`: documents you can read that match a filter,
  in pages (`limit` 50 by default, at most 1000; pass `next` back as
  `after`). It is a POST because the filter is JSON, and it changes
  nothing.
- `GET /databases/{db}/documents/{id}/conflict`: every version of a
  document in conflict that you can read, and `POST .../conflict/resolve`
  with `{ "chooseId" }`, `{ "content", ... }` or `{ "delete": true }`.

CromDB decides every access to a database, its ACL and its documents, for
the person logged in; the server never acts as `cromdb-server` for anyone.
A database you can't see (not in any of its lists, or in `noAccess`) is
`404` on every route, exactly as one that doesn't exist.

Changes need `If-Match` with the version from `ETag`; a version that is no
longer current is `412` (`STALE_VERSION`). Every request that
changes something must come from the server's own pages: its `Origin` must
be the public URL's (or, without `Origin`, `Sec-Fetch-Site: same-origin`).
Request bodies must be `application/json`, at most 1 MB. Errors are
`{ "error": { "code", "message", "details"? } }`.

## The admin UI

The server serves the built admin UI (`packages/admin-ui`) at `/`: its page
for `/` and for any other path outside `/api/`, `/auth/` and `/assets/`
whose last part has no dot, so a link into the UI works on reload; and its
files under `/assets/`. The page is never cached; the files, named by their
content, are cached for good. The page's Content-Security-Policy allows only
the server's own scripts, styles, fonts and API, nothing inline, and forms
to the server and the login provider (where logging out goes). If the UI
isn't built, `/` says so and the API works as before.

To work on the UI, run the server's dev server, which uses a fake login
provider with a page of people to pick from (Ada Admin is the server
admin; Frank and Gina are invited but never log in), and the UI's own dev
server, which reloads on every change and passes `/api` and `/auth` on. A
new dev data directory gets one maintenance run at once, for the Status
page, and four sample databases of Ada's: "Sales tickets", with a document in conflict; "Paging",
with 120 documents; "Conflicts", with documents in conflict to resolve,
one of them with a version only Ned Newcomer can read; and "Team access",
with an ACL that shows the Access tab's warnings.

```sh
npm run build
npm run dev:server -w @cromdb/server   # http://127.0.0.1:8080, data in a temporary folder
npm run dev -w @cromdb/admin-ui        # open http://localhost:5173
```

The dev server is for development and tests only. It is not part of the
server's build.

## Docker

The image `ghcr.io/skaife/cromdb-server` runs one server, with its data in
the `/data` volume and port 8080 inside the container. The guide, with the
Compose file and the variables, is [docker/README.md](../../docker/README.md).
It covers setting up Keycloak beside it, HTTPS, backups and upgrades.

To build it from this repository:

```sh
docker build -t cromdb-server .
node packages/server/scripts/docker-smoke.ts cromdb-server   # Linux: a smoke test
```

## HTTPS

Choose one in setup:

- The server serves HTTPS itself, with a certificate file and key file (PEM).
  The public URL must start with `https://`.
- A reverse proxy in front serves HTTPS, and the server serves plain HTTP to
  it (`--no-tls`, usually with `--trust-proxy yes`).
- Plain HTTP only. If the public URL isn't on the same machine, setup warns
  that everything crosses the network unencrypted and needs
  `--allow-plain-http`, or a typed yes.

## Setup without a terminal

```sh
CROMDB_CLIENT_SECRET=... cromdb-server setup --data /srv/cromdb \
  --deployment new --server-name "Our server" \
  --public-url https://db.example.com:8443 \
  --tls-cert /etc/letsencrypt/live/db.example.com/fullchain.pem \
  --tls-key /etc/letsencrypt/live/db.example.com/privkey.pem \
  --trust-proxy no --listen 0.0.0.0:8443 \
  --issuer https://id.example.com/realms/example --client-id cromdb \
  --admin-email admin@example.com
```

The client secret can also come from `--client-secret-file FILE`. Setup
prints the redirect URIs to register at the provider.
