import semver from 'semver';
import { VersionStatus, type VersionStatusValue } from '@chart-monitor/shared';

const LOOKS_LIKE_VERSION = /^v?\d+\.\d+(\.\d+)?/;

function coerceVersion(value: string): semver.SemVer | null {
  return LOOKS_LIKE_VERSION.test(value) ? semver.coerce(value) : null;
}

function isGreaterThan(a: string, b: string): boolean {
  const ca = coerceVersion(a);
  const cb = coerceVersion(b);
  if (!ca || !cb) return false;
  const diff = semver.compare(ca, cb);
  if (diff !== 0) return diff > 0;
  if (semver.valid(a) && semver.valid(b)) {
    return semver.gt(a, b);
  }
  return false;
}

const VERSION_CORE = /^v?\d+(\.\d+)*/;
const PRERELEASE_WORDS = /^(alpha|beta|rc|pre|preview|dev|snapshot|nightly|canary|edge)$/;

/** What a tag adds after its numbers, split in parts: `13.3.0-distroless` → [distroless] */
const suffixParts = (tag: string) =>
  tag
    .replace(VERSION_CORE, '')
    .toLowerCase()
    .split(/[-_.+]/)
    .filter(Boolean);

/** `rc2`, `beta.1`, `-dev`… after the version, whether or not the rest is valid semver */
const hasPrereleaseWord = (tag: string) =>
  suffixParts(tag).some((part) => PRERELEASE_WORDS.test(part.replace(/\d+$/, '')));

/** Charts are semver, where any `-suffix` is a pre-release; the words also catch versions that
 * aren't valid semver (`8.12-rc2`) */
const isChartPrerelease = (version: string) =>
  hasPrereleaseWord(version) ||
  (semver.valid(version) !== null && semver.prerelease(version) !== null);

/** The variant a tag names, without what changes per build or base version: `-alpine3.20` →
 * alpine, `-debian-12-slim` → debian-slim, `-1792733054-8c73b28` (a build) → '' */
export function variantOf(tag: string): string {
  return suffixParts(tag)
    .filter((part) => !/^[0-9a-f]{7,}$/.test(part)) // commit hashes
    .map((part) => part.replace(/\d+$/, ''))
    .filter((part) => /^[a-z]+$/.test(part) && !PRERELEASE_WORDS.test(part))
    .join('-');
}

const newest = (versions: string[]) =>
  versions.reduce((latest, v) => (isGreaterThan(v, latest) ? v : latest));

/** The newest chart version, pre-releases skipped unless asked (or unless there's nothing else) */
export function findLatestVersion(versions: string[], includePrereleases = false): string | null {
  const valid = versions.filter((v) => coerceVersion(v));
  if (valid.length === 0) return null;
  const stable = includePrereleases ? [] : valid.filter((v) => !isChartPrerelease(v));
  return newest(stable.length > 0 ? stable : valid);
}

/** The newest image tag of the same variant as `currentTag` (an -alpine image gets an -alpine
 * tag), never a pre-release unless asked. Semver would call `-alpine` a pre-release, so only
 * pre-release words count. A current tag without a version (`latest`) compares with every tag. */
export function findLatestImageTag(
  tags: string[],
  currentTag: string,
  includePrereleases = false,
): string | null {
  const variant = VERSION_CORE.test(currentTag) ? variantOf(currentTag) : null;
  const candidates = tags.filter(
    (tag) =>
      coerceVersion(tag) &&
      (variant === null || variantOf(tag) === variant) &&
      (includePrereleases || !hasPrereleaseWord(tag)),
  );
  return candidates.length > 0 ? newest(candidates) : null;
}

/** Versions after `current` up to and including `latest`, newest first, skipping pre-releases
 * unless asked (like findLatestVersion) */
export function versionsBetween(
  versions: string[],
  current: string,
  latest: string,
  includePrereleases = false,
): string[] {
  return versions
    .filter((v) => coerceVersion(v) && (includePrereleases || !isChartPrerelease(v)))
    .filter((v) => isGreaterThan(v, current) && !isGreaterThan(v, latest))
    .sort((a, b) => (isGreaterThan(a, b) ? -1 : isGreaterThan(b, a) ? 1 : 0));
}

export function compareVersions(current: string, latest: string | null): VersionStatusValue {
  if (!latest) return VersionStatus.UNKNOWN;

  const currentCoerced = coerceVersion(current);
  const latestCoerced = coerceVersion(latest);
  if (!currentCoerced || !latestCoerced) return VersionStatus.UNKNOWN;

  return semver.gte(currentCoerced, latestCoerced)
    ? VersionStatus.UP_TO_DATE
    : VersionStatus.OUTDATED;
}

/** The newer tag is surely the same image, just newer: same variant (see variantOf) and not a
 * pre-release, so its vulnerabilities are worth comparing */
export function isSureUpgrade(currentTag: string, latestTag: string): boolean {
  return (
    VERSION_CORE.test(currentTag) &&
    variantOf(latestTag) === variantOf(currentTag) &&
    !hasPrereleaseWord(latestTag)
  );
}
