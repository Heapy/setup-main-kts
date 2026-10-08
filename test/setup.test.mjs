import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boolean, cacheKeys, cacheReadOnly, commandFile, digest, ensureArchive, parseChecksum, prepare, versionInfo } from '../scripts/setup.mjs';

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'main-kts-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function outputs(text) {
  const result = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    const [key, delimiter] = lines[i].split('<<');
    const value = [];
    while (lines[++i] !== delimiter) value.push(lines[i]);
    result[key] = value.join('\n');
  }
  return result;
}

test('versions and checksums reject aliases, paths and injected lines', () => {
  assert.match(versionInfo('2.4.20').url, /v2\.4\.20\/kotlin-compiler-2\.4\.20\.zip$/);
  assert.ok(versionInfo('2.4.20-RC2'));
  for (const value of ['latest', '../2.4.20', '2.4.20\nx=y', '2.4.20;exit']) assert.throws(() => versionInfo(value));
  assert.equal(parseChecksum(`${'A'.repeat(64)}  kotlin.zip\n`), 'a'.repeat(64));
  for (const value of ['', 'abc', `${'a'.repeat(64)}\nx=y`]) assert.throws(() => parseChecksum(value));
  assert.throws(() => boolean('yes', 'cache'));
});

test('PRs and unknown events restore only; trusted events may save', () => {
  for (const event of ['pull_request', 'pull_request_target', 'workflow_run', undefined]) assert.equal(cacheReadOnly('auto', event), true);
  for (const event of ['push', 'schedule', 'workflow_dispatch']) assert.equal(cacheReadOnly('auto', event), false);
  assert.equal(cacheReadOnly('true', 'push'), true);
  assert.equal(cacheReadOnly('false', 'pull_request'), false);
  assert.throws(() => cacheReadOnly('automatic', 'push'));
});

test('cache identities isolate compiler, JVM, source, options, paths and platform changes', () => {
  const input = { os: 'Linux', arch: 'X64', version: '2.4.20', checksum: 'a'.repeat(64),
    java: 'temurin25', workspace: '/work/repo', maven: '/home/runner/.m2/repository', scriptsHash: 'b'.repeat(64) };
  const base = cacheKeys(input);
  for (const change of [{ java: 'temurin21' }, { scriptsHash: 'c'.repeat(64) }, { workspace: '/other' },
    { maven: '/other/.m2/repository' }, { options: '-Xplugin=plugin.jar' }]) {
    const changed = cacheKeys({ ...input, ...change });
    assert.notEqual(changed.compiled, base.compiled);
    assert.equal(changed.compiler, base.compiler);
    assert.equal(changed.dependenciesPrefix, base.dependenciesPrefix);
  }
  for (const change of [{ os: 'Windows' }, { arch: 'ARM64' }, { version: '2.4.10' }, { suffix: 'v2' }]) {
    const changed = cacheKeys({ ...input, ...change });
    assert.notEqual(changed.compiler, base.compiler);
    assert.notEqual(changed.compiled, base.compiled);
    assert.notEqual(changed.dependenciesPrefix, base.dependenciesPrefix);
  }
  assert.deepEqual(cacheKeys({ ...input, branch: 'feature' }), base);
});

test('command files preserve multiline data without introducing new variables', async t => {
  const file = path.join(await temporary(t), 'output');
  await commandFile(file, { safe: 'value\nATTACK=true\nEOF' });
  assert.deepEqual(outputs(await readFile(file, 'utf8')), { safe: 'value\nATTACK=true\nEOF' });
});

test('download is verified before use; cached archives are verified and reused', async t => {
  const root = await temporary(t);
  const data = Buffer.from('a fake archive for checksum testing');
  const config = { archiveDir: root, filename: 'kotlin.zip', url: 'https://example.invalid/kotlin.zip', checksum: digest(data) };
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(data); };
  const archive = await ensureArchive(config, fetchImpl);
  assert.deepEqual(await readFile(archive), data);
  await ensureArchive(config, fetchImpl);
  assert.equal(calls, 1);
  await writeFile(archive, 'corrupt');
  await assert.rejects(ensureArchive(config, fetchImpl), /SHA-256 mismatch/);
  assert.equal(calls, 1);
  await rm(archive);
  await assert.rejects(ensureArchive(config, async () => new Response('corrupt')), /SHA-256 mismatch/);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(ensureArchive(config, async () => new Response('', { status: 404 })), /HTTP 404/);
});

test('preparation keeps stable cache paths and clears local bytecode before restore', async t => {
  const root = await temporary(t);
  const java = path.join(root, 'jdk');
  await mkdir(java);
  await writeFile(path.join(java, 'release'), 'JAVA_VERSION="25.0.4"\nIMPLEMENTOR="Eclipse Adoptium"');
  const env = { JAVA_HOME: java, GITHUB_WORKSPACE: root, RUNNER_TEMP: root, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
    GITHUB_OUTPUT: path.join(root, 'output'), INPUT_KOTLIN_SHA256: 'a'.repeat(64), INPUT_SCRIPTS_HASH: 'b'.repeat(64),
    GITHUB_EVENT_NAME: 'pull_request', INPUT_TOOLCHAIN_JAVA_HOME: 'true' };
  const first = await prepare(env);
  const firstOutputs = outputs(await readFile(env.GITHUB_OUTPUT, 'utf8'));
  assert.equal(firstOutputs['cache-read-only'], 'true');
  assert.equal(firstOutputs['compiled-enabled'], 'true');
  assert.equal(first.toolchain, true);
  await writeFile(path.join(first.compiledDir, 'stale.jar'), 'old');
  const second = await prepare(env);
  assert.equal(first.compiledDir, second.compiledDir);
  assert.equal(first.distributionDir, second.distributionDir);
  assert.deepEqual(await readdir(second.compiledDir), []);
  assert.notEqual(first.invocation, second.invocation);
  await prepare({ ...env, INPUT_CACHE: 'false' });
  const disabled = outputs(await readFile(env.GITHUB_OUTPUT, 'utf8'));
  assert.equal(disabled['cache-enabled'], 'false');
  assert.equal(disabled['dependencies-enabled'], 'false');
  assert.equal(disabled['compiled-enabled'], 'false');
  await prepare({ ...env, INPUT_SCRIPTS_HASH: '' });
  assert.equal(outputs(await readFile(env.GITHUB_OUTPUT, 'utf8'))['compiled-enabled'], 'false');
});
