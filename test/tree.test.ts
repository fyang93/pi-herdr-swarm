import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import swarm, { PENDING_COUNT_KEY } from '../src/index.ts';
import { snapshot } from '../src/presets.ts';
const dir = mkdtempSync(join(tmpdir(), 'swarm-tree-'));
Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1', HERDR_BIN_PATH: resolve('test/fake-herdr.cjs'), FAKE_HERDR_DIR: dir });
after(() => rmSync(dir, { recursive: true, force: true }));
const state = (agents: any[] = [], extra = {}) => writeFileSync(join(dir, 'state.json'), JSON.stringify({ agents, ...extra }));
async function runtime() {
 const cwd=mkdtempSync(join(dir,'case-')); const manager=SessionManager.create(cwd,cwd);
 manager.appendMessage({role:'user',content:'initial',timestamp:Date.now()});manager.appendMessage(fauxAssistantMessage('initial'));
 const peer=SessionManager.create(cwd,mkdtempSync(join(dir,'peer-')));peer.appendMessage({role:'user',content:'task',timestamp:Date.now()});peer.appendMessage(fauxAssistantMessage('peer final'));
 const base=manager.getLeafId()!;
 manager.appendCustomEntry('swarm_spawn',{name:'peer',pane:'w1:p9',session:peer.getSessionFile(),boundary:null,detach:false,snapshot:{cwd,model:'review/test',thinking:'off'}});
 const id=manager.getLeafId()!;
 const live={name:'peer',agent:'pi',agent_status:'working',pane_id:'w1:p9',cwd,agent_session:{kind:'path',value:peer.getSessionFile()}};state([live]);
 const faux=fauxProvider({provider:'review',models:[{id:'test',reasoning:false}]});
 const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},cacheWarming:'off'});
 const loader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[pi=>pi.registerProvider(faux.provider),swarm]});await loader.reload();
 const modelRuntime=await ModelRuntime.create({authPath:join(cwd,'auth.json'),modelsPath:join(cwd,'models.json')});
 const {session}=await createAgentSession({cwd,agentDir:cwd,model:faux.getModel(),modelRuntime,resourceLoader:loader,settingsManager,sessionManager:manager});
 let widget:any;let status:any;const errors:string[]=[];
 await session.bindExtensions({mode:'tui',shutdownHandler(){},onError:e=>errors.push(e.error),uiContext:{setWidget:(_k:string,f:any)=>widget=f,setStatus:(_k:string,v:any)=>status=v,notify(){},getEditorText:()=>'',onTerminalInput:()=>()=>{}} as any});
 return {session,manager,faux,base,id,live,errors,status:()=>status,waiting:()=>widget?widget(undefined,{fg:(_c:string,s:string)=>s}).render(80)[0]:'',close:async()=>{await session.extensionRunner!.emit({type:'session_shutdown',reason:'reload'});session.dispose();}};
}
test('tree navigation away from the spawn clears the waiting line and a stale status at once', async () => {
 const r = await runtime(); try {
  state([r.live], { listError: true }); await sleep(1250); assert.ok(r.status());
  await r.session.navigateTree(r.base, { summarize: false }); state([]); await sleep(50);
  assert.equal((globalThis as any)[PENDING_COUNT_KEY](), 0); assert.equal(r.waiting(), ''); assert.equal(r.status(), undefined);
 } finally { await r.close(); }
});

test('max is a thinking level pi accepts', async () => {
 const model = { provider: 'review', id: 'reasoning', reasoning: true, thinkingLevels: { off: 'off', max: 'max' } };
 await snapshot(undefined, { cwd: dir, model } as any, 'max', {}); // clamped to what the model supports, never rejected
});
