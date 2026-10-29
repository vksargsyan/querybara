# 0038. Reschema and Data Masking as field rules compiled to a server-side pipeline

- Status: Accepted
- Date: 2026-10-28

## Context

Studio 3T has two tools that write a collection again in a different form:

- **Reschema** restructures documents: renames, moves and nests fields, converts types, drops
  fields and adds computed ones.
- **Data Masking** writes a copy for people who must not see the data: characters hidden,
  values replaced, numbers and dates shifted.

ADR 0036 left both open.

Both apply a rule to each field and write the result to another collection. The documents may
number in the millions, so moving them through the app would be slow and would hold sensitive
values in memory along the way.

## Decision

**One rule model, two faces.**

- `@querybara/mongo-tools` (`reshape.ts`) defines the rules and compiles them into stages:
  - a `$set` of every value that changes (dotted targets nest);
  - an `$unset` of what is left out or moved away;
  - when only the listed fields are kept, a `$project` of them.
- `outputStage` adds the write: `$out`, which replaces the target collection and makes it when
  missing, or `$merge` by `_id`, which replaces matching documents and adds the rest.
- The server runs the whole pipeline, so the documents never leave it.

The rules:

- **keep**: under a new path, which moves or nests the field.
- **convert**: `$convert`, with the original value kept when a conversion fails.
- **exclude**.
- **mask**: shows the first and last _n_ characters and replaces the rest with a mask
  character. Strings only; a string shorter than what is shown is masked whole.
- **fixed**: a `$literal`, so a value starting with `$` stays a value.
- **null**.
- **random-number**: within ± a percentage. Int32 and Int64 values stay whole numbers of their
  type, and Decimal128 stays Decimal128.
- **random-date**: within ± a number of days.
- **computed**: an aggregation expression in mongosh syntax.

Each masking expression applies only to values of its type, and other values pass through
unchanged.

The compiler refuses rules that cannot work and names the rule:

- two targets that overwrite each other;
- a field moved inside itself;
- a non-`_id` field written to `_id`;
- an unparsable value or expression;
- a field that is left out while another rule writes into it.

**The panel.** One tool panel serves both faces; only the rules it offers differ.

- The collection's fields come from a schema sample, one rule each, kept as they are to begin
  with.
- Preview runs the rules, without writing, on the first ten documents and shows them before and
  after. The pipeline is shown as mongosh text and opens in the aggregation editor.
- Run asks first, always: it writes a collection, and `$out` replaces one. The question shows
  the exact `aggregate()`.
- The connection host applies the write rules again, so a read-only connection refuses.
- The panel opens from:
  - a collection's menu (Reschema…, Data Masking…);
  - the MongoDB toolbar's Reschema and Masking;
  - the `mongo.reschema` and `mongo.mask` commands.

## Consequences

- Reschema and masking cost one pass on the server, whatever the collection's size.
- `$rand` needs MongoDB 4.4.2 or later for the random rules; older servers fail that pipeline
  with their own error.
- Masking is not encryption: a masked copy is safe to share only as far as the rules go, and
  the source collection stays as it is.
- Hashing is not offered, since aggregation expressions have no hash function short of
  server-side JavaScript, which many deployments turn off.
