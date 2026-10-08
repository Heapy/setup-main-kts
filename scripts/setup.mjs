import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

export const digest = value => createHash('sha256').update(value).digest('hex');

export function boolean(value, name) {
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
  return value === 'true';
}

export function cacheReadOnly(value, event) {
  if (value === 'auto') return !['push', 'workflow_dispatch', 'schedule'].includes(event);
  return boolean(value, 'cache-read-only');
}

export function versionInfo(version) {
  if (!/^\d+\.\d+\.\d+(?:-(?:RC|Beta|M)\d*)?$/.test(version)) {
    throw new Error('kotlin-version must be an exact release, for example 2.4.20');
  }
  const filename = `kotlin-compiler-${version}.zip`;
  return { filename, url: `https://github.com/JetBrains/kotlin/releases/download/v${version}/${filename}` };
}

export function parseChecksum(text) {
  const match = text.trim().match(/^([a-fA-F0-9]{64})(?:[ \t]+\*?[^\r\n]+)?$/);
  if (!match) throw new Error('Expected a SHA-256 checksum');
  return match[1].toLowerCase();
}

function singleLine(value, name) {
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`${name} must be a non-empty single line`);
  return value;
}

export function cacheKeys({ os, arch, version, checksum, java, workspace, maven, scriptsHash, options = '', suffix = '' }) {
  const platform = `${os}-${arch}`;
  const salt = digest(suffix).slice(0, 16);
  const compiler = `main-kts-v1-compiler-${platform}-${version}-${checksum}-${salt}`;
  const dependenciesPrefix = `main-kts-v1-deps-${platform}-${version}-${salt}-`;
  const compiled = `main-kts-v1-compiled-${platform}-${version}-${digest(JSON.stringify({
    checksum, java, workspace, maven, scriptsHash, options, suffix,
  }))}`;
  return { compiler, dependenciesPrefix, dependencies: `${dependenciesPrefix}${scriptsHash || 'no-scripts'}`, compiled };
}

