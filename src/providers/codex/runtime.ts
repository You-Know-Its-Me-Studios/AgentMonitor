import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import type { AdapterContext } from '../../shared/adapter.js';
import { resolveExecutable } from '../../server/executables.js';
import { logError } from '../../server/errors.js';
import { redact } from '../../server/privacy.js';

const READ_METHODS = new Set(['initialize','thread/loaded/list','thread/read','thread/list','thread/turns/list','thread/items/list','account/rateLimits/read']);

/** The CLI proxy copies raw socket bytes; it is not the JSONL app-server transport. */
class ProxyStream extends Duplex {
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private timeoutMs = 0;
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();
    child.stdout.on('data',(data: Buffer) => { this.touch(); if (!this.push(data)) child.stdout.pause(); });
    child.stdout.on('end',() => this.push(null));
    child.stdout.on('error',error => this.destroy(error));
    child.stdin.on('error',error => this.destroy(error));
  }
  _read(): void { this.child.stdout.resume(); }
  _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) { callback(new Error('Codex proxy input has closed')); return; }
    this.touch(); this.child.stdin.write(chunk,encoding,callback);
  }
  _final(callback: (error?: Error | null) => void): void { if (this.child.stdin.destroyed || this.child.stdin.writableEnded) callback(); else this.child.stdin.end(callback); }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void { clearTimeout(this.timeout); this.child.stdout.destroy(); this.child.stdin.destroy(); callback(error); }
  // http.request's createConnection hook uses this duplex connection without TCP.
  setTimeout(ms: number, callback?: () => void): this { this.timeoutMs=ms; if(callback)this.once('timeout',callback); this.touch(); return this; }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  private touch(): void { clearTimeout(this.timeout); if(this.timeoutMs>0){this.timeout=setTimeout(()=>this.emit('timeout'),this.timeoutMs);this.timeout.unref();} }
}

