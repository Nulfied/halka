// `halka.lock`. spec/PACKAGES.md P4.
//
// The lockfile records exactly which version of each package was used and the
// SHA-256 of the archive it came from. A build with a lockfile verifies every
// archive against it, which is what makes an edited or compromised registry a
// build failure rather than a supply-chain compromise.

import { type Version, formatVersion, parseVersion } from "./semver.ts";

export const LOCK_FORMAT = 1;

export interface LockEntry {
  name: string;
  version: Version;
  source: "registry" | "path";
  /** Empty for a path dependency, which has no archive to hash. */
  sha256: string;
  /** Set for a path dependency. */
  path: string;
}

export interface Lockfile {
  format: number;
  entries: LockEntry[];
}

export interface LockError { line: number; message: string }

const SHA256_RE = /^[0-9a-f]{64}$/;

export function parseLock(src: string, _file: string): { lock: Lockfile | null; errors: LockError[] } {
  const errors: LockError[] = [];
  const entries: LockEntry[] = [];
  let format = 0;

  let section: string | null = null;
  let fields = new Map<string, { value: string; line: number }>();

  const flush = (): void => {
    if (section === null) return;
    if (section === "lock") {
      const v = fields.get("version");
      format = v ? Number(v.value) : 0;
      if (!Number.isInteger(format) || format < 1) {
        errors.push({ line: v?.line ?? 1, message: "the lockfile header needs `version: 1`" });
      }
      section = null;
      fields = new Map();
      return;
    }
    const verField = fields.get("version");
    const version = verField ? parseVersion(verField.value) : null;
    if (!version) {
      errors.push({ line: verField?.line ?? 1, message: `\`${section}\` has no usable \`version\`` });
    }
    const srcField = fields.get("source");
    const kind = srcField?.value;
    if (kind !== "registry" && kind !== "path") {
      errors.push({ line: srcField?.line ?? 1, message: `\`${section}\` needs \`source: registry\` or \`source: path\`` });
    }
    const shaField = fields.get("sha256");
    const sha = shaField?.value ?? "";
    if (kind === "registry" && !SHA256_RE.test(sha)) {
      errors.push({ line: shaField?.line ?? 1, message: `\`${section}\` needs a 64-character lowercase hex \`sha256\`` });
    }
    if (version && (kind === "registry" || kind === "path")) {
      entries.push({ name: section, version, source: kind, sha256: sha, path: fields.get("path")?.value ?? "" });
    }
    section = null;
    fields = new Map();
  };

  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      flush();
      const m = /^([a-z][a-z0-9-]*)\s*:\s*$/.exec(trimmed);
      if (!m) { errors.push({ line, message: `expected a section, found \`${trimmed}\`` }); continue; }
      section = m[1]!;
      continue;
    }
    if (section === null) { errors.push({ line, message: `\`${trimmed}\` is not inside a section` }); continue; }
    const body = trimmed.replace(/\s*,\s*$/, "");
    const at = body.indexOf(":");
    if (at < 0) { errors.push({ line, message: `expected \`key: value\`, found \`${trimmed}\`` }); continue; }
    fields.set(body.slice(0, at).trim(), { value: body.slice(at + 1).trim(), line });
  }
  flush();

  if (format < 1) {
    errors.push({ line: 1, message: "the lockfile is missing its `lock:` header" });
  } else if (format > LOCK_FORMAT) {
    errors.push({
      line: 1,
      message: `this lockfile was written by a newer Halka (format ${format}, this toolchain understands ${LOCK_FORMAT})`,
    });
  }

  if (errors.length > 0) return { lock: null, errors };
  return { lock: { format, entries }, errors };
}

export function formatLock(lock: Lockfile): string {
  const out: string[] = [
    "# Written by `halka`. Commit this file.",
    "# It records exactly which package archives this project was built against.",
    "",
    "lock:",
    `    version: ${lock.format}`,
    "",
  ];
  const sorted = [...lock.entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) {
    const fields = [`    version: ${formatVersion(e.version)}`, `    source: ${e.source}`];
    if (e.source === "path") fields.push(`    path: ${e.path}`);
    else fields.push(`    sha256: ${e.sha256}`);
    out.push(`${e.name}:`, fields.join(",\n"), "");
  }
  return out.join("\n").replace(/\n+$/, "\n");
}
