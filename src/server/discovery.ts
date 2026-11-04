import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { SourceRoot } from '../shared/adapter.js';
import type { Diagnostic, Provider } from '../shared/types.js';
import { command } from './io.js';

export interface MonitorConfig { port?: number; pollMs?: number; roots?: { provider: Provider; path: string; distro?: string; user?: string }[]; wsl?: boolean }
export async function loadConfig(workspace: string): Promise<MonitorConfig> {
  try {
    const data = JSON.parse(await fs.readFile(path.join(workspace, 'agent-monitor.config.json'), 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a configuration object');
    if (data.roots && (!Array.isArray(data.roots) || data.roots.some((r: any) => !['codex', 'claude'].includes(r.provider) || typeof r.path !== 'string' || !r.path || r.path.includes('\0') || (r.distro && typeof r.distro !== 'string')))) throw new Error('Invalid advanced source root');
    if (data.port && (!Number.isInteger(data.port) || data.port < 1024 || data.port > 65535)) throw new Error('Port must be 1024–65535');
    return data;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw e; }
}
export async function discoverRoots(config: MonitorConfig): Promise<{ roots: SourceRoot[]; diagnostics: Diagnostic[] }> {
  const roots: SourceRoot[] = [], diagnostics: Diagnostic[] = [];
  const add = (provider: Provider, root: string, distro?: string, user?: string) => {
    const resolved = distro ? path.posix.resolve(root) : path.resolve(root);
    const namespace = distro ? `wsl:${distro}:${user || 'default'}:${resolved}` : `native:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
    if (!roots.some(x => x.provider === provider && x.namespace === namespace)) roots.push({ provider, root: resolved, namespace, distro, user });
  };
  add('codex', path.join(os.homedir(), '.codex'));
  add('claude', path.join(os.homedir(), '.claude'));
  if (process.env.CODEX_HOME) add('codex', process.env.CODEX_HOME);
  if (process.env.CLAUDE_CONFIG_DIR) add('claude', process.env.CLAUDE_CONFIG_DIR);
  for (const r of config.roots || []) if (!r.distro) add(r.provider, r.path);
  if (process.platform === 'win32' && config.wsl !== false) {
    const running = await command('wsl.exe', ['--list', '--running', '--quiet'], 5000);
    if (running.code !== 0) diagnostics.push({ level: 'warning', code: 'wsl-unavailable', message: 'Running WSL distributions cannot be enumerated in this environment. Native Windows discovery continues.', at: new Date().toISOString() });
    else {
      const distros = running.stdout.replace(/\0/g, '').split(/[\r\n]+/).map(x => x.trim()).filter(Boolean);
      for (const distro of distros) {
        // wsl --list --running is always checked before invoking a distribution, so stopped distros remain stopped.
        const helper = `import os,json,pwd\nu=pwd.getpwuid(os.getuid());r=[dict(user=u.pw_name,home=u.pw_dir,codex=os.environ.get('CODEX_HOME',u.pw_dir+'/.codex'),claude=os.environ.get('CLAUDE_CONFIG_DIR',u.pw_dir+'/.claude'))]\nfor d in ['/home']:\n if os.path.isdir(d):\n  for n in os.listdir(d):\n   p=d+'/'+n\n   if p!=u.pw_dir and os.access(p,os.R_OK):r.append(dict(user=n,home=p,codex=p+'/.codex',claude=p+'/.claude'))\nprint(json.dumps(r))`;
        const probe = await command('python3', ['-c', helper], 7000, { provider: 'codex', root: '/', namespace: '', distro, overrideHome:false });
        try {
          if (probe.code !== 0) throw new Error('WSL helper unavailable');
          for (const u of JSON.parse(probe.stdout)) { add('codex', path.posix.join(u.home, '.codex'), distro, u.user); add('claude', path.posix.join(u.home, '.claude'), distro, u.user); add('codex', u.codex, distro, u.user); add('claude', u.claude, distro, u.user); }
          for (const r of config.roots || []) if (r.distro === distro) add(r.provider, r.path, distro, r.user);
        } catch { diagnostics.push({ namespace: `wsl:${distro}`, level: 'warning', code: 'wsl-helper-unavailable', message: 'Read-only WSL discovery needs Python 3 and access to the running distribution.', at: new Date().toISOString() }); }
      }
    }
  }
  return { roots, diagnostics };
}
