# @cromdb/server

> **Status: 0.x, private.** This package isn't published. It is the start of
> CromDB Server. It can be set up and started, people can log in through an
> OpenID Connect provider, server admins can invite and manage people and
> make databases, and people can use the databases they have access to,
> all through the API. There are no pages beyond a bare home page, and no
> syncing between servers. Not for production use. Its shapes may change
> before 1.0.

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
  usable pair again.
- Login through the OpenID Connect provider (see Login below), sessions, and
  logout.
- The API under `/api/v0` for the person logged in, people, invitations,
  databases, their access lists, documents and conflicts (see The API
  below), described by `GET /api/v0/openapi.json`.
- `cromdb-server config list | get KEY | set KEY VALUE` reads and changes the
  settings. Secrets are never shown or taken on the command line.
- `cromdb-server admin grant EMAIL` makes someone a server admin, inviting
  them if they are unknown. It is the way back in when no server admin can
  log in.
- `cromdb-server version` shows the versions of the server, driver and engine.
- One program at a time per data directory: the server and every command
  lock its database files while they run (see The data directory).
- A daily purge of every database the server holds, and compaction after a
  large one (see Maintenance).

## Not yet

The pages people use, syncing between servers, joining an existing
deployment, a Docker image, and rate limiting (put a reverse proxy in front
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
be purged. The server applies it to `server.cromdb` at setup and at each
start. Other databases keep their own setting (90 days unless changed).

On Linux and macOS the directory is made readable by its owner only. Secrets
(the provider's client secret) are stored in `server.cromdb` in plain text,
protected by those permissions.

**Stop the server before running `config` or `admin`.** The server reads its
settings and people when it starts, so changes take effect at the next start.
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
entries that later ones replaced. After a purge that brings the change
entries removed since a database was last compacted to 10,000, the server
compacts that database's file, giving the space back to the disk. Compacting
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
  compaction and each failure. A failure on one database doesn't stop the
  others. Databases the server couldn't open are skipped, and the log says
  so.
- **Record.** The last run's results are kept in `server.cromdb`, for the
  status page the web UI will have.
- **Who.** Maintenance runs as "cromdb-server", which is an admin of every
  database the server holds. It is the server's own housekeeping, done for
  no person: it reads nothing for anyone, and writes no document in a
  person's database.
- **Shutdown** during a run waits for the database it is on, and the run
  doesn't count: the next start runs it again.

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

Everything under `/api/v0` is JSON, and needs a session except `health` and
`openapi.json`. `GET /api/v0/openapi.json` describes every route, its
request and each response (OpenAPI 3.1).

- `GET /me`: the person logged in.
- `GET /people/{personId}`: a person's ID and display name, for anyone.
  There is no list of people for anyone but server admins.
- Server admins only: `GET /people` (search by email or name),
  `GET /people/{personId}/details`, `POST /people/{personId}/disable` and
  `/enable`, `PUT /people/{personId}/server-admin`, and `GET`, `POST` and
  `DELETE` on `/invitations`. The last active server admin can't be disabled
  or lose the role through the API; `cromdb-server admin grant` is the way
  back.

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

Documents, in a database you can see:

- `POST /databases/{db}/documents`: makes one. `readers` and `writers`
  default to `["*"]`, everyone the database admits; the database's lists
  always come first, so a document can only narrow them.
- `GET`, `PUT` and `DELETE /databases/{db}/documents/{id}`.
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
