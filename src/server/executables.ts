import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

export interface ResolvedExecutable { executable: string; args: string[] }
interface ResolutionOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string }
const isFile = async (file: string) => (await fs.stat(file).catch(() => null))?.isFile() === true;

/** Resolve agent CLIs without executing cmd/PowerShell shims or consulting credentials. */
export async function resolveExecutable(executable: string, args: string[] = [], options: ResolutionOptions = {}): Promise<ResolvedExecutable> {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform;
  if (!['codex', 'claude'].includes(executable)) return { executable, args: [...args] };
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const directories = [...new Set((env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean))];
  // A real executable on PATH wins over an unrelated npm installation.
  for (const directory of directories) {
    const native = path.join(directory, `${executable}${platform === 'win32' ? '.exe' : ''}`);
    if (await isFile(native)) return { executable: native, args: [...args] };
  }
  const standalone = [path.join(home, '.local', 'bin', `${executable}${platform === 'win32' ? '.exe' : ''}`)];
  if (executable === 'codex') standalone.push(path.join(home, '.cargo', 'bin', `codex${platform === 'win32' ? '.exe' : ''}`));
  if (platform === 'win32' && env.LOCALAPPDATA) standalone.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', `${executable}.exe`));
  for (const native of standalone) if (await isFile(native)) return { executable: native, args: [...args] };

  const packageName = executable === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
  const roots = new Set<string>();
  if (executable === 'codex' && env.CODEX_MANAGED_PACKAGE_ROOT) roots.add(env.CODEX_MANAGED_PACKAGE_ROOT);
  for (const directory of directories) {
    // Standard npm prefixes, including custom prefixes exposed by codex.cmd/claude.cmd.
    roots.add(path.join(directory, 'node_modules', packageName));
    roots.add(path.resolve(directory, '..', 'lib', 'node_modules', packageName));
  }
  if (env.APPDATA) roots.add(path.join(env.APPDATA, 'npm', 'node_modules', packageName));
  for (const root of roots) {
    if (executable === 'codex' && platform === 'win32') {
      const arch = options.arch ?? process.arch;
      const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
      const vendors = [path.join(root, 'vendor')];
      try {
        const require = createRequire(path.join(root, 'package.json'));
        vendors.unshift(path.join(path.dirname(require.resolve(`@openai/codex-win32-${arch}/package.json`)), 'vendor'));
      } catch { /* Optional npm platform package may not be installed. */ }
      for (const vendor of vendors) {
        const native = path.join(vendor, triple, 'bin', 'codex.exe');
        if (await isFile(native)) return { executable: native, args: [...args] };
      }
    }
    const launcher = path.join(root, executable === 'codex' ? 'bin/codex.js' : 'cli.js');
    if (await isFile(launcher)) return { executable: process.execPath, args: [launcher, ...args] };
  }
  throw new Error(`${executable === 'codex' ? 'Codex' : 'Claude Code'} executable was not found on PATH, in its native installation, or in a recognized npm installation.`);
}
