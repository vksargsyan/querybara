# 0036. MongoDB as Studio 3T's: IntelliShell on an embedded mongosh, in a worker thread

- Status: Accepted
- Date: 2026-10-28
- Supersedes in part: [0007](0007-nosql-engine-services.md) (its note that the MongoDB console
  runs command documents until the embedded shell has a packaging decision)

## Context

Querybara's MongoDB module grew tool by tool: the collection tab with its query bar and Tree,
Table and JSON views, the Visual Query Builder, the Aggregation Editor, SQL queries, schema
analysis, the index, user and role managers, GridFS, compare (ADR 0035), transfer, server tools
and schedules. People who come from Studio 3T find most of what they use there, but not where
they look for it, and not its centre: IntelliShell, a mongosh editor whose `find()` and
`aggregate()` results open in the same views as a collection's. Querybara's console ran command
documents (`{ find: "orders", filter: … }`) only. ADR 0007 left the real shell waiting for a
packaging decision: the `@mongosh/*` packages worked against our client in a spike but brought
about 129 MB of dependencies.

Studio 3T's workspace, as this decision maps it:

| Studio 3T                                           | Querybara                                                  |
| --------------------------------------------------- | ---------------------------------------------------------- |
| IntelliShell (mongosh, Query Assist, result tabs)   | IntelliShell on the embedded mongosh (this record)         |
| Collection tab: query bar, Tree/Table/JSON, Explain | Collection tab in Studio 3T's layout (this record)         |
| Visual Query Builder                                | Visual Query Builder, docked on the collection tab's right |
| Query Code                                          | Node.js, Python, Java, C#, Go, PHP, Ruby and mongosh       |
| Aggregation Editor, SQL Query                       | Aggregation Editor, SQL query tab                          |
| Schema Explorer                                     | Analyze Schema                                             |
| Compare (structure and data)                        | Structure and data compare (ADR 0035)                      |
| SQL Migration, data transfer                        | Transfer Data To… (MongoDB ↔ SQL and MongoDB ↔ MongoDB)    |
| Index Manager, User Manager, Role Manager           | Manage Indexes, Manage Users, Manage Roles                 |
| Server Status, Current Operations, Query Profiler   | Server tools: monitor, sessions, top queries               |
| Tasks (scheduled)                                   | Schedules (ADR 0019), MongoDB exports included             |
| GridFS, Watch Changes                               | GridFS buckets, change streams                             |
| Main toolbar and its keys                           | MongoDB toolbar and Studio 3T's default keys (this record) |
| Import/Export wizards (JSON, CSV, BSON, SQL)        | Export and Import of collections and queries (ADR 0037)    |
| In-place editing in Table and Tree views            | Values edited in place, typed (this record)                |
| Query History, saved queries                        | The collection tab's History and Saved (this record)       |
| Copy/Paste documents and collections                | Copy and Paste across collections and connections          |
| Reschema, Data Masking                              | Reschema and Data Masking panels (ADR 0038)                |
| Authentication: SCRAM, LDAP, X.509, AWS IAM, OIDC   | The same, Kerberos aside (ADR 0039)                        |
| Data Generator                                      | Data Generator panel (ADR 0040)                            |
| Collection History                                  | Collection History panel (ADR 0041)                        |
| Connection Manager import (Compass, Robo 3T, URI)   | Import Connections reads the same files, and URIs          |

## Decision

**mongosh is embedded, bundled, and loaded only when a shell opens.** The Apache-2.0
`@mongosh/shell-api`, `shell-evaluator`, `autocomplete` and `service-provider-node-driver`
(5.9) run the scripts. They need MongoDB driver 7, so the workspace moves to `mongodb` 7.7 and
`bson` 7.3 together. electron-vite bundles them into one worker entry, `mongo-shell.cjs` (about
6.4 MB), beside the connection host's own bundle, which stays light: the host's `ShellClient`
imports no mongosh. Two things are kept out: `@mongodb-js/mongodb-ts-autocomplete`, which
brings the TypeScript compiler for completions the classic completer already gives, and the
Babel preset that mongosh's async rewriter requires only for `.cts` config files (left
unhoisted with `commonjsOptions.ignore`, so the require is never reached). Their licences reach
THIRD_PARTY_NOTICES through the build's existing audit (ADR 0013).

**One worker thread per shell, in the connection host.** A script runs on a thread of its own
with a MongoClient of its own, opened through the same transport (SSH or proxy tunnel) as the
host's session, so an endless loop never blocks the host's other services. The thread and the
host talk over the worker's port (`HostToShell` / `ShellToHost`); the profile crosses without
its functions. Stop asks mongosh to stop at its next checkpoint; a script that does not stop
within 3 s (a `while (true) {}` makes no shell call) has its thread terminated, and a new one
opens in the same database, as after Studio 3T's Restart Shell: variables and open results are
gone, and the output says so. Runs and requests sent while a thread is connecting wait for it.
Closing the tab, or the connection, ends the thread.

