# @cromdb/server

> **Status: 0.x, private.** This package isn't published. It is the start of
> CromDB Server. It can be set up and started, but it serves only a health
> check: there is no login and no API for people or databases yet. Not for
> production use. Its shapes may change before 1.0.

CromDB Server will serve CromDB databases to people over HTTP, with logins
through an OpenID Connect provider such as Keycloak. It reaches every
database, including its own, through a CromDB [driver](../driver/README.md)
([level 2](../driver-level-2/README.md)), never through the engine or SQLite
directly.

## What works

- `cromdb-server setup` makes a new data directory: it asks each question,
  or takes each answer from a flag so it can run without a terminal. It
  checks the login provider's discovery document and keys, and the
  certificate and key files if the server serves HTTPS itself. If anything
  fails, it removes what it made.
- `cromdb-server start` serves `GET /api/v0/health` over HTTP or HTTPS.
  Renewed certificate files (from certbot, say) are loaded without a restart,
  once both files make a usable pair again.
- `cromdb-server config list | get KEY | set KEY VALUE` reads and changes the
  settings. Secrets are never shown or taken on the command line.
- `cromdb-server admin grant EMAIL` makes someone a server admin, inviting
  them if they are unknown. It is the way back in when no server admin can
  log in.
- `cromdb-server version` shows the versions of the server, driver and engine.

## Not yet

Logging in, sessions, the API for people, invitations, databases and
documents, the pages people use, syncing between servers, joining an
existing deployment, and a Docker image.

## The data directory

`--data DIR` (or `CROMDB_DATA`) names it on every command. It holds:

- `server.cromdb`: the server database, a CromDB database with the server's
  identity, settings, secrets and the list of databases it serves. Only the
  server itself ("cromdb-server") can read it, and it is never synced.
- `directory.cromdb`: the people who may use the server, also a CromDB
  database only the server can read.
- `databases/`: one file per database the server serves.

On Linux and macOS the directory is made readable by its owner only. Secrets
(the provider's client secret) are stored in `server.cromdb` in plain text,
protected by those permissions.

**Stop the server before running `config` or `admin`.** The server reads its
settings and people when it starts, so changes take effect at the next start.
Nothing yet stops two programs, or two servers, from using one data directory
at the same time; a lock in the storage layer is planned.

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
