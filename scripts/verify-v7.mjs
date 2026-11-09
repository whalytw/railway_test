// Run the full regression suite and bind its evidence to the runtime source.
// Zero dependencies; never publishes, installs packages or modifies a repo.
import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function sourceDigest() {
  const files = [];
  for (const dir of ['src', 'tests']) for (const entry of await readdir(path.join(root, dir))) if (/\.(?:js|mjs)$/.test(entry)) files.push(`${dir}/${entry}`);
  for (const entry of await readdir(root)) if (/\.(?:html|css)$/.test(entry) || ['package.json', 'asset-manifest.json'].includes(entry)) files.push(entry);
  files.push('scripts/verify-v7.mjs'); files.sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(file + '\0').update(await readFile(path.join(root, file))).update('\0');
  return hash.digest('hex');
}
const before = await sourceDigest(), started = Date.now();
const tests = (await readdir(path.join(root, 'tests'))).filter(f => f.endsWith('.test.mjs')).sort().map(f => path.join(root, 'tests', f));
const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...tests], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); process.stdout.write(chunk); });
let exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
const after = await sourceDigest();
if (before !== after) { exitCode = 1; console.error('Source changed while tests were running. Re-run verification.'); }
const count = name => Number(output.match(new RegExp(`(?:^|\\n)[^\\n]*?\\b${name} (\\d+)\\s*(?:\\n|$)`))?.[1] || 0);
const result = { version: '7.0.0', command: 'node scripts/verify-v7.mjs', total: count('tests'), passed: count('pass'), failed: count('fail'),
  exitCode, durationMs: Date.now() - started, finishedAt: new Date().toISOString(), sourceSha256: after, sourceUnchangedDuringTests: before === after };
if (!result.total || result.passed !== result.total || result.failed) result.exitCode = 1;
await writeFile(path.join(root, 'validation', 'automated-v7.json'), JSON.stringify(result, null, 2) + '\n');
await writeFile(path.join(root, 'validation', 'test-v7.log'), output);
process.exitCode = result.exitCode;
