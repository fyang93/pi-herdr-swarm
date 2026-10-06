import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import swarm, { PENDING_COUNT_KEY } from '../src/index.ts';
import { snapshot } from '../src/presets.ts';
const dir = mkdtempSync(join(tmpdir(), 'swarm-lifecycle-'));
Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1', HERDR_BIN_PATH: resolve('test/fake-herdr.cjs'), FAKE_HERDR_DIR: dir });
after(() => rmSync(dir, { recursive: true, force: true }));
const state = (agents: any[] = [], extra = {}) => writeFileSync(join(dir, 'state.json'), JSON.stringify({ agents, ...extra }));
async function runtime() {
 const cwd=mkdtempSync(join(dir,'case-')); const manager=SessionManager.create(cwd,cwd);
 manager.appendMessage({role:'user',content:'initial',timestamp:Date.now()});manager.appendMessage(fauxAssistantMessage('initial'));
 const peer=SessionManager.create(cwd,mkdtempSync(join(dir,'peer-')));peer.appendMessage({role:'user',content:'task',timestamp:Date.now()});peer.appendMessage(fauxAssistantMessage('peer final'));
 const base=manager.getLeafId()!;
 manager.appendCustomEntry('swarm_spawn',{name:'peer',pane:'w1:p9',session:peer.getSessionFile(),boundary:null,snapshot:{cwd,model:'review/test',thinking:'off'}});
 const id=manager.getLeafId()!;
 const live={name:'peer',agent:'pi',agent_status:'working',pane_id:'w1:p9',cwd,agent_session:{kind:'path',value:peer.getSessionFile()}};state([live]);
 const faux=fauxProvider({provider:'review',models:[{id:'test',reasoning:false}]});
 const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},cacheWarming:'off'});
 const loader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[pi=>pi.registerProvider(faux.provider),swarm]});await loader.reload();
 const modelRuntime=await ModelRuntime.create({authPath:join(cwd,'auth.json'),modelsPath:join(cwd,'models.json')});
 const {session}=await createAgentSession({cwd,agentDir:cwd,model:faux.getModel(),modelRuntime,resourceLoader:loader,settingsManager,sessionManager:manager});
 let widget:any;let status:any;const errors:string[]=[];
 await session.bindExtensions({mode:'tui',shutdownHandler(){},onError:e=>errors.push(e.error),uiContext:{setWidget:(_k:string,f:any)=>widget=f,setStatus:(_k:string,v:any)=>status=v,notify(){},getEditorText:()=>'',onTerminalInput:()=>()=>{}} as any});
 return {session,manager,faux,base,id,live,errors,status:()=>status,waiting:()=>widget?widget(undefined,{fg:(_c:string,s:string)=>s,bold:(s:string)=>s}).render(80).join('\n'):'',close:async()=>{await session.extensionRunner!.emit({type:'session_shutdown',reason:'reload'});session.dispose();}};
}
const results=(m:SessionManager)=>m.getEntries().filter(e=>e.type==='custom_message'&&e.customType==='swarm_result');
test('branch navigation with zero pending clears widget and error status',async()=>{
 const r=await runtime();try{
  state([r.live],{listError:true});await sleep(1250);assert.ok(r.status());
  await r.session.navigateTree(r.base,{summarize:false});state([]);await sleep(1300);
  console.log('BRANCH_PENDING',(globalThis as any)[PENDING_COUNT_KEY](),'WIDGET',r.waiting(),'STATUS',r.status());
  assert.equal((globalThis as any)[PENDING_COUNT_KEY](),0);assert.equal(r.waiting(),'');assert.equal(r.status(),undefined);
 }finally{await r.close();}
});
test('settled failure does not process previously archived peer result',async()=>{
 const r=await runtime();try{
  r.faux.setResponses(Array.from({length:10},()=>fauxAssistantMessage('',{stopReason:'error',errorMessage:'provider unavailable'})));state([]);await sleep(1400);
  console.log('ERROR_RESULT_COUNT',results(r.manager).length,'PENDING',(globalThis as any)[PENDING_COUNT_KEY](),'STATUS',r.status());
  assert.equal(results(r.manager).length,1);assert.equal((globalThis as any)[PENDING_COUNT_KEY](),1);
 }finally{await r.close();}
});
test('valid pi max thinking setting is accepted and clamped by swarm',async()=>{
 const model={provider:'review',id:'reasoning',reasoning:true,thinkingLevelMap:{off:'off',max:'max'}};
 assert.equal((await snapshot(undefined,{cwd:dir,model} as any,'max',{})).thinking,'max');
 assert.equal((await snapshot(undefined,{cwd:dir,model:{...model,thinkingLevelMap:undefined}} as any,'max',{})).thinking,'high');
 assert.equal((await snapshot(undefined,{cwd:dir,model:{...model,reasoning:false}} as any,'max',{})).thinking,'off');
});
test('supported idle reload preserves exactly one archived result',async()=>{
 const r=await runtime();try{
  r.faux.setResponses(Array.from({length:10},()=>fauxAssistantMessage('processed')));state([]);await sleep(1400);await r.session.waitForIdle();
  assert.equal(results(r.manager).length,1);await r.session.reload();await sleep(1300);
  assert.equal(results(r.manager).length,1);assert.equal((globalThis as any)[PENDING_COUNT_KEY](),0);assert.equal(r.waiting(),'');assert.deepEqual(r.errors,[]);
 }finally{await r.close();}
});
test('tree round trip restores pending, updates blocked state, and never duplicates an archived result',async()=>{
 const r=await runtime();try{
  r.faux.setResponses(Array.from({length:10},()=>fauxAssistantMessage('processed')));
  await r.session.navigateTree(r.base,{summarize:false});assert.equal(r.waiting(),'');
  state([{...r.live,agent_status:'blocked'}]);await r.session.navigateTree(r.id,{summarize:false});assert.match(r.waiting(),/Swarm.*1 running/);assert.match(r.waiting(),/peer/);await sleep(300);assert.equal(results(r.manager).length,0);assert.equal((globalThis as any)[PENDING_COUNT_KEY](),1);
  state([]);await sleep(1250);await r.session.waitForIdle();assert.equal(results(r.manager).length,1);assert.equal(r.waiting(),'');
  await r.session.navigateTree(r.base,{summarize:false});await r.session.navigateTree(r.id,{summarize:false});await sleep(1200);
  assert.equal(results(r.manager).length,1);assert.equal((globalThis as any)[PENDING_COUNT_KEY](),0);assert.equal(r.waiting(),'');assert.deepEqual(r.errors,[]);
 }finally{await r.close();}
});
test('in-flight successful list must not archive an abandoned branch',async()=>{
 const r=await runtime();try{
  const marker=join(dir,'list-success-inflight');state([],{delayList:700,listMarker:marker});
  for(let i=0;i<150&&!existsSync(marker);i++)await sleep(10);assert.ok(existsSync(marker));
  await r.session.navigateTree(r.base,{summarize:false});state([]);await sleep(1000);
  assert.equal(results(r.manager).length,0);assert.equal(r.waiting(),'');assert.equal(r.status(),undefined);assert.deepEqual(r.errors,[]);
 }finally{await r.close();}
});
test('an in-flight failed list must not restore stale status after tree navigation',async()=>{
 const r=await runtime();try{
  const marker=join(dir,'list-inflight');state([r.live],{listError:true,delayList:700,listMarker:marker});
  for(let i=0;i<150&&!existsSync(marker);i++)await sleep(10);assert.ok(existsSync(marker));
  await r.session.navigateTree(r.base,{summarize:false});assert.equal(r.waiting(),'');assert.equal(r.status(),undefined);state([]);await sleep(1000);
  console.log('INFLIGHT_TREE_PENDING',(globalThis as any)[PENDING_COUNT_KEY](),'STATUS',r.status());
  assert.equal((globalThis as any)[PENDING_COUNT_KEY](),0);assert.equal(r.waiting(),'');assert.equal(r.status(),undefined);
 }finally{await r.close();}
});
