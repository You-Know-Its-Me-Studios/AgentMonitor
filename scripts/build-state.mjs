import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const required = ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json', 'build/typescript-transform.ts', 'scripts/write-build.ts', 'scripts/build-state.mjs'];
async function digest(workspace, files) {
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) { hash.update(file); hash.update('\0'); hash.update(await fs.readFile(path.join(workspace, file))); hash.update('\0'); }
  return hash.digest('hex');
}
export async function sourceFingerprint(workspace) {
  const files = [...required];
  async function walk(directory) {
    for (const entry of await fs.readdir(path.join(workspace, directory), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(file); else files.push(file);
    }
  }
  await walk('src');
  return digest(workspace, files);
}
async function dependencyFingerprint(workspace) {
  return createHash('sha256').update(await digest(workspace, ['package.json', 'package-lock.json'])).update(`${process.platform}:${process.arch}:${process.versions.node.split('.')[0]}`).digest('hex');
}
const readJson = async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } };
const exists = async file => (await fs.stat(file).catch(() => null))?.isFile() === true;
async function inspect(workspace) {
  const sourceId = await sourceFingerprint(workspace), dependencyId = await dependencyFingerprint(workspace);
  const stamp = await readJson(path.join(workspace, '.agent-monitor/dependencies.json'));
  const manifest = await readJson(path.join(workspace, 'dist/build.json'));
  const packages = ['fastify', 'react', 'react-dom', 'vite', 'typescript', 'ws'];
  const installed = (await Promise.all(packages.map(name => exists(path.join(workspace, 'node_modules', name, 'package.json'))))).every(Boolean);
  return { sourceId, dependencyId, dependenciesCurrent: installed && stamp?.dependencyId === dependencyId, buildCurrent: manifest?.sourceId === sourceId && /^[a-f0-9]{64}$/.test(manifest?.id ?? '') && await exists(path.join(workspace, 'dist/server/main.js')) && await exists(path.join(workspace, 'dist/client/index.html')) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const workspace = path.resolve(process.argv[3] || process.cwd());
    if (process.argv[2] === 'record-dependencies') {
      await fs.mkdir(path.join(workspace, '.agent-monitor'), { recursive: true });
      await fs.writeFile(path.join(workspace, '.agent-monitor/dependencies.json'), JSON.stringify({ dependencyId: await dependencyFingerprint(workspace) }));
    } else console.log(JSON.stringify(await inspect(workspace)));
  } catch (error) { console.error(`Agent Monitor setup: ${error.message}`); process.exitCode = 1; }
}
