import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ObserverFailure } from '../../shared/observer.js';
import { logError } from '../errors.js';

export class ObserverWorkerError extends Error {
  constructor(readonly code: ObserverFailure['code'], message: string) { super(message); this.name = 'ObserverWorkerError'; }
}
export interface ObserverCommand { executable: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; input: string; timeoutMs: number; signal?: AbortSignal; maxOutputBytes?: number; fileStdio?: boolean }
export interface ObserverProcessResult { stdout: string; stderr: string; code: number | null; durationMs: number }
export interface ObserverProcessRunner { run(command: ObserverCommand): Promise<ObserverProcessResult>; close(): Promise<void> }

export function createObserverProcessRunner(): ObserverProcessRunner {
  const children = new Set<ChildProcess>(); let closed = false;
  async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null || !children.has(child)) return;
    const exited = new Promise<void>(resolve => { const timer=setTimeout(resolve,2000); child.once('close',()=>{clearTimeout(timer);resolve();}); });
    // The PID comes only from a child created and still tracked by this runner, never source metadata.
    if (process.platform === 'win32' && child.pid) {
      await new Promise<void>(resolve => {
        const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        const timer=setTimeout(()=>{killer.kill();child.kill('SIGKILL');resolve();},750);
        killer.once('error',() => { clearTimeout(timer);child.kill('SIGKILL');resolve(); }); killer.once('exit',code => { clearTimeout(timer);if(code!==0)child.kill('SIGKILL');resolve(); });
      });
    } else if (child.pid) { try { process.kill(-child.pid,'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL'); } }
    await exited;
  }
  async function execute(command: ObserverCommand, files: boolean): Promise<ObserverProcessResult> {
    if (closed) throw new ObserverWorkerError('unavailable','Observer worker is closed.');
    if (command.signal?.aborted) throw new ObserverWorkerError('superseded','Observer assessment was superseded.');
    const started = Date.now(), max = command.maxOutputBytes ?? 4 * 1024 * 1024; const errMax = 256 * 1024;
    let directory: string | null = null; const fds: number[] = [];
    try {
      let stdio: ['pipe','pipe','pipe'] | [number,number,number] = ['pipe','pipe','pipe'];
      if (files) {
        directory = await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-observer-')); await fs.chmod(directory,0o700);
        const input = path.join(directory,'stdin'); await fs.writeFile(input,command.input,{mode:0o600,flag:'wx'});
        fds.push(openSync(input,'r'),openSync(path.join(directory,'stdout'),'wx',0o600),openSync(path.join(directory,'stderr'),'wx',0o600)); stdio = [fds[0],fds[1],fds[2]];
      }
      return await new Promise<ObserverProcessResult>((resolve,reject) => {
        let child: ChildProcess;
        try { child = spawn(command.executable,command.args,{cwd:command.cwd,env:command.env,windowsHide:true,detached:process.platform !== 'win32',stdio}); }
        catch (e) { reject(e); return; }
        children.add(child); let done = false, failure: ObserverWorkerError | null = null; let outBytes = 0, errBytes = 0; const out: Buffer[] = [], err: Buffer[] = [];
        const fail = (error: ObserverWorkerError) => { if (failure || done) return; failure = error; void stop(child).catch(error => { logError('Observer process shutdown', error); }); };
        const timeout = setTimeout(() => fail(new ObserverWorkerError('timeout',`Observer assessment exceeded ${Math.round(command.timeoutMs/1000)} seconds.`)),command.timeoutMs);
        const abort = () => fail(new ObserverWorkerError('superseded','Observer assessment was superseded.'));
        command.signal?.addEventListener('abort',abort,{once:true});
        if(command.signal?.aborted)abort();
        const fileLimit = files ? setInterval(() => { if (!directory || done) return; void Promise.all([fs.stat(path.join(directory,'stdout')),fs.stat(path.join(directory,'stderr'))]).then(([o,e]) => { if (o.size > max || e.size > errMax) fail(new ObserverWorkerError('invalid-output','Observer CLI output exceeded the bounded response limit.')); }).catch(() => { if (!done) fail(new ObserverWorkerError('provider-error','Observer output capture became unavailable.')); }); },100) : null;
        const cleanup = () => { done = true; clearTimeout(timeout); if (fileLimit) clearInterval(fileLimit); command.signal?.removeEventListener('abort',abort); children.delete(child); };
        child.stdout?.on('data',(chunk: Buffer) => { outBytes += chunk.length; if (outBytes > max) fail(new ObserverWorkerError('invalid-output','Observer CLI output exceeded the bounded response limit.')); else out.push(chunk); });
        child.stderr?.on('data',(chunk: Buffer) => { errBytes += chunk.length; if (errBytes > errMax) fail(new ObserverWorkerError('invalid-output','Observer diagnostic output exceeded its limit.')); else err.push(chunk); });
        child.stdin?.on('error',error => { if (!done && (error as NodeJS.ErrnoException).code !== 'EPIPE') fail(new ObserverWorkerError('provider-error',`Observer input failed: ${logError('Observer stdin', error)}`)); });
        child.stdout?.on('error',error => { if (!done) fail(new ObserverWorkerError('provider-error',`Observer output failed: ${logError('Observer stdout', error)}`)); });
        child.stderr?.on('error',error => { if (!done) fail(new ObserverWorkerError('provider-error',`Observer diagnostics failed: ${logError('Observer stderr', error)}`)); });
        child.on('error',error => { if (done) return; cleanup(); reject(error); });
        child.on('close',async code => {
          if (done) return; cleanup();
          if (failure) { reject(failure); return; }
          try {
            let stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
            if (files && directory) { const o = path.join(directory,'stdout'), e = path.join(directory,'stderr'); const [os,es] = await Promise.all([fs.stat(o),fs.stat(e)]); if (os.size > max || es.size > errMax) throw new ObserverWorkerError('invalid-output','Observer CLI output exceeded the bounded response limit.'); [stdout,stderr] = await Promise.all([fs.readFile(o,'utf8'),fs.readFile(e,'utf8')]); }
            resolve({stdout,stderr,code,durationMs:Date.now()-started});
          } catch (error) { reject(error); }
        });
        if (!files) child.stdin?.end(command.input,'utf8');
      });
    } finally { for (const fd of fds) closeSync(fd); if (directory) await fs.rm(directory,{recursive:true,force:true}); }
  }
  return {
    async run(command) {
      try { return await execute(command,command.fileStdio === true); }
      catch (error) {
        if (process.platform === 'win32' && !command.fileStdio && (error as NodeJS.ErrnoException).code === 'EPERM') return execute(command,true);
        if (error instanceof ObserverWorkerError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        const cause = logError('Observer process execution', error);
        throw new ObserverWorkerError(code === 'ENOENT' ? 'unavailable' : 'provider-error',`Observer CLI execution failed: ${cause}`);
      }
    },
    async close() { closed = true; await Promise.all([...children].map(stop)); }
  };
}
