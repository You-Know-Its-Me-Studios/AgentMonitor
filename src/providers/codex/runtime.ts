import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterContext } from '../../shared/adapter.js';

const READ_METHODS = new Set(['initialize','thread/loaded/list','thread/read','thread/list','thread/turns/list','thread/items/list','account/rateLimits/read']);
export class ObserverProxy {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private buffer = '';
  private initialized = false;
  notifications = new Map<string, any>();
  error: string | null = null;
  async connect(context: AdapterContext, socket?: string): Promise<void> {
    if (this.initialized && this.child && !this.child.killed) return;
    let executable = 'codex', args = ['app-server','proxy'];
    const options = { env: { ...process.env, CODEX_HOME: context.root }, windowsHide: true, stdio: 'pipe' as const };
    if (socket) args.push('--sock',socket);
    if (context.namespace.startsWith('wsl:')) {
      const [,distro,user] = context.namespace.split(':'); args = ['--distribution',distro,'--user',user,'--exec','env',`CODEX_HOME=${context.root}`,'codex',...args]; executable = 'wsl.exe';
    } else if (process.platform === 'win32') {
      const candidates = [process.env.CODEX_MANAGED_PACKAGE_ROOT && join(process.env.CODEX_MANAGED_PACKAGE_ROOT,'bin','codex.js'), process.env.APPDATA && join(process.env.APPDATA,'npm','node_modules','@openai','codex','bin','codex.js')].filter((x): x is string => !!x);
      const launcher = candidates.find(existsSync); if (!launcher) throw new Error('Codex npm launcher could not be resolved for the observer proxy'); args = [launcher,...args]; executable = process.execPath;
    }
    const child = spawn(executable,args,options); this.child = child; this.buffer = ''; this.error = null;
    child.stdout.setEncoding('utf8'); child.stdout.on('data',(data: string) => { this.buffer += data; if (this.buffer.length > 32 * 1024 * 1024) { this.error = 'Observer response exceeded the bounded buffer'; this.close(); return; } let end: number; while ((end = this.buffer.indexOf('\n')) >= 0) { const line = this.buffer.slice(0,end); this.buffer = this.buffer.slice(end+1); try { this.receive(JSON.parse(line)); } catch { this.error = 'Observer emitted an unsupported record'; } } });
    // stderr may contain local paths or diagnostics, so never forward it to browser/logs.
    child.stderr.on('data',() => {});
    child.stdin.on('error',() => { this.error = 'Existing Codex proxy input stream is unavailable'; this.failPending(); });
    child.stdout.on('error',() => { this.error = 'Existing Codex proxy output stream is unavailable'; this.failPending(); });
    child.on('error',() => { this.error = 'Existing Codex observer proxy is unavailable'; this.failPending(); });
    child.on('exit',() => { this.initialized = false; this.failPending(); });
    await this.request('initialize',{ clientInfo: { name: 'agent_monitor', title: 'Agent Monitor', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`); this.initialized = true;
  }
  private receive(message: any): void {
    // Refuse every incoming request. An observer never services approvals or elicitation.
    if (message.id !== undefined && message.method) { this.child?.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only observer' } })}\n`); return; }
    if (typeof message.id === 'number') { const p = this.pending.get(message.id); if (p) { clearTimeout(p.timer); this.pending.delete(message.id); if (message.error) p.reject(new Error(`Codex read request rejected (${message.error.code ?? 'unsupported'})`)); else p.resolve(message.result); } return; }
    // Only retain passive lifecycle/name/usage notifications. No prose or server requests.
    if (['thread/status/changed','thread/name/updated','thread/tokenUsage/updated'].includes(message.method) && typeof message.params?.threadId === 'string') this.notifications.set(`${message.method}:${message.params.threadId}`,message.params);
  }
  request(method: string, params?: any): Promise<any> {
    if (!READ_METHODS.has(method)) return Promise.reject(new Error('Observer method is not allowed'));
    if (!this.child || this.child.killed) return Promise.reject(new Error('Observer is disconnected'));
    const id = ++this.sequence;
    return new Promise((resolve,reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex passive read timed out')); },6000); this.pending.set(id,{ resolve,reject,timer }); this.child!.stdin.write(`${JSON.stringify({ id,method,...(params !== undefined ? {params} : {}) })}\n`); });
  }
  private failPending(): void { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex observer disconnected')); } this.pending.clear(); }
  close(): void { this.initialized = false; this.child?.stdin.end(); this.child?.kill(); this.child = null; this.failPending(); }
}
