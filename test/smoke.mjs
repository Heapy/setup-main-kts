import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest } from '../scripts/setup.mjs';

const cache = process.env.KOTLIN_MAIN_KTS_COMPILED_SCRIPTS_CACHE_DIR;
async function snapshot() {
  const files = (await readdir(cache)).filter(file => file.endsWith('.jar')).sort();
  return Promise.all(files.map(async file => ({ file, hash: digest(await readFile(path.join(cache, file))),
    mtime: (await stat(path.join(cache, file))).mtimeMs })));
}
function run() {
  const output = execFileSync('bash', ['-c', '"$KOTLIN_HOME/bin/kotlinr" test/fixtures/check.main.kts "argument with spaces"'], { encoding: 'utf8' });
  assert.match(output, /Main-kts works/);
}
const restored = process.argv[2] === 'restored';
const before = await snapshot();
if (restored) {
  assert.ok(before.length, 'compiled jars must exist before execution');
  const proof = JSON.parse(await readFile(path.join(cache, 'ci-proof.json'), 'utf8'));
  assert.deepEqual(before.map(({ file, hash }) => ({ file, hash })), proof);
}
run();
const first = await snapshot();
assert.ok(first.length, 'compiled jars must be created');
if (restored) assert.deepEqual(first, before, 'restored bytecode must be reused');
run();
assert.deepEqual(await snapshot(), first, 'warm run must not recompile');
await writeFile(path.join(cache, 'ci-proof.json'), JSON.stringify(first.map(({ file, hash }) => ({ file, hash }))));
console.log(`PASS: ${restored ? 'restored' : 'cold'} and warm main-kts execution`);
