import semver from 'semver';
import { VersionStatus, type VersionStatusValue } from '@chart-monitor/shared';

const LOOKS_LIKE_VERSION = /^v?\d+\.\d+(\.\d+)?/;

function coerceVersion(value: string): semver.SemVer | null {
  return LOOKS_LIKE_VERSION.test(value) ? semver.coerce(value) : null;
}

export function findLatestVersion(versions: string[]): string | null {
  const valid = versions.filter((v) => coerceVersion(v));
  if (valid.length === 0) return null;
  return valid.reduce((latest, v) => (semver.gt(coerceVersion(v)!, coerceVersion(latest)!) ? v : latest));
}

export function compareVersions(current: string, latest: string | null): VersionStatusValue {
  if (!latest) return VersionStatus.UNKNOWN;

  const currentCoerced = coerceVersion(current);
  const latestCoerced = coerceVersion(latest);
  if (!currentCoerced || !latestCoerced) return VersionStatus.UNKNOWN;

  return semver.gte(currentCoerced, latestCoerced) ? VersionStatus.UP_TO_DATE : VersionStatus.OUTDATED;
}
