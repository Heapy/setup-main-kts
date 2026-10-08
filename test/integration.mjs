import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, install, prepare } from '../scripts/setup.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'main-kts-integration-'));
try {
  const env = { ...process.env, GITHUB_WORKSPACE: repository, RUNNER_TEMP: root,
    RUNNER_OS: process.platform, RUNNER_ARCH: process.arch, GITHUB_EVENT_NAME: 'push',
    GITHUB_OUTPUT: path.join(root, 'output'), GITHUB_ENV: path.join(root, 'env'), GITHUB_PATH: path.join(root, 'path'),
    INPUT_KOTLIN_VERSION: process.env.TEST_KOTLIN_VERSION || '2.4.20',
    INPUT_SCRIPTS_HASH: digest(await readFile(path.join(repository, 'test/fixtures/check.main.kts'))) };
  const first = await prepare(env);
  const runtime = await install(first, env);
  function run() {
    // bash is available on all supported runners and avoids cmd.exe argument rewriting.
    return execFileSync('bash', ['-c', '"$KOTLIN_HOME/bin/kotlinr" "$MAIN_KTS_FIXTURE" "argument with spaces"'], {
      encoding: 'utf8', env: { ...env, ...runtime, MAIN_KTS_FIXTURE: path.join(repository, 'test/fixtures/check.main.kts') },
    });
  }
  assert.match(run(), /Main-kts works/);
  const files = (await readdir(first.compiledDir)).filter(file => file.endsWith('.jar'));
  assert.ok(files.length, 'cold run must produce compiled jars');
  const before = await Promise.all(files.map(async file => (await stat(path.join(first.compiledDir, file))).mtimeMs));
  assert.match(run(), /Main-kts works/);
  assert.deepEqual(await Promise.all(files.map(async file => (await stat(path.join(first.compiledDir, file))).mtimeMs)), before,
    'warm run must reuse compiled jars');
  const snapshot = path.join(root, 'snapshot');
  await cp(first.compiledDir, snapshot, { recursive: true, preserveTimestamps: true });
  const second = await prepare(env);
  assert.equal(second.compiledDir, first.compiledDir);
  assert.equal(second.distributionDir, first.distributionDir);
  await cp(snapshot, second.compiledDir, { recursive: true, preserveTimestamps: true });
  await install(second, env);
  assert.match(run(), /Main-kts works/);
  assert.deepEqual(await Promise.all(files.map(async file => digest(await readFile(path.join(second.compiledDir, file))))),
    await Promise.all(files.map(async file => digest(await readFile(path.join(snapshot, file))))),
    'restored compiled jars must remain unchanged after reinstall');
  console.log('PASS: verified compiler, dependencies, imports, arguments, warm compilation and restored compilation');
} finally {
  await rm(root, { recursive: true, force: true });
}
