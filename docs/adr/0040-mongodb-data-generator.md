# 0040. A Data Generator from field rules, made in the app and inserted in batches

- Status: Accepted
- Date: 2026-10-28

## Context

Studio 3T's Data Generator fills a collection with made-up documents for tests and demos:
names, addresses, numbers and dates, shaped like the collection's own documents. ADR 0036
left it open.

The documents have to be made somewhere. The server can make random values with `$rand`, but
not names, addresses or email addresses, so they are made in the app.

## Decision

**A rule per field.** `@querybara/mongo-tools` (`generate.ts`) defines the rules:

- A rule names a field by its dotted path; nested documents are made as the paths need them.
- The value comes from a kind:
  - ids: ObjectId, UUID, a sequence;
  - people and places: first, last and full name, email address, phone number, company,
    street, city, country, postal code, web address;
  - text: words, a sentence;
  - numbers in a range: Int32, Int64, Double and Decimal128 (with a number of decimals);
  - a Boolean with a share of true values, a date in a range;
  - one of a list or a constant, both in mongosh syntax; null.
- A field can be left out of a share of the documents, or hold an array of 0 to _n_ values.
- Email and web addresses use the reserved `example.*` domains, and phone numbers the 555
  exchange, so no generated address reaches a real person.

The rules are checked before anything is made, and a rule that cannot work is refused with
its field named: a range that starts above its end, a list that does not parse, two rules for
one field, a value inside another rule's value.

**Seeded.** A small seeded random source makes the values, and each document draws from a seed
derived from the run's seed and its index. The same seed gives the same documents, batch by
batch, and the preview shows exactly the documents a run starts with.

**Rules read from the collection.** The panel starts with a rule per field of a schema sample
(nested fields included). The kind follows the field's most common type and its name: `email`
makes email addresses, `city` cities, an Int32 field numbers in the range the sample saw. A
string field with ten or fewer values picks among them. Arrays take the kind of their elements
and the lengths the sample saw, and a field missing from part of the sample is missing from the
same share. An empty collection starts with an id, a name and an email address.

**The panel.**

- It opens from a collection's menu (Generate Data…), the MongoDB toolbar's Generate and the
  `mongo.generate` command.
- It shows the rules, the first ten documents, the number to make (up to a million), the seed,
  and whether the documents are added or replace what the collection holds.
- Generate always asks first and shows the commands. Replacing deletes every document
  (`deleteMany({})`) before inserting.
- Documents go in as `insertMany` batches of 500 through the connection host, which applies the
  write rules again, so a read-only connection refuses. A schema validator applies as to any
  insert.
- Progress shows as it goes, and Stop ends the run after the batch in flight.

## Consequences

- Generation is limited by the round trips of 500-document batches; a million documents takes
  minutes, not seconds.
- The word lists are small and Latin-script; the values look like test data, not like a
  population.
- Rules are not saved between sessions; the seed and the rules make a run repeatable while the
  panel is open.
