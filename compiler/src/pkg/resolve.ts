// Minimal Version Selection. spec/PACKAGES.md P3.
//
// The selected version of a package is the highest version any single
// requirement in the graph asks for — not the highest that exists. There is
// no backtracking, so resolution is a graph walk that cannot hang and gives
// the same answer on every machine.

import {
  type Req,
  type Version,
  compareVersions,
  formatReq,
  formatVersion,
  maxReq,
  reqsCompatible,
  satisfies,
} from "./semver.ts";

/** Where requirement information comes from. The registry implements this. */
export interface PackageSource {
  /** Every published version of a package, in any order. */
  versions(name: string): Version[] | null;
  /** What that version of that package itself requires. */
  requirements(name: string, version: Version): { name: string; req: Req }[] | null;
}

export interface RootRequirement {
  name: string;
  req: Req;
  /** For path dependencies, resolution is skipped and the path used as-is. */
  path?: string | null;
}

export interface Selection {
  name: string;
  version: Version;
}

export interface ResolveError {
  message: string;
}

export interface ResolveResult {
  selections: Selection[];
  errors: ResolveError[];
}

/** Who asked for a requirement, so a conflict can name both sides. */
interface Demand {
  req: Req;
  by: string;
}

export function resolve(roots: RootRequirement[], source: PackageSource): ResolveResult {
  const errors: ResolveError[] = [];
  /** The strongest requirement seen for each package so far. */
  const demands = new Map<string, Demand>();

  const require = (name: string, req: Req, by: string): boolean => {
    const existing = demands.get(name);
    if (!existing) {
      demands.set(name, { req, by });
      return true;
    }
    if (!reqsCompatible(existing.req, req)) {
      errors.push({
        message:
          `\`${name}\` is required at ${formatReq(existing.req)} by ${existing.by} ` +
          `and at ${formatReq(req)} by ${by}, and those cannot both be satisfied.\n` +
          `  Halka will not link two incompatible versions of one package into a binary.\n` +
          `  Raise whichever requirement is lower, or drop one of the two dependencies.`,
      });
      return false;
    }
    const winner = maxReq(existing.req, req);
    // Only re-walk when the requirement actually moved.
    if (formatReq(winner) === formatReq(existing.req)) return false;
    demands.set(name, { req: winner, by: winner === req ? by : existing.by });
    return true;
  };

  for (const r of roots) {
    if (r.path) continue; // a path dependency is used where it lies
    require(r.name, r.req, "this project");
  }

  /** The concrete version a demand selects: the lowest that satisfies it. */
  const select = (name: string, req: Req): Version | null => {
    const available = source.versions(name);
    if (available === null) {
      errors.push({ message: `no package named \`${name}\` was found in the registry` });
      return null;
    }
    // MVS picks the *minimum* version that satisfies, which is what makes a
    // new publish unable to change an existing build.
    const usable = available.filter((v) => satisfies(v, req)).sort(compareVersions);
    const chosen = usable[0];
    if (!chosen) {
      const known = available.length
        ? available.slice().sort(compareVersions).map(formatVersion).join(", ")
        : "none published";
      errors.push({
        message: `no version of \`${name}\` satisfies ${formatReq(req)}.\n  Published: ${known}`,
      });
      return null;
    }
    return chosen;
  };

  // Walk to a fixed point. Each pass can only raise requirements, and there
  // are finitely many versions, so this terminates.
  const selected = new Map<string, Version>();
  for (let pass = 0; ; pass++) {
    if (pass > 1000) {
      errors.push({ message: "dependency resolution did not settle — this is a compiler bug, please report it" });
      break;
    }
    let changed = false;
    for (const [name, demand] of [...demands]) {
      const version = select(name, demand.req);
      if (!version) { selected.delete(name); continue; }
      const prev = selected.get(name);
      if (prev && compareVersions(prev, version) === 0) continue;
      selected.set(name, version);
      changed = true;

      const reqs = source.requirements(name, version);
      if (reqs === null) {
        errors.push({ message: `the registry has no entry for \`${name}\` ${formatVersion(version)}` });
        continue;
      }
      for (const child of reqs) {
        if (require(child.name, child.req, `\`${name}\` ${formatVersion(version)}`)) changed = true;
      }
    }
    if (errors.length > 0) break;
    if (!changed) break;
  }

  const selections = [...selected]
    .map(([name, version]) => ({ name, version }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { selections, errors };
}
