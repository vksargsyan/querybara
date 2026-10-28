# 0037. MongoDB file import and export: Extended JSON, CSV and BSON jobs

- Status: Accepted
- Date: 2026-10-28

## Context

Querybara's file import and export (spec §12) read and write rows through a SQL session. They
refuse MongoDB, so a collection could only leave the server through Transfer (into another
database) or a backup (a `.qbak` archive). Studio 3T exports collections and query results to
JSON, CSV and BSON, and imports those formats into collections. mongoexport and mongoimport do
the same. ADR 0036 left this as a gap.

Rows do not fit documents. A document has nested sub-documents, arrays and BSON types (Int32,
Int64, Double, Decimal128, ObjectId, dates, binary) that a row's cells flatten or lose.
Extended JSON keeps them all.

## Decision

**Two job kinds of their own, next to the SQL ones.** `mongo-export` writes collections, or the
collection tab's query, to files. `mongo-import` reads a file into a collection. Both run in the
job runner, so they stream with progress, cancellation and the job history, as SQL jobs do.
Main gates them to MongoDB connections. It checks the paths against the window's dialogs and
applies the write rules: a read-only connection refuses an import; a production or
confirm-writes connection, and the replace mode, need confirmation.

The formats live in `@querybara/transfer` (`mongo-files.ts`):

- **JSON**: an array of documents, one per line, or indented.
- **JSON Lines**: one document per line, as mongoexport writes.
- Both are Extended JSON, **relaxed** by default (mongoexport's choice) or **canonical**.
  - Relaxed output is built from the canonical form. An Int64 beyond 2^53, a non-finite or
    negative-zero double, and a date outside 1970–9999 stay canonical.
  - The bson package's own relaxed output rounds such Int64s.
- **CSV**: a column per field, with sub-document fields as dotted columns (`address.city`).
  - The fields are the ones given (the dialog's "Scan fields" samples 1,000 documents), or else
    those of the first 1,000 documents.
  - Plain types are written as text: numbers, strings, booleans, ISO dates, ObjectId hex and
    UUIDs. Arrays and other types are written as relaxed Extended JSON.
- **BSON**: documents back to back, as in mongodump's `.bson` files.
- Any of them can be gzipped.

**Reading takes what the writers make and what mongoexport makes.**

- One splitter reads JSON as an array, as JSON Lines, or as documents one after another
  (mongoexport's `--pretty`), so the user does not choose between them.
- CSV can infer types:
  - integers become Int32, else Int64, else Double;
  - decimals become Double, and `true`/`false` become booleans;
  - ISO dates and timestamps become dates;
  - a 24-digit hex `_id` becomes an ObjectId;
  - text that parses as Extended JSON becomes that document or array.
- CSV can also keep every value as text. Dotted headers make sub-documents.
- An empty CSV field is left out, set to null, or kept as an empty string.
- BSON is split by each document's length prefix and read without promoting number types.
- A value that is not a document fails with its row and line.

**Writing goes in ordered batches** of 1,000 documents or 8 MB of Extended JSON. A refused
document either stops the import or is skipped; the documents before it stay written, and the
job lists each refused one. Three modes:

- **insert** adds the documents.
- **upsert** replaces the stored document with the same `_id`, or adds the document; one without
  an `_id` is inserted. It uses a new driver call, `upsertMany`: an ordered `bulkWrite` of
  `replaceOne(..., { upsert: true })`.
- **replace** deletes every document first. The collection, its indexes and its validator stay.

**The dialogs.**

- Export opens from:
  - a collection's menu (Export Collection…);
  - a database's or the Collections folder's menu (Export Collections…, with every collection
    to choose from);
  - the MongoDB toolbar and the `mongo.export` command;
  - the collection tab, where it offers "What the query finds" or every document.
- Import opens from:
  - a collection's menu (Import into Collection…);
  - a database's menu (Import Collection…), which names a new collection after the file;
  - the toolbar and the `mongo.import` command.
- Several collections export to a folder, a file each.

## Consequences

- MongoDB data reaches spreadsheets and other tools without Transfer. Files that mongoexport and
  mongodump write load back, apart from mongodump's `metadata.json`: indexes and options are
  not read from files (a backup keeps them).
- CSV is lossy, as in every tool. Int64 and Double numbers read back as the smallest type that
  holds them, and arrays round-trip only as Extended JSON text.
- Relaxed Extended JSON does not tell Int32 from a whole Double. Canonical export keeps them
  apart.
- querybara-cli's `import` and `export` stay SQL-only. Scheduled MongoDB exports are not offered
  yet.
