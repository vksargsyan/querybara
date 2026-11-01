# 0043. A lighter connection toolbar and title bar

- Status: Accepted
- Date: 2026-11-01
- Supersedes in part: [0042](0042-a-toolbar-for-every-connection.md) (the tools of each engine
  and how the toolbar draws them), [0026](0026-window-chrome-and-engine-icons.md) (the title
  bar's actions)

## Context

ADR 0042 put every tool an engine's explorer menus open into the connection toolbar: 22
buttons for the SQL engines, 21 for MongoDB. People found it hard to read:

- Every icon was in the label's grey, so nothing stood out.
- Each button was as wide as its label, so "Query" and "New Database" took different widths
  and the row looked uneven.
- The groups between the separators had no names.
- Most of the tools are one click away in the connection's menu anyway (New query tab, New
  database…, Run SQL file…, query builder, ER diagram, Server tools, Transfer, Back up,
  Restore, Compare structure/data with…), and all of them are in the palette.

The title bar also repeated the toolbar. Its New query, Compare and Schedules buttons opened
what the toolbar's Query, Compare and Tasks buttons open, and Jobs sat beside them.

## Decision

**The toolbar keeps the essentials** (`components/toolbar/tools.ts`), in labelled groups:

| Engine                        | Groups and tools                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| MySQL, MariaDB and PostgreSQL | Query: Query, Builder · Objects: Table, ER Diagram · Data: Import, Export · Compare: Structure, Data, Saved · Tools: Monitor, Tasks |
| MongoDB                       | Query: Collection, IntelliShell, Aggregate · Data: Import, Export · Compare: Structure, Data, Saved · Tools: Schema, Monitor, Tasks |
| Redis                         | Data: Keys, CLI, Pub/Sub · Server: Dashboard, Slow Log, Clients · Tools: Tasks                                                      |
| Elasticsearch                 | Query: Console, SQL · Data: Documents, Index · Server: Cluster, Snapshots                                                           |

- Connect is gone: a new connection does not act on the connection in front. It stays in the
  side bar's Connection actions and the palette.
- Every tool that left the toolbar keeps its command, so it stays in the palette with its key,
  and in the menus that opened it before.
- MongoDB gains **Compare Data To…** (`mongo.compareData`), so both document engines and SQL
  compare structure and data from the toolbar.

**How it draws** (`components/toolbar/ConnectionToolbar.tsx`):

- Every button is one width (72px). Labels are a word or two short words, and a unit test
  keeps them short.
- Each icon takes a Kiln glaze, and the label stays muted. The same kind of tool gets the same
  glaze on every engine: query and shell tools cobalt, tables and keys teal, builders and
  structure compare lilac, import celadon, export and monitors rust, tasks and saved items
  ochre.
- Each group sits between separators with its name in small caps above it. The group is a
  `role="group"` with the name as its label.

**The title bar keeps the window's own toggles** (`components/TitleBar.tsx`): the side bar,
History and the theme. History's glyph is the side bar's mirrored, its panel on the right
(`sidebar-right`). New query, Compare, Schedules and Jobs leave it:

- New query: Ctrl/⌘+T, the palette's Query: New Query Tab, and the toolbar's Query or Console.
- Compare: the toolbar's Compare group. The palette gains Compare: Compare Structure…,
  Compare Data… and Saved Comparisons…, which open a blank compare or the saved ones with no
  connection in front. The saved comparisons dialog is mounted once in App, no longer inside
  the menu.
- Schedules: the toolbar's Tasks and the palette's Tools: Schedules.
- Jobs: the panel still opens by itself when an import, export, SQL file, transfer, backup or
  restore starts, and Tools: Toggle Jobs opens it from the palette. The running count on the title bar
  is gone with the button.

## Consequences

- The toolbar fits a laptop's width, and its colours and group names make it quicker to scan.
- A tool that left the toolbar takes one more step: the connection's menu, or the palette.
- With no connection open there is no toolbar, so a compare, the schedules or the jobs open
  from the palette.
- A new tool for an engine is still one command and one line in `tools.ts`, now with a tone,
  in a named group.