export async function commandFile(file, values) {
  if (!file) throw new Error('Missing GitHub command file');
  for (const [key, value] of Object.entries(values)) {
    const delimiter = `main_kts_${randomUUID()}`;
    await appendFile(file, `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
  }
}

async function response(url, fetchImpl = fetch) {
  const result = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  if (!result.ok) throw new Error(`Download failed: HTTP ${result.status} for ${url}`);
  return result;
}

export async function prepare(env = process.env, fetchImpl = fetch) {
  const version = env.INPUT_KOTLIN_VERSION ?? '2.4.20';
  const release = versionInfo(version);
  const enabled = boolean(env.INPUT_CACHE ?? 'true', 'cache');
  const dependencies = boolean(env.INPUT_CACHE_DEPENDENCIES ?? 'true', 'cache-dependencies');
  const compiled = boolean(env.INPUT_CACHE_COMPILED_SCRIPTS ?? 'true', 'cache-compiled-scripts');
  const toolchain = boolean(env.INPUT_TOOLCHAIN_JAVA_HOME ?? 'false', 'toolchain-java-home');
  const readOnly = cacheReadOnly(env.INPUT_CACHE_READ_ONLY ?? 'auto', env.GITHUB_EVENT_NAME);
  const scriptsHash = env.INPUT_SCRIPTS_HASH ?? '';
  if (scriptsHash && !/^[a-f0-9]{64}$/.test(scriptsHash)) throw new Error('Invalid script hash');
  const javaHome = singleLine(env.JAVA_HOME, 'JAVA_HOME');
  const javaRelease = await readFile(path.join(javaHome, 'release'), 'utf8');
  const workspace = path.resolve(singleLine(env.GITHUB_WORKSPACE, 'GITHUB_WORKSPACE'));
  const root = path.join(singleLine(env.RUNNER_TEMP, 'RUNNER_TEMP'), 'setup-main-kts');
  const maven = path.join(homedir(), '.m2', 'repository');
  console.log(`Preparing Kotlin ${version}`);
  const checksum = parseChecksum(env.INPUT_KOTLIN_SHA256 || await (await response(`${release.url}.sha256`, fetchImpl)).text());
  const keys = cacheKeys({ os: env.RUNNER_OS, arch: env.RUNNER_ARCH, version, checksum,
    java: { home: javaHome, release: javaRelease }, workspace: { workspace, root }, maven, scriptsHash,
    options: env.INPUT_CACHE_COMPILER_OPTIONS ?? '', suffix: env.INPUT_CACHE_KEY_SUFFIX ?? '' });
  await mkdir(root, { recursive: true });
  const invocation = await mkdtemp(path.join(root, 'run-'));
  const archiveDir = path.join(root, 'archives', `${version}-${checksum}`);
  // Cache paths must be stable: actions/cache includes them in its cache version.
  // Clear only our own compiled directory before restore on persistent runners.
  const compiledDir = path.join(root, 'compiled', digest(keys.compiled));
  await rm(compiledDir, { recursive: true, force: true });
  await mkdir(compiledDir, { recursive: true });
  await mkdir(archiveDir, { recursive: true });
  const distributionDir = path.join(root, 'distributions', `${version}-${checksum}`);
  const config = { version, ...release, checksum, archiveDir, distributionDir, invocation, compiledDir, javaHome, toolchain };
  const configFile = path.join(invocation, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  if (enabled && compiled && !scriptsHash) {
    console.log('::warning::No files matched cache-dependency-path. Cross-job compiled-script caching is disabled. Run checkout before setup.');
  }
  await commandFile(env.GITHUB_OUTPUT, {
    config: configFile, 'kotlin-version': version, 'cache-enabled': enabled,
    'dependencies-enabled': enabled && dependencies, 'compiled-enabled': enabled && compiled && Boolean(scriptsHash),
    'cache-read-only': readOnly, 'compiler-path': path.join(archiveDir, release.filename),
    'compiler-key': keys.compiler, 'dependencies-path': maven, 'dependencies-key': keys.dependencies,
    'dependencies-prefix': keys.dependenciesPrefix, 'compiled-path': compiledDir, 'compiled-key': keys.compiled,
  });
  return config;
}

export async function verifyArchive(file, checksum) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== checksum) throw new Error('Kotlin compiler SHA-256 mismatch');
}

export async function ensureArchive(config, fetchImpl = fetch) {
  const archive = path.join(config.archiveDir, config.filename);
  let exists = true;
  try { await stat(archive); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
  if (!exists) {
    console.log(`Downloading ${config.filename}`);
    const temporary = `${archive}.${randomUUID()}.tmp`;
    try {
      const result = await response(config.url, fetchImpl);
      await pipeline(result.body, createWriteStream(temporary, { flags: 'wx' }));
      await verifyArchive(temporary, config.checksum);
      await rename(temporary, archive);
    } finally { await rm(temporary, { force: true }); }
  }
  // Verify restored archives too. Never execute files directly from a restored tool cache.
  await verifyArchive(archive, config.checksum);
  console.log(`Verified ${config.filename} (SHA-256)`);
  return archive;
}

export async function install(config, env = process.env) {
  const archive = await ensureArchive(config);
  const destination = config.distributionDir;
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:MAIN_KTS_ARCHIVE -DestinationPath $env:MAIN_KTS_DESTINATION'],
    { env: { ...env, MAIN_KTS_ARCHIVE: archive, MAIN_KTS_DESTINATION: destination }, stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', archive, '-d', destination], { stdio: 'inherit' });
  }
  const kotlinHome = path.join(destination, 'kotlinc');
  const bin = path.join(kotlinHome, 'bin');
  await stat(path.join(kotlinHome, 'lib', 'kotlin-main-kts.jar'));
  // Provide a stable kotlinr entry point even for releases before the runner rename.
  for (const [name, content] of [
    ['kotlinr', '#!/bin/sh\nexec "$(dirname "$0")/kotlin" "$@"\n'],
    ['kotlinr.bat', '@echo off\r\ncall "%~dp0kotlin.bat" %*\r\n'],
  ]) {
    const runner = path.join(bin, name);
    try { await stat(runner); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(runner, content);
    }
  }
  if (process.platform !== 'win32') {
    await chmod(path.join(bin, 'kotlinr'), 0o755);
    await chmod(path.join(bin, 'kotlin'), 0o755);
    await chmod(path.join(bin, 'kotlinc'), 0o755);
  }
  const variables = { KOTLIN_HOME: kotlinHome, KOTLIN_MAIN_KTS_COMPILED_SCRIPTS_CACHE_DIR: config.compiledDir };
  if (config.toolchain) variables.KOTLIN_CLI_JAVA_HOME = config.javaHome;
  await commandFile(env.GITHUB_ENV, variables);
  await appendFile(env.GITHUB_PATH, `${singleLine(bin, 'Kotlin bin path')}\n`);
  await commandFile(env.GITHUB_OUTPUT, { 'kotlin-home': kotlinHome, 'java-home': config.javaHome,
    'compiled-cache-path': config.compiledDir });
  // Use the selected Java directly; no shell interpolation of action inputs.
  execFileSync(path.join(config.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
    ['-cp', path.join(kotlinHome, 'lib', 'kotlin-compiler.jar'), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-version'],
    { env: { ...env, ...variables }, stdio: 'inherit' });
  return { kotlinHome, bin, ...variables };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'prepare') await prepare();
    else if (process.argv[2] === 'install') await install(JSON.parse(await readFile(process.env.SETUP_MAIN_KTS_CONFIG, 'utf8')));
    else throw new Error('Expected prepare or install');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
