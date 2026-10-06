import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stripVTControlCharacters} from 'node:util';
import {initTheme} from '@earendil-works/pi-coding-agent';
import {runningView,spawnResult} from '../src/ui.ts';
import {visibleWidth} from '@earendil-works/pi-tui';
initTheme('dark',false);
const theme:any={fg:(_c:string,s:string)=>s,bg:(_c:string,s:string)=>s,bold:(s:string)=>s};
test('a legal long name preserves the count of other peers on narrow panes',()=>{
 const text=stripVTControlCharacters(runningView(['a'.repeat(32),'b','c'].map(name=>({name})),theme).render(40)[0]);
 console.log('LONG_NAME_WIDGET',JSON.stringify(text));
 assert.match(text,/3 running/);assert.ok(visibleWidth(text)<=40);
});
test('spawn result shows the peer name and pane',()=>{
 const text=spawnResult({content:[{type:'text',text:'peer started in w1:p9.'}],details:{name:'peer',pane:'w1:p9'}}, {expanded:false} as any,theme,{isPartial:false,isError:false} as any)!.render(80).join('\n');
 assert.match(text,/peer · started · w1:p9/);
});
test('running widget renders within width for long, Chinese and many names, including 0..100 columns',()=>{
 const themes=[theme,{...theme,fg:(_c:string,s:string)=>`\x1b[31m${s}\x1b[39m`}];
 for(const t of themes)for(const names of [['peer'],['a'.repeat(32),'b','c'],['研究员','reviewer','writer'],Array.from({length:16},(_,i)=>`peer-${i}`)]){
  const view=runningView(names.map((name,i)=>({name,status:i===0?'blocked':'running'})),t);
  for(let w=0;w<=100;w++){const lines=view.render(w);assert.equal(lines.length,w<4?0:names.length+2);assert.ok(lines.every(line=>visibleWidth(line)<=w),`width=${w}`);}
 }
});
test('narrow running widget preserves the total when a border fits',()=>{
 const view=runningView(['a'.repeat(32),'b','c'].map(name=>({name})),theme);
 for(const w of [4,8,9,10,12,15,16,17]){
  const text=stripVTControlCharacters(view.render(w)[0]);console.log('TINY_WAITING',w,JSON.stringify(text));
  assert.ok(text.includes('3'),`width=${w}: total 3 is hidden in ${JSON.stringify(text)}`);
 }
});
