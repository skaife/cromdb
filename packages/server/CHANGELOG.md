# Changelog

CromDB Server, the `@cromdb/server` package and the `ghcr.io/skaife/cromdb-server` image. Each release is tagged `server-vX.Y.Z`. While it is 0.x, a release may change settings or behavior; this file says what to look out for.

## 0.4.0

- The update check: a new setting, `updateCheck`, off unless turned on (in the admin UI's Settings, under Updates, or with `config set updateCheck yes`). When on, the server asks GitHub about once a day whether a newer version is published, and the Status page says so, with what changed and the steps to upgrade. It only reads the reply. It never downloads or installs anything.
- Leaving a screen with unsaved changes asks first: the menu, a tab, a link, the back button, or another document. Closing or reloading the tab still gets the browser's own question.
- Beside a conflict's versions, the documents list shows only the titles. The other columns come back when the conflict view closes.
- The header shows a new server name as soon as it is saved.
- A replaced client secret counts as waiting for a restart, so Restart now and the waiting note appear.
- A listen address given when the server was started (`--listen`, as the Docker image does) is shown read only in Settings, and no longer looks like a setting waiting for a restart forever.
- The Docker guide's restore steps put the backup into the volume Compose made, so `docker compose up` no longer warns that the volume "already exists but was not created by Docker Compose". The guide says how to make that warning go for a volume made by the old steps.

## 0.3.0

The first published release.

- The Docker image, `ghcr.io/skaife/cromdb-server`, with a Compose file and a guide (`docker/README.md`).
- `cromdb-server run`, which the image runs: on an empty data directory it sets up from `CROMDB_*` variables, then starts.
- `cromdb-server health`, for the image's health check.
- The server keeps an idle connection open 65 seconds, longer than a proxy's usual 60.

## 0.2.0

Not published.

- Settings while it runs: server admins read and save the settings in the admin UI or the API. Some take effect at once, the rest at the next restart.
- The client secret can be replaced, never read.
- Restart from the admin UI, when something starts the server again (`CROMDB_RESTART_ON_EXIT=1`).
- The admin UI's Settings, Status and Servers pages.

## 0.1.0

Not published.

- `cromdb-server setup`, `start`, `config`, `admin grant` and `version`.
- Login through an OpenID Connect provider, sessions and logout.
- The API under `/api/v0`: people, invitations, databases, their access lists, documents and conflicts.
- A daily purge of every database, and compaction after a large one.
- The admin UI at `/`: databases, documents, conflicts, access, replicas, people and invitations.
