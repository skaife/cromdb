# CromDB demo

Three replicas of one CromDB database, A, B and C, each running as its own process with its own port and its own database file. A page in the browser shows all three side by side and lets you edit notes on each and sync them with each other.

It runs on this machine only, with no login. The people on the page (Alice Anderson on A, Bob Baker on B, Carol Carter on C) are marked "(demo)": each replica simply acts as its one person. Real sign-in comes with the CromDB server.

## What it shows

**Scene 1, it just works.** Alice creates a note on A. It syncs to B, where Bob edits it. That syncs to C, where Carol edits it, and from C to A and B. There is no conflict: each edit was made after seeing the one before.

**Scene 2, the replicas disagree.** B and C go offline, and Bob and Carol both edit the same note without seeing each other's change. When they sync again, the replicas detect the conflict and keep both versions; nothing is merged or thrown away. All three replicas show the same conflict and pick the same version to show meanwhile, each on its own, by the same rules. Alice resolves it on A, and after syncing all three agree.

The page shows an activity log under replica A: what each replica reported, newest first. Every entry comes from a replica's answer, either to something you clicked or to the page's polling, which asks each replica for its notes once a second.

For following the two scenes step by step, as in the video, open http://localhost:4000/?captions. A caption bar at the top then walks through both scenes. Its Back and Next buttons only change the caption; everything else is done by clicking the page.

## Run it

From the repository root:

```
npm install
npm run demo
```

Then open http://localhost:4000.

The first run installs the demo's own dependencies (in `demo/node_modules`), creates the three database files in `demo/data`, and builds the page. Ctrl+C stops everything.

To start again with empty databases:

```
npm run demo:fresh
```

`npm run demo:reset` only recreates the database files, without starting anything.

The replicas listen on ports 4001, 4002 and 4003 and the page on 4000, all on 127.0.0.1. The page reaches each replica on its own port, so if you open the page through a forwarded port (VS Code Remote, for example), forward 4001 to 4003 as well, to the same port numbers.

## Start one replica by hand

Each replica is an ordinary program, so you can also run them in separate terminals. From the repository root, after `npm run demo` has run once:

```
node demo/server/replica.ts --name B
```

The options, with their defaults for B:

```
node demo/server/replica.ts --name B --port 4002 --data demo/data/b.db \
  --peer A=http://127.0.0.1:4001 --peer C=http://127.0.0.1:4003 \
  --page-port 4000
```

The page server is `node demo/server/page.ts`, with `--port` and one `--replica NAME=PORT` per replica.

## How to tell it isn't faked

- Each pane shows its replica's port, process ID and database file. The three process IDs differ: run `ps` (or open Task Manager) and you'll find them.
- Open the browser's developer tools on the Network tab. Each pane's requests go to its own replica's port. The page keeps no notes of its own: it only shows what each replica answers, and the only way a note moves from one replica to another is a Sync button.
- Kill one replica's process. Its pane turns grey and says it isn't running, and syncing with it fails. Start it again by hand (see above) and its pane comes back, with its notes.
- Look at the code. The servers in `demo/server` use only what the `cromdb` package exports, the same package anyone gets from npm, and a test fails the build if anything in `demo/` reaches around it. Sync is plain HTTP between the processes, using `syncPosition`, `exportChanges` and `applyChanges`. Offline means a replica refuses sync requests from its peers and starts none itself.

## Not for real use

There is no login, and the sync endpoints accept requests from anything on this machine. The servers listen on 127.0.0.1 only, and browsers may call them only from the page itself. The database files start as copies made in one process by `npm run demo:reset`, because CromDB can't create a replica over the network yet. After that the three files are independent, and only HTTP connects them.

## Files

- `server/replica.ts`: one replica. `server/app.ts` is its HTTP API, `server/sync.ts` the two-way sync with a peer.
- `server/page.ts`: serves the built page and tells it where the replicas are.
- `scripts/start.ts`: what `npm run demo` runs. `scripts/reset.ts` creates the database files.
- `web/`: the page, built with Vite and React. The captions are in `web/src/captions.json`, the activity log in `web/src/ActivityLog.tsx`.
- `test/`: end-to-end tests that start real replica processes and talk to them over HTTP, the import rule, and in `test/browser` a browser test that plays both scenes by clicking.

Run the tests from `demo/` with `npm test`, and the browser test with `npm run test:browser`. The browser test needs Playwright's Chromium:

```
npx playwright install chromium
```

On Linux, Chromium also needs some system libraries. Playwright can install them:

```
sudo env "PATH=$PATH" npx playwright install-deps chromium
```

The `env "PATH=$PATH"` part matters if Node comes from nvm: plain `sudo` resets `PATH`, so it wouldn't find `npx`.
