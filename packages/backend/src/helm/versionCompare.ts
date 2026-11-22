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

export function findLatestVersion(versions: string[], includePrereleases = false): string | null {
  const valid = versions.filter((v) => coerceVersion(v));
  if (valid.length === 0) return null;

  if (!includePrereleases) {
    // semver.prerelease(v) returns non-empty array for prereleases (e.g. 1.21.0-pre.4), or null for stable
    const stable = valid.filter((v) => semver.prerelease(v) === null);
    if (stable.length > 0) {
      return stable.reduce((latest, v) => (isGreaterThan(v, latest) ? v : latest));
    }
  }

  return valid.reduce((latest, v) => (isGreaterThan(v, latest) ? v : latest));
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
    .filter((v) => coerceVersion(v) && (includePrereleases || semver.prerelease(v) === null))
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

// Everything after the version: `13.3.0-distroless` → `distroless`, `v2.16.0` → ''
const variantOf = (tag: string) => tag.replace(/^v?\d+(\.\d+)*/, '').replace(/^[-+_.]/, '');
const PRERELEASE = /(^|[-.])(alpha|beta|rc|pre|preview|dev|snapshot|nightly)\d*([-.]|$)/i;

/** The newer tag is surely the same image, just newer: same variant suffix (distroless, alpine…,
 * or none on both) and not a pre-release. Anything else is left alone until variants are told
 * apart properly. */
export function isSureUpgrade(currentTag: string, latestTag: string): boolean {
  const variant = variantOf(latestTag);
  return variant === variantOf(currentTag) && !PRERELEASE.test(variant);
}
