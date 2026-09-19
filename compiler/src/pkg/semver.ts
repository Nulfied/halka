// Semantic versions and the two requirement forms Halka allows.
// spec/PACKAGES.md P2.

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty when this is a release. */
  pre: string[];
  /** Build metadata. Carried for display, ignored in comparisons. */
  build: string;
}

export interface Req {
  /** `caret` is the bare form, `exact` is the `=` form. */
  kind: "caret" | "exact";
  version: Version;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseVersion(s: string): Version | null {
  const m = VERSION_RE.exec(s.trim());
  if (!m) return null;
  // Leading zeroes make `1.01.0` and `1.1.0` two spellings of one version.
  for (const part of [m[1]!, m[2]!, m[3]!]) {
    if (part.length > 1 && part.startsWith("0")) return null;
  }
  const pre = m[4] ? m[4].split(".") : [];
  // An empty or leading-zero numeric prerelease identifier is ill-formed.
  for (const id of pre) {
    if (id === "") return null;
    if (/^\d+$/.test(id) && id.length > 1 && id.startsWith("0")) return null;
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre,
    build: m[5] ?? "",
  };
}

export function formatVersion(v: Version): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  const pre = v.pre.length ? `-${v.pre.join(".")}` : "";
  const build = v.build ? `+${v.build}` : "";
  return base + pre + build;
}

/** Semver 2.0.0 precedence. Build metadata takes no part in it. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  // A prerelease sorts before the release it precedes; 1.0.0-rc < 1.0.0.
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;

  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    // A shorter run of identifiers sorts first when all else is equal.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (x !== y) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers rank below alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function versionsEqual(a: Version, b: Version): boolean {
  return compareVersions(a, b) === 0;
}

export function parseReq(s: string): Req | null {
  const t = s.trim();
  if (t.startsWith("=")) {
    const v = parseVersion(t.slice(1));
    return v ? { kind: "exact", version: v } : null;
  }
  const v = parseVersion(t);
  return v ? { kind: "caret", version: v } : null;
}

export function formatReq(r: Req): string {
  return (r.kind === "exact" ? "=" : "") + formatVersion(r.version);
}

/**
 * The first version a caret requirement does *not* admit. Below 1.0 the minor
 * is treated as the compatibility boundary, and below 0.1 nothing but the
 * exact version is compatible — the usual reading of an unstable package.
 */
export function upperBound(v: Version): Version {
  const at = (major: number, minor: number, patch: number): Version =>
    ({ major, minor, patch, pre: [], build: "" });
  if (v.major > 0) return at(v.major + 1, 0, 0);
  if (v.minor > 0) return at(0, v.minor + 1, 0);
  return at(0, 0, v.patch + 1);
}

export function satisfies(v: Version, r: Req): boolean {
  if (r.kind === "exact") return versionsEqual(v, r.version);
  if (compareVersions(v, r.version) < 0) return false;
  // A prerelease is only ever admitted when the requirement asks for one of
  // the same version; `1.2.0` must not quietly select `1.3.0-rc1`.
  if (v.pre.length > 0) {
    const sameTriple =
      v.major === r.version.major && v.minor === r.version.minor && v.patch === r.version.patch;
    if (!sameTriple || r.version.pre.length === 0) return false;
  }
  return compareVersions(v, upperBound(r.version)) < 0;
}

/** Do two requirements admit any version in common? (P3's conflict test.) */
export function reqsCompatible(a: Req, b: Req): boolean {
  if (a.kind === "exact" && b.kind === "exact") return versionsEqual(a.version, b.version);
  if (a.kind === "exact") return satisfies(a.version, b);
  if (b.kind === "exact") return satisfies(b.version, a);
  // Two carets overlap exactly when they share an upper bound, which for the
  // caret rule is the same as sharing a compatibility class.
  return versionsEqual(upperBound(a.version), upperBound(b.version));
}

/** The stricter of two compatible requirements — MVS's "highest wins". */
export function maxReq(a: Req, b: Req): Req {
  if (a.kind === "exact") return a;
  if (b.kind === "exact") return b;
  return compareVersions(a.version, b.version) >= 0 ? a : b;
}
