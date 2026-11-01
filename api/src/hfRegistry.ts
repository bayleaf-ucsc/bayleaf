/**
 * HF artifact gateway registry (issue #121): the approved releases, bundled
 * from hfReleases.json, so approval is a reviewed commit plus an API deploy.
 *
 * Lookups are exact matches on (repo, revision or alias, path). No R2 key is
 * ever derived from caller input: a match yields a SHA-256 from the registry,
 * and the object key is built from that hash alone.
 */
import data from './hfReleases.json';

export interface HfFile {
  path: string;
  bytes: number;
  sha256: string;
  git_oid: string;
  lfs: boolean;
}

export interface HfRelease {
  repo: string;
  revision: string;
  aliases: string[];
  title: string;
  base_model?: string;
  task: string;
  library: string;
  architecture: string;
  formats: string[];
  variants: { name: string; files: string[] }[];
  license: { name: string; file: string; url: string };
  distribution: { basis: string; reviewed: string; decision: string };
  qualification: { client: string; runtime: string; status: string; evidence: string }[];
  files: HfFile[];
}

export const HF_RELEASES = (data as { releases: HfRelease[] }).releases;

/** R2 object key for an artifact: content-addressed, never caller-derived. */
export const blobKey = (sha256: string) => `sha256/${sha256}`;

/** Every distinct blob the registry approves, with one place it can be fetched from upstream. */
export function approvedBlobs(): { release: HfRelease; file: HfFile }[] {
  const seen = new Map<string, { release: HfRelease; file: HfFile }>();
  for (const release of HF_RELEASES) for (const file of release.files) {
    if (!seen.has(file.sha256)) seen.set(file.sha256, { release, file });
  }
  return [...seen.values()];
}

/** The release a (repo, revision-or-alias) names, or null. Aliases never follow upstream. */
export function findRelease(repo: string, revision: string): HfRelease | null {
  return HF_RELEASES.find((r) => r.repo === repo && (r.revision === revision || r.aliases.includes(revision))) ?? null;
}

export function findFile(release: HfRelease, path: string): HfFile | null {
  return release.files.find((f) => f.path === path) ?? null;
}

/**
 * Structural checks for the registry, run by the test suite rather than at
 * module load (a throw at load would take down the whole API). Returns the
 * problems found; an empty list means the registry is well formed.
 */
export function registryProblems(releases: HfRelease[] = HF_RELEASES): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const r of releases) {
    const id = `${r.repo}@${r.revision}`;
    if (!/^[\w.-]+\/[\w.-]+$/.test(r.repo)) problems.push(`${id}: repo must be namespace/name`);
    if (!/^[0-9a-f]{40}$/.test(r.revision)) problems.push(`${id}: revision must be a full commit hash`);
    for (const name of [r.revision, ...r.aliases]) {
      if (names.has(`${r.repo}@${name}`)) problems.push(`${id}: ${name} names more than one release`);
      names.add(`${r.repo}@${name}`);
    }
    const paths = new Set<string>();
    for (const f of r.files) {
      if (paths.has(f.path)) problems.push(`${id}: duplicate ${f.path}`);
      paths.add(f.path);
      if (!/^[0-9a-f]{64}$/.test(f.sha256)) problems.push(`${id}: ${f.path} needs a SHA-256`);
      if (!/^[0-9a-f]{40}$/.test(f.git_oid)) problems.push(`${id}: ${f.path} needs a git oid`);
      if (!Number.isSafeInteger(f.bytes) || f.bytes < 0) problems.push(`${id}: ${f.path} needs a size`);
      if (f.path.split('/').some((s) => !s || s === '.' || s === '..') || /[\\\0?#]/.test(f.path)) problems.push(`${id}: ${f.path} is not a plain path`);
    }
    if (!paths.has(r.license.file)) problems.push(`${id}: the license file must be served with the weights`);
    for (const v of r.variants) for (const p of v.files) if (!paths.has(p)) problems.push(`${id}: variant ${v.name} names unlisted ${p}`);
  }
  return problems;
}
