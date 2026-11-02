# 0044. Empty, truncate and duplicate a table; Navicat's object keys

- Status: Accepted
- Date: 2026-11-02

## Context

Navicat users reach for a table's menu to empty it, truncate it or copy it. They also expect its
keys on the selected object: ⌘O to open a table, ⌘D to design it, ⌘N for a new table. Querybara
had none of these. Every key binding (ADR 0031) acted on the whole window. ⌘D was already
MongoDB's Insert Document in a collection tab (ADR 0036).

## Decision

**A SQL table's menu** (`components/ObjectMenu.tsx`, `state/table-actions.ts`) adds, after Open
data, Design table and New table…:

- **Empty table…** runs `DELETE FROM`: every row goes, and the auto-increment counter keeps its
  value.
- **Truncate table…** runs `TRUNCATE TABLE`, so the counter starts over. On PostgreSQL that takes
  `RESTART IDENTITY`; MySQL and MariaDB reset AUTO_INCREMENT on their own.
- **Duplicate table ▸ Structure and data… / Structure only…** opens a dialog. It shows the copy's
  name (`orders_copy`, or the next free one, as MongoDB's Duplicate Collection names it) and the
  script, which follows the name as it is typed.
  - The structure comes from `CREATE TABLE … LIKE` (PostgreSQL: `INCLUDING ALL`). That copies the
    columns, defaults, keys, indexes and checks, never foreign keys or triggers. The dialog says
    so.
  - The rows come from `INSERT … SELECT` of every column the server does not compute.
  - On PostgreSQL, `OVERRIDING SYSTEM VALUE` keeps the values of `GENERATED ALWAYS` identity
    columns. The copy's own identity sequences then move past those values. The script runs in
    one transaction.
- Empty and Truncate show their statement in a confirmation first. All three then run through
  the write-safety rules: a read-only profile does not offer them, and a production profile asks
  again.
- Afterwards the tables folder reloads. Open data views of an emptied table reload too, unless
  they hold staged changes.

MongoDB keeps its own Clear Collection… and Duplicate Collection… (ADR 0036).

**Object keys** (`state/object-shortcuts.ts`) act on the item with the keyboard focus: a side bar
row, the Objects view's selection, or the menu open on either.

- **What each key does:**

  | Keys | Command             | SQL                                                   | MongoDB                          |
  | ---- | ------------------- | ----------------------------------------------------- | -------------------------------- |
  | ⌘O   | `explorer.open`     | a table's data, a view's rows                         | a collection's documents         |
  | ⌘D   | `explorer.design`   | the table designer                                    | none                             |
  | ⌘N   | `explorer.newTable` | a new table in the database, schema or table's schema | a new collection in the database |

- **How they are found:** each row, the Objects grid and their menus say what the keys do. The
  command walks up from the focused element to the nearest one that does.
- **Enabled only where they apply:** a command is enabled only when the focused item has its
  action. So the palette never lists these commands, and the keys mean nothing elsewhere.
- **From an open menu:** a key closes the menu, as choosing the item would.
- **Shown in the menus:** the menus show the keys at the right of the items, from the user's
  bindings.

**Scoped key bindings** (`state/keybindings.ts`): the three commands are in the `explorer`
scope.

- Commands of different scopes may share a key.
- When both are enabled, the scoped one runs first. So ⌘D designs the focused table, while ⌘D in
  a collection tab still inserts a document.
- The Keyboard Shortcuts editor marks a conflict only within one scope.
- MongoDB collections take no ⌘D. A click on a collection opens its tab but leaves the focus in
  the tree, and ⌘D there must stay Insert Document.

## Consequences

- Navicat's keys work in the side bar and the Objects view. Users can rebind them, and the menus
  follow.
- The scope is a small `when` clause: one scope, not VS Code's expressions. More can be added the
  same way.
- On PostgreSQL, a duplicated `serial` column still uses the original table's sequence, since
  `LIKE` copies the default as it is. Identity columns get their own sequences.
- On MySQL and MariaDB the copy is not one transaction: DDL commits at once. If the rows fail to
  copy, the empty copy stays, and the failure message says the first statement was applied.
