import { describe, expect, it } from 'vitest';
import { VersionStatus } from '@chart-monitor/shared';
import { compareVersions, findLatestVersion, isSureUpgrade } from '../helm/versionCompare.js';

describe('findLatestVersion', () => {
  it('picks the highest semver version', () => {
    expect(findLatestVersion(['1.2.0', '1.10.0', '1.9.9'])).toBe('1.10.0');
  });

  it('ignores non-semver values and returns null if none are valid', () => {
    expect(findLatestVersion(['latest', 'stable'])).toBeNull();
  });

  it('rejects registry tags that merely contain digits but are not real versions', () => {
    expect(
      findLatestVersion([
        'v1.2.3',
        'fix-20407',
        'sha256-abcd1234.sig',
        'master-ef362765',
        'v20231226-1a7112e06',
        '87154df',
      ]),
    ).toBe('v1.2.3');
  });

  it('filters out pre-releases by default', () => {
    expect(findLatestVersion(['1.19.5', '1.20.4', '1.21.0-pre.4'])).toBe('1.20.4');
  });

  it('includes pre-releases when requested', () => {
    expect(findLatestVersion(['1.19.5', '1.20.4', '1.21.0-pre.4'], true)).toBe('1.21.0-pre.4');
  });

  it('falls back to pre-release if no stable versions exist', () => {
    expect(findLatestVersion(['0.1.0-alpha', '0.1.0-beta.2'])).toBe('0.1.0-beta.2');
  });
});

describe('compareVersions', () => {
  it('is unknown when there is no latest to compare against', () => {
    expect(compareVersions('1.0.0', null)).toBe(VersionStatus.UNKNOWN);
  });

  it('is up_to_date when current is the latest', () => {
    expect(compareVersions('2.0.0', '2.0.0')).toBe(VersionStatus.UP_TO_DATE);
  });

  it('is outdated when a newer version exists', () => {
    expect(compareVersions('1.0.0', '1.1.0')).toBe(VersionStatus.OUTDATED);
  });
});

describe('isSureUpgrade', () => {
  it('accepts the same variant, rejects other variants and pre-releases', () => {
    expect(isSureUpgrade('v2.15.4', 'v2.16.0')).toBe(true);
    expect(isSureUpgrade('13.3.0-distroless', '13.3.1-distroless')).toBe(true);
    expect(isSureUpgrade('13.3.0-distroless', '13.3.1')).toBe(false);
    expect(isSureUpgrade('8.2.3-alpine', '8.12-rc2')).toBe(false);
    expect(isSureUpgrade('1.2.0', '1.3.0-rc.1')).toBe(false);
    expect(isSureUpgrade('v1.39.5-1792733054-8c73b28', 'v1.40-2b268f0')).toBe(false);
    expect(isSureUpgrade('latest', '7.2')).toBe(false);
  });
});
