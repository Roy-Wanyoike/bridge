// scripts/package-release.mjs — build distributable CLI binaries.
//
// Uses `bun build --compile` to emit self-contained executables for every
// supported platform from the @bridge/ffi... er, @bridge/cli entry point.
// Output lands in dist/release/bridge-<version>-<os>-<arch>[.exe] plus a
// SHA-256 checksums file — the exact layout the release workflow and the
// Homebrew formula expect.
//
// Local usage:  bun scripts/package-release.mjs [--current-only]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'dist', 'release');
const ENTRY = join(ROOT, 'packages', 'bridge-cli', 'src', 'bin', 'bridge.ts');

const args = process.argv.slice(2);
const currentOnly = args.includes('--current-only');

const version = (() => {
  const env = process.env['BRIDGE_VERSION'];
  if (env !== undefined && env.length > 0) return env.replace(/^v/, '');
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return rootPkg.version ?? '0.0.0';
})();

const ALL_TARGETS = [
  { target: 'bun-linux-x64', os: 'linux', arch: 'amd64', ext: '' },
  { target: 'bun-linux-arm64', os: 'linux', arch: 'arm64', ext: '' },
  { target: 'bun-darwin-x64', os: 'darwin', arch: 'amd64', ext: '' },
  { target: 'bun-darwin-arm64', os: 'darwin', arch: 'arm64', ext: '' },
  { target: 'bun-windows-x64', os: 'windows', arch: 'amd64', ext: '.exe' },
];

function availableTargets() {
  if (!currentOnly) return ALL_TARGETS;
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const match = ALL_TARGETS.filter((t) => t.os === platform && (t.arch === arch || (platform === 'darwin' && arch === 'arm64' && t.arch === 'amd64')));
  return match.length > 0 ? match : [];
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const built = [];
for (const { target, os, arch, ext } of availableTargets()) {
  const name = `bridge-v${version}-${os}-${arch}${ext}`;
  const outPath = join(OUT, name);
  try {
    execFileSync('bun', ['build', '--compile', `--target=${target}`, '--minify', ENTRY, '--outfile', outPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    built.push({ name, path: outPath });
    console.log(`built ${name}`);
  } catch (err) {
    console.error(`skipping ${target}: ${(err.stderr ?? err.message ?? '').toString().split('\n')[0]}`);
  }
}

if (built.length === 0) {
  console.error('no binaries were built');
  process.exit(1);
}

// SHA-256 checksums — the file the release workflow uploads alongside the
// binaries and the Homebrew formula consumes.
const lines = built.map(({ name, path }) => {
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  return `${hash}  ${name}`;
});
writeFileSync(join(OUT, 'checksums-sha256.txt'), `${lines.join('\n')}\n`);
console.log(`checksums-sha256.txt written (${built.length} binaries, version v${version})`);
