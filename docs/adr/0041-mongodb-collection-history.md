# 0041. Collection History: changes made in the app, kept locally to undo

- Status: Accepted
- Date: 2026-10-29

## Context

Studio 3T's Collection History lists the changes made to documents through its views and
undoes them. Querybara asks before writes on connections that ask for it, and replaces a
document only while it is unchanged, but a saved edit could not be taken back. ADR 0036 left
the history open.

## Decision

**What is recorded.** These writes in the collection tab are recorded, each once the server has
taken it:

- an insert from the document editor (with the `_id` the server gave it);
- an edit, whole in the editor or one value in place, including a field removed;
- a delete of one document.

Each record keeps the canonical Extended JSON of the document before (not for an insert) and
after (not for a delete).

These are not recorded:

- bulk updates and deletes, and other writes of many documents (paste, the Data Generator,
  imports), since keeping every document before would make the history as large as the data;
- writes from IntelliShell and other tools;
- a delete of a document read with a projection, which is not the whole document.

**Where it is kept.** In the local store, in a `collection_changes` table (migration 7): the
newest 500 changes per collection. They go with the connection when it is deleted, and Clear
history forgets a collection's changes. The page records a change through main
(`mongo.changes.record`) after its write; a change that cannot be recorded never fails the
write.

**Undo.**

- An edit is undone by replacing the document with its version before, through the optimistic
  `replaceOne`, so it happens only while the document is as the edit left it.
- An insert is undone by deleting the document, only while it is as inserted.
- A delete is undone by inserting the document again; a document since inserted with the same
  `_id` makes that fail.
- Undo always asks first and shows the command. The connection host applies the write rules
  again, so a read-only connection refuses.
- An undo is recorded as a change of its own, so it can be undone in turn, and the change it
  undid is marked.

**The panel.** It opens from a collection's menu (Collection History…) and the
`mongo.collectionHistory` command. It lists the changes, newest first, and shows the document
before and after the selected one, with Undo.

## Consequences

- The local store now holds copies of documents that were edited through the app: up to 500
  versions per collection. Clear history removes them, and they go with the connection.
- The history is per installation: changes made on another computer, or by other people, are
  not in it.
- An undo that finds the document changed since is refused and says why. Undoing an older change
  then means undoing the newer ones first.
