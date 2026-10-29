# 0042. A toolbar for every connection, following the one in front

- Status: Accepted
- Date: 2026-10-29

## Context

ADR 0036 gave MongoDB Studio 3T's row of tools under the title bar. Each tool is a command
acting on the collection in front, and asks for what is missing. People liked it and asked for
the same on MySQL, MariaDB, PostgreSQL and the rest.

The other engines' tools existed, but only in the explorer's menus: on a connection, a
database, a schema or a table. Reaching one meant finding the right node first. Only a handful
were commands (New Query Tab, New Database…, Create Table…).

The MongoDB toolbar showed whenever a MongoDB connection was open, even with a PostgreSQL tab
in front. With several engines open, one row per engine would crowd the window.

## Decision

**One toolbar, showing the tools of the connection in front.** The connection in front
(`state/connection-context.ts`) is found in this order:

1. The active tab's connection.
2. The connection of the node last picked in the side bar.
3. The connection last in front, while it stays open.
4. The first open connection.

The toolbar changes as you move between a PostgreSQL tab and a MongoDB one. It is labelled with
the engine's name, shows while any connection is open, and View › Toggle Toolbar (Ctrl+Alt+B,
the MongoDB toolbar's key) hides it.

**A set per engine** (`components/toolbar/tools.ts`), every button a command (ADR 0031), so each
is in the palette and can be given a key:

| Engine                        | Tools                                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MySQL, MariaDB and PostgreSQL | Connect · Query, Builder, SQL File, History · Table, New Table, New Database, ER Diagram · Import, Export, Transfer, Backup, Restore · Compare, Data Compare, Tasks · Monitor, Sessions, Top Queries, Users, Maintenance |
| MongoDB                       | ADR 0036's set, unchanged                                                                                                                                                                                                |
| Redis                         | Connect · Keys, CLI, Pub/Sub, Search · Dashboard, Slow Log, Clients, Latency, Monitor, Big Keys · Config, ACL, Topology · Transfer, Backup, Restore, Dump, Tasks                                                         |
| Elasticsearch                 | Connect · Console, Documents, SQL · Index, New Index · Cluster, Templates, Snapshots                                                                                                                                     |

Each tool opens what the explorer's menus already open, with the same write rules:

- New Table, New Database, Import, Restore and Elasticsearch's New Index are off on a
  read-only connection.
- Production connections still ask before writes, as everywhere else.

**What a tool acts on.** The engines' commands act on the connection in front of their engine,
else the only open connection of it, and ask when several are open and none is in front.

The SQL context (`state/sql-context.ts`) adds the database, schema and table:

- from the active tab: a query tab's database, a table data view's table;
- else from the node last picked in the side bar.

What is still missing is asked for from the explorer's own lists: a database, then a PostgreSQL
schema, then a table. Import's list also offers a new table. For example, Table with a database
picked asks for the schema, then the table.

Redis tools open on the logical database of the Redis tab in front. Elasticsearch's Documents
and Index work on the index, alias or data stream of the tab in front, and ask for one
otherwise.

**What moved.**

- MongoDB's `view.toggleMongoToolbar` became `view.toggleToolbar`. A key bound to the old id
  carries over.
- The visibility kept in the browser profile moved to `querybara.toolbar`, falling back to the
  old key.
- Elasticsearch's Create index dialog moved from the tree into a request
  (`state/search/create-index.ts`), so the toolbar and the tree open the same dialog.

## Consequences

- The toolbar always matches the tab you are working in, and an engine's tools are one click
  from anywhere. Nothing that worked through the menus changed.
- With nothing in front, the toolbar keeps showing the engine last in front rather than
  switching to a fixed one. A tool there acts on that connection, or asks when it cannot tell.
- A new tool for an engine is one command and one line in `tools.ts`. A new engine needs its
  own set; the types ask for one.
- The SQL tools do not read the database of every SQL panel (an ER diagram, a query builder,
  a designer). Those fall back to the side bar's pick, or ask.
