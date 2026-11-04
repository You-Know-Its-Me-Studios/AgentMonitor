import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function unusedPort(): Promise<number> { const server=net.createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port; }
async function fixture(build = true) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent monitor & launcher '));cleanup.push(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'scripts'));await fs.copyFile(path.resolve('scripts/Launch-AgentMonitor.ps1'),path.join(root,'scripts/Launch-AgentMonitor.ps1'));
  if(build){await fs.mkdir(path.join(root,'dist/server'),{recursive:true});await fs.mkdir(path.join(root,'dist/client'),{recursive:true});await fs.writeFile(path.join(root,'dist/client/index.html'),'<!doctype html><title>Fixture</title>');await fs.writeFile(path.join(root,'dist/server/main.js'),`
    const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
    const root=process.env.AGENT_MONITOR_WORKSPACE;
    fs.appendFileSync(path.join(root,'starts.txt'),'start\\n');
    http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({app:'ykims-agent-monitor',workspace:root,ready:true,pid:process.pid}));}).listen(Number(process.env.AGENT_MONITOR_PORT),'127.0.0.1');
  `);}
  const port=await unusedPort();const env={...process.env,AGENT_MONITOR_PORT:String(port)};
  const launch=async(portOverride?:number)=>{
    // Restricted Windows tokens can deny anonymous pipes while allowing hidden child processes.
    const capture=await fs.mkdtemp(path.join(root,'capture-'));const output=path.join(capture,'stdout'),errors=path.join(capture,'stderr');const outFd=openSync(output,'wx'),errFd=openSync(errors,'wx');
    try {
      const code=await new Promise<number|null>((resolve,reject)=>{
        const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/Launch-AgentMonitor.ps1'),'-NoBrowser','-NonInteractive'],{env:{...env,...(portOverride?{AGENT_MONITOR_PORT:String(portOverride)}:{})},windowsHide:true,stdio:['ignore',outFd,errFd]});
        const timer=setTimeout(()=>{child.kill();reject(Object.assign(new Error('Launcher timed out'),{code:'ETIMEDOUT'}));},45000);
        child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',value=>{clearTimeout(timer);resolve(value);});
      });
      const stdout=await fs.readFile(output,'utf8'),stderr=await fs.readFile(errors,'utf8');if(code!==0)throw Object.assign(new Error(stderr||'Launcher failed'),{code,stdout,stderr});return{stdout,stderr};
    } finally { closeSync(outFd);closeSync(errFd); }
  };
  return{root,port,launch};
}
describe.skipIf(process.platform!=='win32')('Windows hidden launcher',()=>{
  it('starts from a path with spaces and simultaneous/repeated launches reuse the same collector',async()=>{
    const f=await fixture();
    try {
      await Promise.all([f.launch(),f.launch()]);
      const health=await fetch(`http://127.0.0.1:${f.port}/api/health`).then(r=>r.json()) as {pid:number;workspace:string};
      cleanup.push(async()=>{try{process.kill(health.pid);}catch{/* The fixture may have exited already. */}await new Promise(resolve=>setTimeout(resolve,300));});
      expect(health.workspace).toBe(f.root);await f.launch();await f.launch(await unusedPort());
      const again=await fetch(`http://127.0.0.1:${f.port}/api/health`).then(r=>r.json()) as {pid:number};expect(again.pid).toBe(health.pid);expect((await fs.readFile(path.join(f.root,'starts.txt'),'utf8')).trim().split('\n')).toHaveLength(1);
      expect(await fs.stat(path.join(f.root,'.agent-monitor/logs/server.log'))).toBeTruthy();
    } catch(error) {
      // Recover only this isolated fixture's PID if startup succeeded before an assertion failed.
      const health=await fetch(`http://127.0.0.1:${f.port}/api/health`).then(r=>r.json()).catch(()=>null) as {pid?:number;workspace?:string}|null;
      if(health?.workspace===f.root&&health.pid)try{process.kill(health.pid);}catch{}
      throw error;
    }
  },60000);
  it('reports a missing production build without silently installing or building',async()=>{
    const f=await fixture(false);await expect(f.launch()).rejects.toMatchObject({code:1});await expect(fs.stat(path.join(f.root,'node_modules'))).rejects.toMatchObject({code:'ENOENT'});
  },20000);
  it('refuses another workspace or service on the configured port',async()=>{
    const f=await fixture(false);const http=await import('node:http');const server=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({app:'ykims-agent-monitor',workspace:'C:\\another folder',ready:true}));});
    await new Promise<void>(resolve=>server.listen(f.port,'127.0.0.1',resolve));cleanup.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
    await expect(f.launch()).rejects.toMatchObject({code:1});
  },20000);
});
