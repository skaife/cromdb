# CromDB Server in Docker

> **Status: 0.x, early.** The image runs one CromDB Server: no syncing
> between servers yet. Not for production use. Settings and the shape of
> the data may change before 1.0. The image is built for linux/amd64 only
> for now.

The image `ghcr.io/skaife/cromdb-server` holds the server and its admin UI.
It serves on port 8080 inside the container and keeps everything in the
`/data` volume. On its first start, with an empty volume, it sets itself up
from `CROMDB_*` variables. After that it only starts.

The login provider is not in the image. Run one on its own: Keycloak is
shown below, and any OpenID Connect provider that verifies email addresses
will do.

Contents: [What you need](#what-you-need) ·
[The address of the login provider](#the-address-of-the-login-provider) ·
[Keycloak](#keycloak) · [First start](#first-start) ·
[After the first start](#after-the-first-start) · [HTTPS](#https) ·
[Commands](#commands) · [Restart](#restart) · [Backups](#backups) ·
[Upgrading](#upgrading) · [Behind a proxy](#behind-a-proxy) ·
[Without Compose](#without-compose) · [Variables](#variables)

## What you need

- Docker with Compose: Docker Desktop on Windows or macOS, or Docker Engine
  and its Compose plugin on Linux.
- An OpenID Connect provider, such as Keycloak.
- The two files beside this guide: `compose.yaml` and `.env.example`.

## The address of the login provider

**The server and the people's browsers must reach the login provider at the
same URL, the issuer URL.** The server checks the provider at that URL from
inside its container, the browser is sent there to log in, and the tokens
name it. If the two see different addresses, setup or login fails.

So the issuer can't be `http://localhost:...`: inside the container,
localhost is the container itself. Use a name or address that works from
both sides:

- a DNS name, such as `https://id.example.com`;
- the host's address on your network, such as `http://192.168.1.20:8180`;
- on Docker Desktop (Windows and macOS), `http://host.docker.internal:8180`.
  Docker Desktop makes that name reach the host from containers, and adds
  it to the host's own hosts file (Settings, General, "Add the
  \*.docker.internal names to the host's /etc/hosts file", on by default),
  so the browser reaches it too. If the browser can't open it, see below.

Then tell the provider that same URL, so the issuer it puts in its
discovery document and tokens matches. For Keycloak that is its hostname
option (`--hostname`, or `KC_HOSTNAME`), shown below.

An issuer or public URL that is plain `http://` and not on the same machine
needs `CROMDB_ALLOW_PLAIN_HTTP=yes`. Everything then crosses the network
unencrypted, so use it only on a network you trust, or for a try.

### When the browser can't open host.docker.internal

Containers always reach `host.docker.internal` through Docker itself. The
browser needs a line for it in the host's hosts file. If Docker Desktop's
setting is off, or can't be turned on (a per-user install of Docker
Desktop on Windows can't change the hosts file), add the line yourself.
`127.0.0.1` is right for the browser, since the provider's published port
is on the same machine, so both sides still use the same issuer URL.

On Windows, in PowerShell run as administrator. The first command shows
whether the name is there already; add the line only if it shows nothing:

```powershell
Select-String -Path "$env:windir\System32\drivers\etc\hosts" -Pattern "docker.internal"
Add-Content -Path "$env:windir\System32\drivers\etc\hosts" -Value "`r`n127.0.0.1 host.docker.internal"
```

To remove it afterwards (this removes every line naming
host.docker.internal, so only if you added the line yourself):

```powershell
$hosts = "$env:windir\System32\drivers\etc\hosts"
(Get-Content $hosts) | Where-Object { $_ -notmatch "host\.docker\.internal" } | Set-Content $hosts
```

On macOS, in Terminal (asks for your password):

```sh
grep docker.internal /etc/hosts
sudo sh -c 'printf "\n127.0.0.1 host.docker.internal\n" >> /etc/hosts'
```

and to remove it: `sudo sed -i '' '/host\.docker\.internal/d' /etc/hosts`.

## Keycloak

This runs Keycloak in development mode, enough to try the server. For real
use, follow Keycloak's own guide for running it in production.

```sh
docker run -d --name keycloak -p 8180:8080 --restart unless-stopped \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=change-me \
  quay.io/keycloak/keycloak:26.8.1 start-dev --hostname http://host.docker.internal:8180
```

On Linux, or anywhere without Docker Desktop, put the host's address or
DNS name in `--hostname` instead (`http://192.168.1.20:8180`, say). In
PowerShell, put each command on one line, or end lines with a backtick
instead of a backslash.

Open `http://host.docker.internal:8180/admin` (or the address you chose)
and log in with the bootstrap admin. If the browser can't open that
address, see "When the browser can't open host.docker.internal" above.
Then:

1. **A realm.** Top left, the realm list, Create realm. Name it `cromdb`.
   The issuer URL is then `http://host.docker.internal:8180/realms/cromdb`.
2. **A client.** In the cromdb realm: Clients, Create client.
   - Client type OpenID Connect, Client ID `cromdb`. Next.
   - Client authentication **On**. Authentication flow: Standard flow only.
     Next.
   - Valid redirect URIs: the server's public URL followed by
     `/auth/callback`, such as `http://localhost:8080/auth/callback`.
     Valid post logout redirect URIs: the public URL followed by `/`, such
     as `http://localhost:8080/`. Save.
   - The Credentials tab shows the Client secret. It goes in
     `CROMDB_CLIENT_SECRET` (or a file, see below).

   The client has the `email` and `profile` scopes by default; the server
   needs both.
3. **The first server admin.** Users, Create new user.
   - Username of your choice, Email: the address you will put in
     `CROMDB_ADMIN_EMAIL`, First name and Last name.
   - **Email verified: On.** The server only lets in people whose email
     the provider has verified. Without it, the first login is refused
     with this page:

     > Your email address is not verified with the login service, so you
     > can't log in here yet.

     and the server log says
     `Login refused (unverified): the ID token's email is not verified (email_verified)`.
     Turn Email verified on for the user and log in again.
   - Create. Then the Credentials tab, Set password, Temporary **Off**.

Everyone else is invited from the admin UI later, and needs a user in this
realm with a verified email of their own.

## First start

Copy the two files to a folder of their own, and make `.env` from the
example:

```sh
cp .env.example .env
```

Fill in `.env`. For a try on Docker Desktop with the Keycloak above:

```sh
CROMDB_VERSION=0.3.0
CROMDB_SERVER_NAME=Our CromDB Server
CROMDB_PUBLIC_URL=http://localhost:8080
CROMDB_ALLOW_PLAIN_HTTP=yes
CROMDB_ISSUER=http://host.docker.internal:8180/realms/cromdb
CROMDB_CLIENT_ID=cromdb
CROMDB_CLIENT_SECRET=the client secret from Keycloak
CROMDB_ADMIN_EMAIL=you@example.com
```

`CROMDB_ALLOW_PLAIN_HTTP=yes` is needed here for the issuer, which is
plain HTTP and not on the container's own machine. The public URL is
`http://localhost:8080` because the browser runs on the same machine as
Docker.

Start it:

```sh
docker compose up -d
docker compose logs -f
```

On the first start the log says it is setting up from the variables, and
shows the redirect URIs to register at the provider (the ones above). If a
variable is missing or wrong, the log names each one, nothing is written,
and the container stops; fix `.env` and run `docker compose up -d` again.
If the provider can't be reached yet (Keycloak still starting, say), the
log says so and Docker starts the container again after a pause, until it
can.

Then open the public URL, log in as the admin email, and invite people
from the admin UI.

`docker compose ps` shows the container as healthy once the server
answers. The health check is `cromdb-server health` inside the container;
it reads no data.

## After the first start

The settings, the client secret among them, now live in the server's own
database in the volume. The setup variables in `.env` are not read again;
each start logs which ones are set and ignored.

- **Remove `CROMDB_CLIENT_SECRET` from `.env`** after the first start, so
  the secret isn't left in a plain file. To replace the secret later, use
  the admin UI's Settings page.
- Or never put it in `.env`: put the secret in a file and use a Compose
  secret. Uncomment the `secrets` lines in `compose.yaml`, put the secret
  in `client-secret.txt` beside it, and set
  `CROMDB_CLIENT_SECRET_FILE=/run/secrets/client_secret` in `.env`
  instead of `CROMDB_CLIENT_SECRET`. On Linux, the file must be readable
  by the container's user (uid 1000).
- Change settings in the admin UI (Settings), or with `config set` (see
  Commands), not in `.env`.

## HTTPS

Choose one.

**1. HTTPS in the server.** Put the certificate (with its chain) and the
key in a folder, uncomment `./certs:/certs:ro` in `compose.yaml`, and set
in `.env`:

```sh
CROMDB_PUBLIC_URL=https://db.example.com
CROMDB_TLS_CERT=/certs/fullchain.pem
CROMDB_TLS_KEY=/certs/privkey.pem
```

and publish the port as `"443:8080"` in `compose.yaml`. Renewed files are
picked up within a minute, without a restart. Two things to watch with
certbot:

- certbot's `live/` files are links into `archive/`. Mount the whole
  `/etc/letsencrypt` folder (`/etc/letsencrypt:/certs:ro`, then
  `CROMDB_TLS_CERT=/certs/live/db.example.com/fullchain.pem`), not
  `live/` alone, or the links point nowhere inside the container.
- certbot writes the key readable by root only, and the server runs as uid
  1000. Either copy both files somewhere with a deploy hook and give them
  to uid 1000:

  ```sh
  # /etc/letsencrypt/renewal-hooks/deploy/cromdb.sh
  install -o 1000 -g 1000 -m 0644 "$RENEWED_LINEAGE/fullchain.pem" /srv/cromdb/certs/fullchain.pem
  install -o 1000 -g 1000 -m 0600 "$RENEWED_LINEAGE/privkey.pem" /srv/cromdb/certs/privkey.pem
  ```

  and mount `/srv/cromdb/certs:/certs:ro`, or let a reverse proxy handle
  HTTPS (2).

**2. A reverse proxy in front** (Caddy, nginx, Traefik) serves HTTPS, and
the server serves plain HTTP to it inside Docker's network:

```sh
CROMDB_PUBLIC_URL=https://db.example.com
CROMDB_TRUST_PROXY=yes
```

with no TLS variables. Put the proxy in the same Compose project or Docker
network and send it to `http://cromdb:8080`. Remove the `ports` lines, so
port 8080 is reachable only through the proxy. See also
[Behind a proxy](#behind-a-proxy).

**3. Plain HTTP** on a network you trust: an `http://` public URL and
`CROMDB_ALLOW_PLAIN_HTTP=yes`. Cookies are then not marked Secure.

## Commands

The server's commands run in a container of their own on the same volume.
The server must be stopped first: it locks the data while it runs, and a
command refuses to run beside it.

```sh
docker compose stop
docker compose run --rm cromdb config list
docker compose run --rm cromdb config set sessionIdleMinutes 240
docker compose run --rm cromdb admin grant someone@example.com
docker compose start
```

`admin grant` makes someone a server admin, inviting them if they are
unknown. It is the way back in when no server admin can log in.
`cromdb-server help` (`docker compose run --rm cromdb help`) lists every
command.

## Restart

Some settings take effect only after a restart; the admin UI's Settings
page marks them and offers Restart now. In the container, Restart makes the
server stop cleanly and exit, and Docker's restart policy starts it again.
That needs `restart: unless-stopped` (as in `compose.yaml`) or
`restart: always`. With `on-failure` or no policy, the server stays
stopped after Restart, because it exits normally. If you run it without a
restart policy, set `CROMDB_RESTART_ON_EXIT=0` in `.env` to hide the
button.

## Backups

The volume `cromdb-data` holds everything: the server's settings and
secrets, the people, and every database. To copy it to a file in the
current folder, stop the server for a moment:

```sh
docker compose stop
docker run --rm --user root --entrypoint tar -v cromdb-data:/data:ro -v "${PWD}:/backup" ghcr.io/skaife/cromdb-server:0.3.0 czf /backup/cromdb-backup.tar.gz -C /data .
docker compose start
```

(`${PWD}` works in both a Linux or macOS shell and PowerShell.) To put a
backup back, into an empty volume:

```sh
docker compose down
docker volume rm cromdb-data
docker volume create cromdb-data
docker run --rm --user root --entrypoint tar -v cromdb-data:/data -v "${PWD}:/backup" ghcr.io/skaife/cromdb-server:0.3.0 xzf /backup/cromdb-backup.tar.gz -C /data
docker compose up -d
```

`docker compose down` and `docker compose stop` keep the data.
**`docker compose down -v` and `docker volume rm cromdb-data` delete it.**

Keep the volume a Docker named volume, as `compose.yaml` has it. A folder
from the host (`./data:/data`) works on Linux if uid 1000 can write it,
but not on Docker Desktop for Windows: SQLite's file locking, which keeps
two programs from writing the same data, isn't reliable on folders shared
from Windows into Docker's Linux machine, and it is slow there.

## Upgrading

An upgrade replaces the container. The data stays in the volume.

1. **Back up the volume first** (see Backups). A newer server may convert
   the data on its first start, and that is one way: an older image can't
   open the data afterwards. The backup is the only way back.
2. Set the new version in `.env` (`CROMDB_VERSION=...`), then:

   ```sh
   docker compose pull
   docker compose up -d
   ```

While CromDB is 0.x, a new version may change settings or behavior; read
its notes before upgrading.

## Behind a proxy

The server keeps an idle connection open for 65 seconds, longer than the 60
seconds most proxies and load balancers keep theirs. So the proxy always
closes an idle connection first, and never sends a request on a connection
the server is just closing. If your proxy keeps idle connections to the
server longer than 65 seconds, lower its setting below that.

## Without Compose

The same thing with `docker run`:

```sh
docker volume create cromdb-data
docker run -d --name cromdb --restart unless-stopped -p 8080:8080 \
  --env-file .env -v cromdb-data:/data --stop-timeout 60 \
  ghcr.io/skaife/cromdb-server:0.3.0
```

Commands then run as
`docker run --rm --env-file .env -v cromdb-data:/data ghcr.io/skaife/cromdb-server:0.3.0 config list`,
with the server stopped (`docker stop cromdb`).

## Variables

Read only on the first start, with an empty volume, except where noted. An
empty value counts as not set.

| Variable | What | |
| --- | --- | --- |
| `CROMDB_SERVER_NAME` | The server's name, shown to people | needed |
| `CROMDB_PUBLIC_URL` | Where people reach the server | needed |
| `CROMDB_ALLOW_PLAIN_HTTP` | `yes` to allow an `http://` public URL or issuer that isn't on this machine | |
| `CROMDB_TLS_CERT`, `CROMDB_TLS_KEY` | Certificate and key files for HTTPS in the server: both or neither | |
| `CROMDB_TRUST_PROXY` | `yes` behind a reverse proxy; `no` if not set | |
| `CROMDB_ISSUER` | The login provider's issuer URL | needed |
| `CROMDB_CLIENT_ID` | The client at the provider | needed |
| `CROMDB_CLIENT_SECRET` | The client's secret | this or the next |
| `CROMDB_CLIENT_SECRET_FILE` | A file holding the client's secret | |
| `CROMDB_ADMIN_EMAIL` | The first server admin, invited at setup | needed |
| `TZ` | The time zone for the daily maintenance hour; UTC if not set. Read on every start | |
| `CROMDB_RESTART_ON_EXIT` | `1` in the image: Restart is offered. Read on every start | |
| `CROMDB_VERSION` | Not read by the server: the image version `compose.yaml` runs | |

The server always listens on port 8080 in the container, whatever its
listen setting says, so the published port keeps working.
