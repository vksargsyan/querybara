# 0035. MongoDB structure and data compare through the SQL compare's paths

- Status: Accepted
- Date: 2026-10-16

## Context

Structure sync and data compare (spec §13, ADR 0009) covered MySQL, MariaDB and PostgreSQL;
ADR 0009 left MongoDB out. MongoDB has a structure worth syncing (collections with their
options and validators, indexes, views) and environments drift in it as SQL ones do, and the
driver already introspects it into a SchemaSnapshot: collections as tables with their options
as strings, each index's full spec in `definition`, views with their pipelines.

MongoDB differs where the SQL compare leans on the server: its statements are command
documents, not SQL text; no query operator hashes a document, so key ranges cannot be
checksummed on the server; writes report failures in a `writeErrors` field of an `ok: 1` reply
rather than failing; and a DDL or write script runs outside any transaction.

## Decision

**One SchemaDiff for both.** `diffMongoSchemas` (`@querybara/sync`, `src/mongo/structure.ts`)
produces the SchemaDiff the SQL diff does, with `dialect` 'mongodb' and a `collection` object
kind, built with the same OperationBuilder. Selection, dependency ordering, the operation list,
side-by-side definitions, script previews, reports, applies, re-compares, saved comparisons
and schedules all take it unchanged. `compareSchemas` picks the diff by engine; a MongoDB
snapshot never pairs with a SQL one.

- Collections are created with their options and indexes, dropped (destructive), and changed
  with `collMod`: validator, validation level and action, TTL, capped size and max, change
  stream images. Changes MongoDB can only make by re-creating the collection and copying its
  documents (capped or not, time series, clustered, default collation) are reported unscripted.
- Indexes compare by their whole spec: the key pattern in order, everything else with field
  order and number types ignored (`1` and `1.0`), `false` flags as absent. Hiding and TTL
  change in place; anything else drops and re-creates the index, the drop first (MongoDB
  refuses two indexes on one key pattern). `ignoreNames` matches indexes by definition;
  `ignoreCollation` applies to collections, indexes and views. The SQL-only options are hidden
  for MongoDB pairs.
- Views are created after what they read, changed with `collMod` (or re-created to change their
  collation) and dropped.

**Statements are command documents in shell syntax** (mongo-tools' `formatShell`), which a
MongoDB session's `execute` runs as they are and which parse back to the same BSON. Scripts are
mongosh scripts: `db = db.getSiblingDB(...)`, then `db.runCommand(...)` per statement for
structure; data scripts call a `sync(...)` helper they define, which throws on write errors so
that mongosh stops at the first failure. `runMongoCommand` gives the app and the CLI the same
rule: a reply with `writeErrors` or `writeConcernError` fails the statement.

**Data compare streams both sides in `_id` order.** `compareCollectionData` reads each
collection sorted by `_id` with the simple collation (binary string order, whatever the
collection's default) and no time limit, merges the two streams in MongoDB's BSON comparison
order (`compareBson`, checked for order as it reads), and compares documents by their
canonical Extended JSON text first and, only when the text differs, by a canonical form in
which field order (ignored by default) and number types (compared by default: the sync copies
them) are as the options say. There are no server-side checksums.

Differences reuse the SQL compare's RowDiff and spool: a row is the `_id` and the whole
document; `changedColumns` names the top-level fields that differ. The grid shows the `_id`,
those fields and, for updates, only their values on each side. Collections pair by name; views,
time series collections and collections on one side only are skipped with a reason.

**Applying writes in batches without transactions.** `MongoDataSyncScriptBuilder` batches
`delete` by `_id`, `update` with the whole source document and `upsert` (a document deleted
meanwhile comes back), and `insert`, up to 500 documents or 4 MiB of text per command. Each
collection's deletes run first, then updates and inserts; the first failure stops the apply
and the commands before it stay applied, which the review dialog, the job outcome and the CLI
say. Structure applies are non-transactional too and, as for MySQL, need an explicit tick in
the app and `--yes` on the command line.

## Consequences

- A MongoDB data compare reads both collections in full, so it costs one scan of each; ranges
  that match are not skipped as SQL checksums skip them.
- Sorting by `_id` with the simple collation cannot use the `_id` index of a collection with a
  non-simple default collation, so the server sorts in memory and a large such collection
  needs allowDiskUse-sized memory or fails with the server's error.
- Ignored fields are left out of the comparison but still copied when a document is updated,
  since updates replace whole documents.
- A collection's validator is applied with `collMod`; documents already stored are not checked
  against it until they next change, which the operation warns about.
- Elasticsearch sync stays out of scope.
