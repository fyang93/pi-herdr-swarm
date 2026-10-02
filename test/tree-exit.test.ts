import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import swarm,{PENDING_COUNT_KEY} from '../src/index.ts';
const dir=mkdtempSync(join(tmpdir(),'swarm-tree-exit-'));
Object.assign(process.env,{HERDR_ENV:'1',HERDR_PANE_ID:'w1:p1',HERDR_WORKSPACE_ID:'w1',HERDR_BIN_PATH:resolve('test/fake-herdr.cjs'),FAKE_HERDR_DIR:dir});
after(()=>rmSync(dir,{recursive:true,force:true}));
for(const fresh of [false,true]) test(fresh?'resumed peer: a new reply on a branch before launch boundary must not crash':'resumed peer: tree navigation before launch boundary cancels the old exit candidate',async()=>{
 const manager=SessionManager.create(dir,dir);manager.appendMessage({role:'user',content:'intro task',timestamp:Date.now()});manager.appendMessage(fauxAssistantMessage('earlier assistant'));const earlierAssistant=manager.getLeafId()!;manager.appendMessage({role:'user',content:'old task',timestamp:Date.now()});manager.appendMessage(fauxAssistantMessage('old final'));const boundary=manager.getLeafId()!;
 const peer=SessionManager.create(dir,mkdtempSync(join(dir,'peer-')));peer.appendMessage({role:'user',content:'task',timestamp:Date.now()});peer.appendMessage(fauxAssistantMessage('child final'));
 manager.appendCustomEntry('swarm_spawn',{name:'child',pane:'w1:p9',session:peer.getSessionFile(),boundary:null,detach:false,snapshot:{cwd:dir,model:'review/test',thinking:'off'}});
 const live={name:'child',agent:'pi',agent_status:'working',pane_id:'w1:p9',cwd:dir,agent_session:{kind:'path',value:peer.getSessionFile()}};
 const marker=join(dir,'list-inflight');writeFileSync(join(dir,'state.json'),JSON.stringify({agents:[live],delayList:700,listMarker:marker}));
 const faux=fauxProvider({provider:'review',models:[{id:'test',reasoning:false}]});faux.setResponses([fauxAssistantMessage('new finished candidate'),fauxAssistantMessage('fresh reply on selected branch')]);
 const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},cacheWarming:'off'});
 const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[pi=>pi.registerProvider(faux.provider),swarm]});await loader.reload();
 for(const [name,value] of Object.entries({'swarm-name':'resumed','swarm-spawner':'host','swarm-session':manager.getSessionFile()!,'swarm-boundary':boundary}))loader.getExtensions().runtime.flagValues.set(name,value);
 const modelRuntime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json')});
 const {session}=await createAgentSession({cwd:dir,agentDir:dir,model:faux.getModel(),modelRuntime,resourceLoader:loader,settingsManager,sessionManager:manager});
 let shutdowns=0;const errors:string[]=[];
 await session.bindExtensions({mode:'tui',shutdownHandler(){shutdowns++;},onError:e=>errors.push(e.error),uiContext:{setWidget(){},setStatus(){},notify(){},getEditorText:()=>'',onTerminalInput:()=>()=>{}} as any});
 try{
  await session.prompt('new task');await sleep(20);assert.equal(shutdowns,0);assert.equal((globalThis as any)[PENDING_COUNT_KEY](),1);
  if(!fresh){for(let i=0;i<150&&!existsSync(marker);i++)await sleep(10);assert.ok(existsSync(marker));}
  const navigated=await session.navigateTree(earlierAssistant,{summarize:false});assert.equal(navigated.editorText,undefined);assert.equal((globalThis as any)[PENDING_COUNT_KEY](),0);
  if(fresh) await session.prompt('continue on selected earlier branch');
  await sleep(1000);
  console.log('TREE_EXIT_SHUTDOWNS',shutdowns,'ERRORS',errors);assert.equal(shutdowns,0);assert.deepEqual(errors,[]);
 }finally{await session.extensionRunner!.emit({type:'session_shutdown',reason:'reload'});session.dispose();}
});
