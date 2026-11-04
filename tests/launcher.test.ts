import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
const cleanup: Array<() => Promise<void>> = [];
const BUILD_A='a'.repeat(64),BUILD_B='b'.repeat(64);
type Health={workspace:string;pid?:number;buildId?:string;instanceId?:string;startedAt?:string};
const fixtureServer=`
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=process.env.AGENT_MONITOR_WORKSPACE,port=Number(process.env.AGENT_MONITOR_PORT),legacy=process.env.MONITOR_FIXTURE_LEGACY==='1';
const buildId=JSON.parse(fs.readFileSync(path.join(root,'dist/build.json'),'utf8')).id,instanceId=crypto.randomUUID(),startedAt=new Date().toISOString(),launcherKey=crypto.randomBytes(32).toString('hex');
const recordPath=path.join(root,'.agent-monitor/server-process.json');fs.mkdirSync(path.dirname(recordPath),{recursive:true});fs.appendFileSync(path.join(root,'starts.txt'),'start\\n');
const health={app:'ykims-agent-monitor',workspace:root,ready:true,...(!legacy?{pid:process.pid,buildId,instanceId,startedAt}:{})};
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/api/health'){res.end(JSON.stringify(health));return;}if(req.method==='POST'&&req.url==='/api/internal/stop'&&!legacy&&req.headers['x-agent-monitor-launcher-key']===launcherKey){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{let input;try{input=JSON.parse(body);}catch{res.statusCode=400;res.end('{}');return;}if(req.headers['content-type']!=='application/json'||input.instanceId!==instanceId){res.statusCode=409;res.end('{}');return;}fs.appendFileSync(path.join(root,'stops.txt'),'stop\\n');res.end('{"stopping":true}');setTimeout(()=>server.close(()=>{try{const record=JSON.parse(fs.readFileSync(recordPath,'utf8'));if(record.instanceId===instanceId)fs.unlinkSync(recordPath);}catch{}process.exit(0);}),10);});return;}res.statusCode=403;res.end('{"error":"denied"}');});
server.listen(port,'127.0.0.1',()=>{if(!legacy)fs.writeFileSync(recordPath,JSON.stringify({app:health.app,workspace:root,port,pid:process.pid,startedAt,instanceId,buildId,launcherKey}));});
`;
async function readHealth(port:number):Promise<Health|null>{return fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(1000)}).then(r=>r.json() as Promise<Health>).catch(()=>null);}
async function waitReady(port:number){for(let i=0;i<60;i++){const health=await readHealth(port);if(health)return health;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Fixture server did not become ready');}
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function unusedPort(): Promise<number> { const server=net.createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port; }
async function fixture(build = true) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent monitor & launcher '));cleanup.push(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'scripts'));await fs.copyFile(path.resolve('scripts/Launch-AgentMonitor.ps1'),path.join(root,'scripts/Launch-AgentMonitor.ps1'));
  if(build){await fs.mkdir(path.join(root,'dist/server'),{recursive:true});await fs.mkdir(path.join(root,'dist/client'),{recursive:true});await fs.writeFile(path.join(root,'dist/client/index.html'),'<!doctype html><title>Fixture</title>');await fs.writeFile(path.join(root,'dist/server/main.js'),fixtureServer);await fs.writeFile(path.join(root,'dist/build.json'),JSON.stringify({id:BUILD_A,builtAt:new Date().toISOString()}));}
  const port=await unusedPort();const env={...process.env,AGENT_MONITOR_PORT:String(port),AGENT_MONITOR_WORKSPACE:root};
  cleanup.push(async()=>{const health=await readHealth(port);if(health?.workspace===root&&health.pid){try{process.kill(health.pid);}catch{/* The owned fixture may already have exited. */}await new Promise(resolve=>setTimeout(resolve,200));}});
  const launch=async(portOverride?:number,shim?:string)=>{
    // Restricted Windows tokens can deny anonymous pipes while allowing hidden child processes.
    const capture=await fs.mkdtemp(path.join(root,'capture-'));const output=path.join(capture,'stdout'),errors=path.join(capture,'stderr');const outFd=openSync(output,'wx'),errFd=openSync(errors,'wx');
    try {
      const code=await new Promise<number|null>((resolve,reject)=>{
        const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',shim||path.join(root,'scripts/Launch-AgentMonitor.ps1'),'-NoBrowser','-NonInteractive'],{env:{...env,...(portOverride?{AGENT_MONITOR_PORT:String(portOverride)}:{})},windowsHide:true,stdio:['ignore',outFd,errFd]});
        const timer=setTimeout(()=>{child.kill();reject(Object.assign(new Error('Launcher timed out'),{code:'ETIMEDOUT'}));},45000);
        child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',value=>{clearTimeout(timer);resolve(value);});
      });
      const stdout=await fs.readFile(output,'utf8'),stderr=await fs.readFile(errors,'utf8');if(code!==0)throw Object.assign(new Error(stderr||'Launcher failed'),{code,stdout,stderr});return{stdout,stderr};
    } finally { closeSync(outFd);closeSync(errFd); }
  };
  const rebuild=()=>fs.writeFile(path.join(root,'dist/build.json'),JSON.stringify({id:BUILD_B,builtAt:new Date().toISOString()}));
  return{root,port,launch,env,rebuild};
}
async function startLegacy(f:Awaited<ReturnType<typeof fixture>>,wrongScript=false){
  const script=wrongScript?path.join(f.root,'unrelated-node-server.js'):path.join(f.root,'dist/server/main.js');if(wrongScript)await fs.writeFile(script,fixtureServer);
  const child=spawn(process.execPath,[script],{env:{...f.env,MONITOR_FIXTURE_LEGACY:'1'},windowsHide:true,stdio:'ignore'});cleanup.push(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>setTimeout(resolve,200));}});await waitReady(f.port);return{child,script};
}
async function legacyShim(f:Awaited<ReturnType<typeof fixture>>,child:ChildProcess,script:string,mode:'valid'|'denied'|'reused'='valid'){
  await fs.writeFile(path.join(f.root,'legacy-fixture.json'),JSON.stringify({pid:child.pid,port:f.port,executable:process.execPath,commandLine:`"${process.execPath}" "${script}"`,mode}));
  const shim=path.join(f.root,'scripts/Test-LegacyLauncher.ps1');await fs.writeFile(shim,`
param([switch]$NoBrowser,[switch]$NonInteractive)
$fixturePath=Join-Path $PSScriptRoot '..\\legacy-fixture.json'
function Get-NetTCPConnection { [CmdletBinding()]param($State,$LocalPort) $meta=Get-Content -LiteralPath $fixturePath -Raw|ConvertFrom-Json; if([int]$LocalPort-eq[int]$meta.port){[pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=[int]$meta.pid}} }
function Get-CimInstance { [CmdletBinding()]param($ClassName,$Filter) $meta=Get-Content -LiteralPath $fixturePath -Raw|ConvertFrom-Json;if($meta.mode-eq'denied'){throw 'Access denied in fixture'};$owned=Get-Process -Id $meta.pid -ErrorAction Stop;$created=$owned.StartTime;if($meta.mode-eq'reused'){$created=$created.AddSeconds(-30)};[pscustomobject]@{ProcessId=$owned.Id;Name='node.exe';ExecutablePath=$meta.executable;CommandLine=$meta.commandLine;CreationDate=$created} }
& (Join-Path $PSScriptRoot 'Launch-AgentMonitor.ps1') -NoBrowser -NonInteractive
exit $LASTEXITCODE
`);return shim;
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
    const f=await fixture();const http=await import('node:http');const server=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({app:'ykims-agent-monitor',workspace:'C:\\another folder',ready:true}));});
    await new Promise<void>(resolve=>server.listen(f.port,'127.0.0.1',resolve));cleanup.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
    await expect(f.launch()).rejects.toMatchObject({code:1});
  },20000);
  it('replaces a stale modern build through private stop and concurrent launches start the new build once',async()=>{
    const f=await fixture();await f.launch();const old=(await readHealth(f.port))!;await f.rebuild();await Promise.all([f.launch(),f.launch()]);const current=(await readHealth(f.port))!;expect(current.buildId).toBe(BUILD_B);expect(current.pid).not.toBe(old.pid);expect((await fs.readFile(path.join(f.root,'starts.txt'),'utf8')).trim().split('\n')).toHaveLength(2);expect((await fs.readFile(path.join(f.root,'stops.txt'),'utf8')).trim().split('\n')).toHaveLength(1);
  },60000);
  it('refuses a stale modern instance whose private process record does not match',async()=>{
    const f=await fixture();await f.launch();const old=(await readHealth(f.port))!;await f.rebuild();const file=path.join(f.root,'.agent-monitor/server-process.json'),record=JSON.parse(await fs.readFile(file,'utf8'));record.instanceId='unrelated-instance';await fs.writeFile(file,JSON.stringify(record));await expect(f.launch()).rejects.toMatchObject({code:1});expect((await readHealth(f.port))?.pid).toBe(old.pid);
  },20000);
  it('migrates only a legacy Node process with the exact script and stable creation identity',async()=>{
    const f=await fixture();const legacy=await startLegacy(f);const shim=await legacyShim(f,legacy.child,legacy.script);await f.rebuild();await f.launch(undefined,shim);expect((await readHealth(f.port))?.buildId).toBe(BUILD_B);expect((await readHealth(f.port))?.pid).not.toBe(legacy.child.pid);
  },30000);
  it.each(['wrong-script','reused','denied'] as const)('leaves a legacy process alive when verification is %s',async mode=>{
    const f=await fixture();const legacy=await startLegacy(f,mode==='wrong-script');const shim=await legacyShim(f,legacy.child,legacy.script,mode==='wrong-script'?'valid':mode);await f.rebuild();await expect(f.launch(undefined,shim)).rejects.toMatchObject({code:1});expect(legacy.child.exitCode).toBeNull();expect((await readHealth(f.port))?.workspace).toBe(f.root);
  },20000);
});
