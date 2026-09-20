# csv

Reading and writing comma-separated values, including the parts that make
CSV harder than splitting on commas: quoted fields, separators and newlines
inside them, doubled quotes, and records ending with either LF or CRLF.

```
halka add csv
```

```halka
from csv import parse, format, parse_records

match parse("name,age\nada,36\n"),
    Ok(rows),
        say rows[1][0],
    Error(message),
        say "bad csv: {message}"
```

## What it gives you

| | |
|---|---|
| `parse(text, sep: ",")` | `Result` of rows of fields |
| `parse_records(text, sep: ",")` | `Result` of maps, keyed by the header row |
| `format(rows, sep: ",")` | a document, quoting only where it has to |

Parsing is fallible, so it gives a `Result` (#22, #23): an unterminated
quoted field is an `Error` rather than a guess at where the field ended.
Formatting cannot fail.

`format` and `parse` round-trip: whatever `parse` accepts, `format` writes
back out so that parsing it again gives the same rows.

## License

MIT OR Apache-2.0, the same as Halka itself.
