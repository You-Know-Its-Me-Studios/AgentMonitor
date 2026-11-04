import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sourceFingerprint } from './build-state.mjs';

const directory = path.resolve('dist');
const files: string[] = [];
async function collect(dir: string): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(file);
    else if (entry.name !== 'build.json' && !entry.name.endsWith('.map')) files.push(file);
  }
}
await collect(directory);
const hash = createHash('sha256');
for (const file of files.sort()) { hash.update(path.relative(directory, file).replaceAll('\\', '/')); hash.update('\0'); hash.update(await fs.readFile(file)); hash.update('\0'); }
const manifest = { id: hash.digest('hex'), builtAt: new Date().toISOString(), sourceId: await sourceFingerprint(process.cwd()) };
await fs.writeFile(path.join(directory, 'build.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Production build ${manifest.id.slice(0, 12)}`);
