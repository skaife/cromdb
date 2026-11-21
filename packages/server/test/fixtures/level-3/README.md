# A level-3 data directory

`data/` is a data directory made by the server at commit 4f2f14b, the last
one whose driver served level 3 databases (cromdb 0.6.0's level). The server
started with this release raises such a directory to level 4 when it first
opens it; `test/level-3-data.test.ts` checks that it does, on a copy.

It was made by the server's own test harness at that commit, with the fake
login provider: setup, then the admin logged in, invited a second person,
made the database "Notes" and in it the documents "First" and "Second", and
made and deleted a third, "Gone". The client secret in `server.cromdb` is the
harness's test value. It holds:

- `server.cromdb`: the server database, with the admin's session
- `directory.cromdb`: two people, the admin and the one invited
- `databases/aff92d0b-5dfe-454f-86d1-eb4e209f5916.cromdb`: "Notes"

To make it again, check out that commit in a separate worktree, install and
build there, and run a test in its `packages/server/test` that does the steps
above with `fakeHarness` and `startTestServer` from `harness.ts`, then copies
the data directory out after `server.close()`. Tests copy these files before
using them: a database file is changed by being opened.
