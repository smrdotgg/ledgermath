# A small file

`v1/small/<id>.json` is a file that exists only in this test, to show what a page looks like.

## Where it is

- Address: `https://api.ledgermath.com/v1/small/<id>.json`.
- Reached from: nowhere; it is a test's.
- Schema: [A small file](https://github.com/smrdotgg/ledgermath/blob/main/schemas/small.schema.json), kept with LedgerMath's source; the API does not serve it.

## What its schema says

<details>
<summary>v1/small/&lt;id&gt;.json: what a small file holds, to show what a page of the reference looks like.</summary>

Its description is long enough to fold, so a reader sees its first sentence and opens the rest on a click; all of its words are in the Markdown either way.

</details>

## Example

An excerpt, made by the generator, of the file at [https://api.ledgermath.com/v1/small/abc.json](https://api.ledgermath.com/v1/small/abc.json) (700 bytes) as LedgerMath's fixed sample took it on 2026-11-26; that address serves the file as it is now.

```json
{
  "kind": "ledgermath.small/1",
  "size": 3,
  "when": "2026-11-26T12:00:00Z",
  "items": [{"name": "a", "p99.9": 1.5}],
  "first": {"name": "a", "p99.9": 1.5},
  "tags": {
    "colour": "blue",
    "shape": "round",
    "note": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…"
  },
  "counters": {"x_a": 1, "x_b": 2},
  "mode": "fast",
  "end": {"code": 0},
  "extra": false
}
```

<details>
<summary>What the excerpt leaves out, in 2 places</summary>

The excerpt is made by one rule, applied at every depth, and changes nothing else. A list of more than one element keeps its first, unless every element is a string, a number, true, false or null and the list takes at most 120 characters as JSON: then it is kept whole. An object keeps every member its schema names, but of members whose schemas are each nothing but a reference to one and the same definition (such as a request's eight phases), it keeps the first. Of an object's members whose names its schema does not fix, it keeps the first, then each next one while the values kept, as excerpted, take at most 300 bytes as JSON, and none after the first that does not fit. A string longer than 160 characters keeps its first 160 and ends with …

- `items`: its first element of 3
- `tags.note`: its first 160 of 400 characters

</details>

## Fields

Each field is named by its path from the top of the file: `a.b` is the member `b` of the object `a`, `[]` stands for each element of a list, `*` for a member whose name is not fixed (its object's type says when the names must match a pattern), and a name with a dot in it is written `["p99.9"]`. Under each path are its type and whether it is required (present wherever the object holding it is) or optional (it may be absent). An object said to have no other members holds none but those listed for it; any other object may hold members this page does not list. A shape used in more than one place is described once, under [Shared shapes](#shared-shapes), and each place links to it. Version 1 only ever gains fields, so a file may hold a field this page does not list yet: a reader ignores it.

### `kind`

always `"ledgermath.small/1"` · required

What this file is.

### `size`

integer, 0 or more · required

How many items it holds.

### `when`

string matching `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$` or null · optional

When it was made; null when nobody knows.

UTC, to the second.

### `items`

list of objects (shape [item](#shape-item)), at least 1 element · required

Its items, oldest first.

### `first`

object (shape [item](#shape-item)) · optional

Its first item, again.

### `tags`

object, at least 1 member, each member's name matching `^[a-z]+$` · optional

Words about it, by name.

### `tags.*`

string · one or more of them, each named to match `^[a-z]+$`

One tag, under its name.

### `counters`

object · optional

Counts, each under a name that starts x\_.

### `counters./^x_/`

integer · any number of them

One count.

### `mode`

one of `"fast"` or `"slow"` · optional

How fast it was made.

### `end`

object of exactly one of 2 shapes · required

How it ended: its code, or the signal that ended it.

It takes exactly one of these 2 shapes:

- Shape 1. It has `code`, and has no other member.
- Shape 2. It has `signal`, and has no other member.

### `end.code`

integer, 0 or more · required in shape 1

The exit code.

### `end.signal`

integer, 1 or more · required in shape 2

The signal's number.

### When `kind` is `"ledgermath.small/1"`

The first version of the shape.

It then may have `extra`.

#### `extra`

boolean · optional

Whether it holds more than it says.

## Shared shapes

`…` stands for the path at which the shape is used; each shape gives every place it is used.

### Shape `item`

object

One item.

Used at `items[]` and `first`.

#### `….name`

string, not empty · required

Its name, which may hold \<angle brackets\>, an_underscore, \*stars\* and `code`.

#### `…["p99.9"]`

number or null · optional

A figure whose name has a dot in it.
