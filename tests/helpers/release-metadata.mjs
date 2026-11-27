// Todo #112: the one statement of "the release metadata is consistent". Tests of a past release call
// assertReleaseMetadata() instead of comparing the version to the number it had when they were written
// (`major === 0 && minor === 9` turned red on 0.10.0 although nothing was wrong).
//
// The places that must carry the same version:
//   1. package.json            version
//   2. plugin.json             version
//   3. package-lock.json       version
//   4. package-lock.json       packages[""].version
//   5. contracts/plugin.json   description mentions `v<version> `
//   +  VERSION (repository root), only when that file exists
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

// MAJOR.MINOR.PATCH with an optional pre-release tag; no leading zeros, no build metadata.
export const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/

const root = new URL('../../', import.meta.url)
const read = rel => readFileSync(new URL(rel, root), 'utf8')

/** Reads the version of every place from the repository. */
export function readReleaseMetadata() {
  const lock = JSON.parse(read('package-lock.json'))
  const versionFile = new URL('VERSION', root)
  return {
    package: JSON.parse(read('package.json')).version,
    plugin: JSON.parse(read('plugin.json')).version,
    lock: lock.version,
    lockRootPackage: lock.packages?.['']?.version,
    contractDescription: JSON.parse(read('contracts/plugin.json')).description,
    ...(existsSync(versionFile) ? { versionFile: readFileSync(versionFile, 'utf8').trim() } : {}),
  }
}

/** Throws unless the version is well formed and every place agrees with package.json. Returns the version. */
export function checkReleaseMetadata(meta) {
  const version = meta.package
  assert.equal(typeof version, 'string', 'package.json has a version')
  assert.match(version, RELEASE_VERSION_PATTERN, `package.json version "${version}" is MAJOR.MINOR.PATCH`)
  assert.equal(meta.plugin, version, 'plugin.json version equals package.json')
  assert.equal(meta.lock, version, 'package-lock.json version equals package.json')
  assert.equal(meta.lockRootPackage, version, 'package-lock.json packages[""].version equals package.json')
  assert.ok(String(meta.contractDescription || '').includes(`v${version} `), `contracts/plugin.json description mentions v${version}`)
  if ('versionFile' in meta) assert.equal(meta.versionFile, version, 'VERSION file equals package.json')
  return version
}

export function assertReleaseMetadata() {
  return checkReleaseMetadata(readReleaseMetadata())
}
