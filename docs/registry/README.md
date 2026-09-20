# The Halka package registry

Served at **https://nulfied.github.io/halka/registry**, which is what
`halka add` talks to unless `HALKA_REGISTRY` says otherwise.

```
index/<name>.json        every published version of one package
pkg/<name>/<ver>.tar.gz  the archive
```

That is the whole registry. It is a directory of files in this repository,
served by GitHub Pages, so it costs nothing to run, cannot go down
separately from GitHub, and can be mirrored by copying it.

## The archives are the registry

Every index file is *derived* from the archives beside it, by reading each
one's `halka.pkg` and hashing its bytes. Nothing about a published version
is recorded anywhere else.

An index that is maintained by hand can disagree with the archives — a hash
pasted wrong, a dependency edited in one file and not the other, a version
listed that was never uploaded — and every one of those disagreements is
found later, by somebody's build failing. A derived index cannot disagree.
CI rebuilds it on every pull request and fails if what is committed differs.

## Publishing

There is no account, no token and no upload endpoint. A version becomes real
when a file appears, and the pull request that adds it is the review.

```bash
halka pkg publish
```

Against the public registry that packs your project and tells you what to
commit. In full:

1. `halka pkg publish` in your project — it writes `<name>-<version>.tar.gz`
   and prints its SHA-256.
2. Fork this repository and add the archive as `docs/registry/pkg/<name>/<version>.tar.gz`.
3. `halka pkg index docs/registry --write` to rebuild the index.
4. Open a pull request with both files.

CI then checks that the index matches the archive, that the archive's
manifest agrees with where it is filed, and that the package has a license,
a description and source under `src/`.

## What is refused

- **A version that already exists.** A published version is never replaced
  or removed: a lockfile records its SHA-256, and builds that were pinned to
  it must keep working. Publish a new version instead.
- **A path dependency.** It names a directory on the machine that built it,
  which means nothing to anyone who downloads the package.
- **Anything executable.** There is no install script, no build script and
  no post-install hook, because that is the most reliably exploited part of
  every ecosystem that has one. A Halka package is source that gets compiled
  by the same `halka build` as everything else.
- **A package with no license or no description.**
- **An archive over 2 MiB or 500 files.** A package is source; anything
  larger is usually something swept in by accident.

An archive holds `halka.pkg`, `README`, `LICENSE`, `CHANGELOG` and `.hk`
files under `src/` — nothing else, because the list is what goes in rather
than what stays out. An ignore list gets this wrong the first time somebody
adds a directory nobody thought of, and the failure mode is a published
archive with a `.env` in it that cannot be taken back.

## Verifying a package yourself

```bash
curl -sO https://nulfied.github.io/halka/registry/pkg/csv/0.1.0.tar.gz
sha256sum 0.1.0.tar.gz     # must match index/csv.json
tar tzf 0.1.0.tar.gz       # ordinary tar; look at everything in it
```

Archives are written reproducibly — sorted entries, no timestamps, no owner,
fixed permissions — so rebuilding one from its source with
`halka pkg pack` should give you the same bytes, and therefore the same
hash, on any machine.

Every install checks the hash. A lockfile pins it, and a download that does
not match is refused rather than used.

## What is in it

| Package | Version | What it is |
|---|---|---|
| [csv](pkg/csv/) | 0.1.0 | Reading and writing comma-separated values (RFC 4180) |

Its source is in [`packages/csv`](https://github.com/Nulfied/halka/tree/main/packages/csv).
