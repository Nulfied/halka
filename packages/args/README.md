# args

Parsing command-line arguments, including the parts everyone gets wrong:
`--out x` and `--out=x` handled differently, `-abc` as one switch instead
of three, `--` forgotten, a value asked for and not supplied read as the
next flag.

```
halka add args
```

```halka
from args import parse, has, option

match parse(["push", "--remote", "origin", "-fv", "--", "-x"], ["remote"]),
    Ok(got),
        say option(got, "remote", "origin"),
        say got.switches,
        say got.rest,
    Error(message),
        say "bad arguments: {message}"
```

## The second argument

`parse(argv, valued)` takes the names of the options that consume the next
argument. Without it there is no way to tell `--out app` (an option and its
value) from `--verbose app` (a switch and a positional), and every parser
that pretends otherwise guesses wrong on one of them.

`--out=app` carries its own value, so it works whether or not `out` is
listed — which is the whole reason people write it that way.

## What you get back

| | |
|---|---|
| `options` | `map(string, string)` — `--name value` and `--name=value` |
| `switches` | `list(string)` — `--name` and `-n`, in order |
| `rest` | `list(string)` — positionals, plus everything after `--` |

With `has(parsed, name)` and `option(parsed, name, fallback)` for reading
them without an `or` at every call site.

## The details it gets right

- `-abc` is three switches, which is what every tool taking short options
  does.
- `--` ends option parsing: nothing after it is an option however it is
  spelled, including a second `--`.
- `-` on its own is a positional, because to most tools it means standard
  input.
- `--path=a=b` splits on the first `=` only.
- `--out` with nothing after it is an `Error` (#22, #23), not a silent
  empty string.
- Names and values outside ASCII keep their length, because the slicing
  counts code points rather than bytes.

## License

MIT OR Apache-2.0, the same as Halka itself.