**The write rules hold in the shell.** mongosh reaches the server only through its service
provider, so the shell's provider is wrapped (`guardServiceProvider`): every method that writes
is classified, `runCommand` with the classifier the console and querybara-cli share, and
checked before it runs. A read-only profile refuses writes; destructive operations ask on every
profile; profiles that confirm writes ask for every write. The question shows the operation and
its namespace, and answers Don't run, Run, or Run all writes (for the rest of that run).
`Mongo()` and `connect()` are refused, so a script stays on the profile's connection. This
guards against mistakes, not against the person typing: code that digs the driver's client out
of mongosh's internals goes around it, as it would around any client.

**Query results keep their exact types and page as a collection's do.** A result handler on the
evaluator takes each cursor before mongosh prints it and rebuilds it with raw BSON options, so
Int32, Double, Long and Decimal128 values stream as canonical Extended JSON pages into result
tabs that use the collection tab's Tree, Table and JSON views, its pager and its document
actions. Query Assist turns this off for a plain mongosh transcript. Other values print as
mongosh prints them (`show dbs`, `help`, documents in mongosh's notation, dates as `ISODate`).

**Scripts run by statement.** acorn splits a script into its top-level statements, with `use`
and `show` lines taken as commands: F5 runs the whole script, F6 the statement at the cursor,
F9 the selection (Shift+Enter and Ctrl+Enter as in Studio 3T). A syntax error is marked at its
line before anything runs; a statement that fails stops the script there. The old console's
command documents still run, as `db.runCommand(…)`, a cursor command or an admin command, so
a saved console tab restores as an IntelliShell with its text. Completion merges the classic
mongosh completer with collection and field names sampled from the database.

**Studio 3T's workspace around it.**

- The collection tab takes Studio 3T's layout: a breadcrumb; a toolbar with Run (find, findOne,
  count), Open query in IntelliShell, the Aggregation Editor or SQL, Reset and Explain; the
  Query, Projection, Sort, Skip and Limit grid; and Result, Query Code and Explain sections.
  The Visual Query Builder docks on the right. The chosen view is remembered (Table first).
- A MongoDB toolbar under the title bar (Connect, Collection, IntelliShell, SQL, Aggregate,
  Query Profiler, Compare, Schema, Transfer, Tasks, Users, Roles, Server Status) shows while a
  MongoDB connection is open; View › Toggle MongoDB Toolbar hides it. ADR 0042 made it the
  connection toolbar, which shows these tools while a MongoDB connection is in front.
- Each tool is a `mongo.*` command in the palette and key bindings (ADR 0031). It acts on the
  active tab's connection, database and collection, else on the side bar's selection, else on
  the only MongoDB connection open, and asks for what is still missing. Studio 3T's keys are the
  defaults: Ctrl+L IntelliShell, Ctrl+Shift+L SQL, F4 Aggregation Editor, Ctrl+Alt+1/2/3 Tree,
  Table and JSON views, Ctrl+D insert, Ctrl+U update, F8 delete, Ctrl+G Query Code, Ctrl+Alt+B
  the toolbar.
- The tree's menus follow Studio 3T's order and add Copy Name, Rename Collection, Duplicate
  Collection (documents with `$out`, then each index), Clear Collection, and collection,
  database and server statistics (run in an IntelliShell). Each write shows its exact command
  before it runs. Documents get a right-click menu. A menu longer than the window scrolls.
- A double-click on a value in the Table or Tree view edits it in place, in its type (a type
  picker changes it, or edits it as a mongosh expression); the document is replaced only while
  it is unchanged, as the document editor does, and removing a field always asks.
- The collection tab records each run in the app's query history: History runs one again, and
  Saved keeps named queries per collection (saved queries of the local store, as the
  aggregation editor's pipelines).
- Copy Document, Copy All Documents and Copy Collection fill an in-app clipboard (and the system
  one, as text). Paste Documents… shows the documents in an editor, where text from elsewhere
  can be pasted too (the page cannot read the system clipboard), and inserts them, each with its
  `_id` or a new one. Paste Collection copies a collection with its documents and indexes into
  another database or connection, through a MongoDB → MongoDB transfer (new in the transfer
  engine; options such as a validator are not copied, and the plan says so), or duplicates it
  within its own database.

## Consequences

- Each open IntelliShell costs a thread and a connection pool; a hard restart loses the shell's
  variables, which the output says.
- mongosh pins the driver's major version: the two move together, and an upgrade is tested
  through the shell's integration tests as well as the driver's.
- Completion is the classic completer's plus sampled field names, without the TypeScript
  autocompleter's type-aware suggestions.
- querybara-cli keeps running command documents (`querybara query`); scripts are the app's.
- File import and export came with ADR 0037, Reschema and Data Masking with ADR 0038, AWS IAM
  and OIDC sign-in with ADR 0039, the Data Generator with ADR 0040, the collection history with
  ADR 0041.
- Three of Studio 3T's features are not offered:
  - Kerberos (GSSAPI) sign-in: it needs a native module per platform (ADR 0039).
  - The AI Helper: it needs a model provider, and would send queries and field names off the
    machine.
  - Team Sharing: it needs a hosted service. Connections and queries move between machines as
    files instead (encrypted connection exports, query files).
