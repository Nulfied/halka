// The `halka.pkg` manifest. spec/PACKAGES.md P1.
//
// A manifest is data. It has no expressions, no conditionals and no includes,
// so reading one cannot execute anything. That is deliberate: `halka add`
// must never run code from a package it has not compiled yet.

import { type Req, parseReq, formatReq } from "./semver.ts";
import { type Version, parseVersion, formatVersion } from "./semver.ts";

export interface Dependency {
  name: string;
  /** A registry dependency carries a requirement; a path dependency does not. */
  req: Req | null;
  /** Set for `path ../somewhere` dependencies, relative to the manifest. */
  path: string | null;
  dev: boolean;
}

export interface Manifest {
  name: string;
  version: Version;
  license: string;
  description: string;
  deps: Dependency[];
  /** Where this manifest was read from, for diagnostics and path resolution. */
  file: string;
}

export interface ManifestError {
  line: number;
  message: string;
}

export interface ParseResult {
  manifest: Manifest | null;
  errors: ManifestError[];
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const KNOWN_SECTIONS = new Set(["package", "deps", "dev-deps"]);
const KNOWN_PACKAGE_KEYS = new Set(["name", "version", "license", "description"]);

interface Entry { key: string; value: string; line: number }

/**
 * Split the file into sections of key/value entries. The shape is fixed
 * enough that this is a scan rather than a parser: a line at column 0 opens a
 * section, an indented line is an entry in it.
 */
function scan(src: string, errors: ManifestError[]): Map<string, Entry[]> {
  const sections = new Map<string, Entry[]>();
  let current: Entry[] | null = null;

  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indented = /^\s/.test(raw);
    if (!indented) {
      const m = /^([a-z][a-z0-9-]*)\s*:\s*$/.exec(trimmed);
      if (!m) {
        errors.push({ line, message: `expected a section like \`package:\`, found \`${trimmed}\`` });
        current = null;
        continue;
      }
      const name = m[1]!;
      if (!KNOWN_SECTIONS.has(name)) {
        // A silently ignored section is how a dependency quietly fails to
        // install, so an unknown one is an error.
        errors.push({
          line,
          message: `unknown section \`${name}\` — expected ${[...KNOWN_SECTIONS].map((s) => `\`${s}\``).join(", ")}`,
        });
        current = null;
        continue;
      }
      if (sections.has(name)) {
        errors.push({ line, message: `section \`${name}\` appears twice` });
      }
      current = [];
      sections.set(name, current);
      continue;
    }

    if (!current) {
      errors.push({ line, message: `\`${trimmed}\` is not inside a section` });
      continue;
    }

    // A trailing comma separates entries (V49 #2); the last one may omit it.
    const body = trimmed.replace(/\s*,\s*$/, "");
    const at = body.indexOf(":");
    if (at < 0) {
      errors.push({ line, message: `expected \`key: value\`, found \`${trimmed}\`` });
      continue;
    }
    const key = body.slice(0, at).trim();
    let value = body.slice(at + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key === "") {
      errors.push({ line, message: "an entry needs a key before the `:`" });
      continue;
    }
    current.push({ key, value, line });
  }
  return sections;
}

function readDeps(entries: Entry[], dev: boolean, errors: ManifestError[]): Dependency[] {
  const out: Dependency[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!NAME_RE.test(e.key)) {
      errors.push({ line: e.line, message: `\`${e.key}\` is not a valid package name (lowercase letters, digits and \`-\`)` });
      continue;
    }
    if (seen.has(e.key)) {
      errors.push({ line: e.line, message: `\`${e.key}\` is listed twice` });
      continue;
    }
    seen.add(e.key);

    const pathMatch = /^path\s+(.+)$/.exec(e.value);
    if (pathMatch) {
      out.push({ name: e.key, req: null, path: pathMatch[1]!.trim(), dev });
      continue;
    }
    const req = parseReq(e.value);
    if (!req) {
      errors.push({
        line: e.line,
        message: `\`${e.value}\` is not a version requirement — write \`1.2.0\`, \`=1.2.0\` or \`path ../somewhere\``,
      });
      continue;
    }
    out.push({ name: e.key, req, path: null, dev });
  }
  return out;
}

export function parseManifest(src: string, file: string): ParseResult {
  const errors: ManifestError[] = [];
  const sections = scan(src, errors);

  const pkg = sections.get("package");
  if (!pkg) {
    errors.push({ line: 1, message: "a manifest needs a `package:` section with at least a name and a version" });
    return { manifest: null, errors };
  }

  const field = (key: string): Entry | undefined => pkg.find((e) => e.key === key);
  for (const e of pkg) {
    if (!KNOWN_PACKAGE_KEYS.has(e.key)) {
      errors.push({
        line: e.line,
        message: `unknown key \`${e.key}\` in \`package:\` — expected ${[...KNOWN_PACKAGE_KEYS].map((s) => `\`${s}\``).join(", ")}`,
      });
    }
  }

  const nameEntry = field("name");
  if (!nameEntry) errors.push({ line: 1, message: "`package:` needs a `name`" });
  else if (!NAME_RE.test(nameEntry.value)) {
    errors.push({
      line: nameEntry.line,
      message: `\`${nameEntry.value}\` is not a valid package name (lowercase letters, digits and \`-\`, starting with a letter)`,
    });
  }

  const versionEntry = field("version");
  let version: Version | null = null;
  if (!versionEntry) errors.push({ line: 1, message: "`package:` needs a `version`" });
  else {
    version = parseVersion(versionEntry.value);
    if (!version) {
      errors.push({ line: versionEntry.line, message: `\`${versionEntry.value}\` is not a version — expected something like \`0.1.0\`` });
    }
  }

  const deps = [
    ...readDeps(sections.get("deps") ?? [], false, errors),
    ...readDeps(sections.get("dev-deps") ?? [], true, errors),
  ];

  // A package that depends on itself has no fixed point to resolve to.
  if (nameEntry) {
    for (const d of deps) {
      if (d.name === nameEntry.value) {
        errors.push({ line: 1, message: `\`${d.name}\` cannot depend on itself` });
      }
    }
  }
  const across = new Map<string, boolean>();
  for (const d of deps) {
    if (across.has(d.name) && across.get(d.name) !== d.dev) {
      errors.push({ line: 1, message: `\`${d.name}\` is in both \`deps:\` and \`dev-deps:\` — it belongs in one` });
    }
    across.set(d.name, d.dev);
  }

  if (errors.length > 0 || !nameEntry || !version) return { manifest: null, errors };

  return {
    manifest: {
      name: nameEntry.value,
      version,
      license: field("license")?.value ?? "",
      description: field("description")?.value ?? "",
      deps,
      file,
    },
    errors,
  };
}

/** Render a manifest back out, in the canonical shape `halka init` writes. */
export function formatManifest(m: Manifest): string {
  const out: string[] = [];
  const pkg: string[] = [`    name: ${m.name}`, `    version: ${formatVersion(m.version)}`];
  if (m.license) pkg.push(`    license: ${m.license}`);
  if (m.description) pkg.push(`    description: ${m.description}`);
  out.push("package:", pkg.join(",\n"), "");

  const section = (title: string, deps: Dependency[]) => {
    if (deps.length === 0) return;
    const lines = [...deps]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((d) => `    ${d.name}: ${d.path !== null ? `path ${d.path}` : formatReq(d.req!)}`);
    out.push(`${title}:`, lines.join(",\n"), "");
  };
  section("deps", m.deps.filter((d) => !d.dev));
  section("dev-deps", m.deps.filter((d) => d.dev));

  return out.join("\n").replace(/\n+$/, "\n");
}
