# 0045. MongoDB 4.2 through the 6.x driver, kept next to 7.x

- Status: Accepted
- Date: 2026-11-17

## Context

The mongodb Node.js driver 7.x speaks wire version 9 and up: MongoDB 4.4 and later. The embedded
mongosh (ADR 0036) asks for driver ^7.5 too. Servers still on MongoDB 4.2 (wire version 8, out
of support since 2023) refused every connection: the handshake failed, and Querybara reported a
server selection timeout, later "runs MongoDB 4.2, which is older than Querybara supports".
Users with such servers asked for them to work.

Driver 6.22, the last 6.x, is the newest release that speaks MongoDB 4.2. Its calls have the same
shape as 7.x for everything Querybara does. It asks for bson ^6, and bson refuses to serialize a
value made by another major release. Querybara's packages make bson 7 values (mongo-tools,
backup, transfer), and the mongosh shell runs on bson 7.

## Decision

**Two drivers, one bson.** `packages/drivers/mongodb` depends on `mongodb` 7.x and on `mongodb6`
(an alias of `mongodb@^6.22.0`). An override in `pnpm-workspace.yaml` (`mongodb@6>bson`) puts
6.x on the same bson 7 as everything else, so documents, ObjectIds and the other values pass
between the two drivers and the rest of the repo unchanged.

**The server picks the driver** (`src/driver.ts`). Every connection starts on 7.x. When 7.x
refuses the server as too old, which happens at the handshake before any login, the same URL and
options connect through 6.x. A server older than 6.x speaks (MongoDB 4.0 and before) is still
refused, as quickly, naming 4.2 as the oldest supported release.

- The legacy client is typed as a 7.x `MongoClient`. GridFS buckets come from the driver that
  made the database's client.
- Sessions, Test Connection (with its topology diagnostics) and the embedded shell all connect
  through it. The shell hands the 6.x client to mongosh's service provider, which works on it.
- Test Connection's Server version step says so: "MongoDB 4.2.25, standalone; through the driver
  kept for MongoDB 4.2".

**CI** runs `test/integration/legacy.test.ts` against a `mongo:4.2` standalone on every pull
request: connection, documents, editor commands, indexes and structure, GridFS and the shell.

## Consequences

- MongoDB 4.2 works, standalone and replica set, as far as the server goes. Features it lacks
  fail with its own error: hidden indexes and `$isNumber`/`$rand` in Reschema and Data Masking
  (4.4), time-series collections and detailed validation errors (5.0).
- A query exported as a Node.js program asks for `mongodb` 7.x. Against MongoDB 4.2 it needs
  `mongodb@6` instead.
- The 6.x driver gets security fixes only. When it stops getting those, or Querybara drops 4.2,
  remove `mongodb6`, the override and `src/driver.ts`'s legacy branch together.
- The 6.x driver runs on a bson major it was not released against. The 4.2 tests in CI are what
  keep that honest.
