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

export function compareVersions(current: string, latest: string | null): VersionStatusValue {
  if (!latest) return VersionStatus.UNKNOWN;

  const currentCoerced = coerceVersion(current);
  const latestCoerced = coerceVersion(latest);
  if (!currentCoerced || !latestCoerced) return VersionStatus.UNKNOWN;

  return semver.gte(currentCoerced, latestCoerced)
    ? VersionStatus.UP_TO_DATE
    : VersionStatus.OUTDATED;
}