export class ObserverProxy {
  private child: ChildProcessWithoutNullStreams | null = null;
  private websocket: WebSocket | null = null;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private initialized = false;
  private receivedSequence = 0;
  notifications = new Map<string, any>();
  error: string | null = null;
  get connected(): boolean { return this.initialized && this.websocket?.readyState===WebSocket.OPEN && !!this.child && !this.child.killed && this.child.exitCode===null && this.child.signalCode===null; }
  async connect(context: AdapterContext, socket?: string): Promise<void> {
    if(this.connected)return;
    this.close(); this.error=null;
    let executable='codex', args=['app-server','proxy'];
    const env={...process.env,CODEX_HOME:context.root};
    if(socket)args.push('--sock',socket);
    if(context.namespace.startsWith('wsl:')) {
      const [,distro,user]=context.namespace.split(':');
      args=['--distribution',distro,...(user&&user!=='default'?['--user',user]:[]),'--exec','env',`CODEX_HOME=${context.root}`,'codex',...args]; executable='wsl.exe';
    } else ({executable,args}=await resolveExecutable(executable,args,{env}));
    const child=spawn(executable,args,{env,windowsHide:true,stdio:'pipe'});this.child=child;
    const stream=new ProxyStream(child);
    let stderr = '', reported = false;
    const failure = (boundary: string, error: unknown) => {
      if (this.child !== child) return;
      if (!reported) { this.error = logError(boundary, error); reported = true; }
      this.initialized = false; this.failPending();
    };
    // Remains installed after ws tears down its own listeners. A late pipe error
    // must never become an unhandled error on this custom Duplex.
    stream.on('error', error => failure('Codex proxy duplex', error));
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString('utf8')).slice(-4096); });
    child.stderr.on('error', error => { failure('Codex proxy stderr', error); stream.destroy(error); });
    child.on('error', error => { failure('Codex proxy process', error); stream.destroy(error); });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      failure('Codex proxy exit', new Error(`Existing proxy exited (code ${code}, signal ${signal || 'none'})${stderr.trim() ? `: ${redact(stderr.trim())}` : ''}`));
      stream.destroy();
    });
    // ws performs HTTP upgrade and RFC 6455 framing over the proxy's raw bytes.
    // localhost is the daemon's documented handshake authority, never a TCP connection.
    const websocket=new WebSocket('ws://localhost/',{createConnection:()=>stream as unknown as Socket,handshakeTimeout:6000,maxPayload:32*1024*1024,perMessageDeflate:false,followRedirects:false});
    this.websocket=websocket;
    websocket.on('message',(data,isBinary)=>{
      if(isBinary){this.error='Existing Codex daemon returned an unsupported binary message';return;}
      try{this.receive(JSON.parse(data.toString()));}catch{this.error='Existing Codex daemon returned an unsupported JSON-RPC message';}
    });
    websocket.on('error',error=>{if(this.websocket===websocket)failure('Codex observer WebSocket',error);});
    websocket.on('close',()=>{if(this.websocket!==websocket)return;this.initialized=false;this.error??='Existing Codex daemon observer disconnected';this.failPending();});
    try {
      await new Promise<void>((resolve,reject)=>{const open=()=>{cleanup();resolve();},failed=()=>{cleanup();reject(new Error(this.error??'Existing Codex daemon WebSocket upgrade failed'));},cleanup=()=>{websocket.off('open',open);websocket.off('error',failed);websocket.off('close',failed);};websocket.once('open',open);websocket.once('error',failed);websocket.once('close',failed);});
      await this.request('initialize',{clientInfo:{name:'agent_monitor',title:'Agent Monitor',version:'1.0.0'},capabilities:{experimentalApi:true}});
      this.send({method:'initialized'});this.initialized=true;
    }catch(error){this.close();throw error;}
  }
  private send(message: unknown): void {
    if(this.websocket?.readyState!==WebSocket.OPEN)throw new Error('Codex observer is disconnected');
    const websocket = this.websocket;
    websocket.send(JSON.stringify(message),{binary:false,compress:false},error=>{if(error && this.websocket===websocket){this.error=logError('Codex observer request write',error);this.initialized=false;this.failPending();}});
  }
  private receive(message: any): void {
    if(!message||typeof message!=='object'||Array.isArray(message))return;
    const order=++this.receivedSequence;
    // Refuse incoming requests; monitoring never services approvals or elicitation.
    if(message.id!==undefined&&message.method){this.send({id:message.id,error:{code:-32601,message:'Read-only observer'}});return;}
    if(typeof message.id==='number'){const pending=this.pending.get(message.id);if(pending){clearTimeout(pending.timer);this.pending.delete(message.id);if(message.error)pending.reject(new Error(`Codex read request rejected (${typeof message.error.code==='number'?message.error.code:'unsupported'})`));else pending.resolve(message.result&&typeof message.result==='object'?{...message.result,__observerSequence:order}:message.result);}return;}
    if(['thread/status/changed','thread/name/updated','thread/tokenUsage/updated','turn/started','turn/completed'].includes(message.method)&&typeof message.params?.threadId==='string')this.notifications.set(`${message.method}:${message.params.threadId}`,{...message.params,__observerSequence:order});
  }
  request(method: string, params?: any): Promise<any> {
    if(!READ_METHODS.has(method))return Promise.reject(new Error('Observer method is not allowed'));
    if(this.websocket?.readyState!==WebSocket.OPEN)return Promise.reject(new Error('Observer is disconnected'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Codex passive read timed out'));},6000);this.pending.set(id,{resolve,reject,timer});try{this.send({id,method,...(params!==undefined?{params}:{})});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
  }
  private failPending(): void {for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error(this.error??'Codex observer disconnected'));}this.pending.clear();}
  close(): void {this.initialized=false;const websocket=this.websocket;this.websocket=null;if(websocket&&websocket.readyState!==WebSocket.CLOSED)websocket.terminate();const child=this.child;this.child=null;child?.stdin.end();child?.kill();this.notifications.clear();this.failPending();}
}
