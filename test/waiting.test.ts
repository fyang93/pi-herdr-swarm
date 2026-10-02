import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stripVTControlCharacters} from 'node:util';
import {initTheme} from '@earendil-works/pi-coding-agent';
import {waitingView,spawnResult} from '../src/ui.ts';
import {visibleWidth} from '@earendil-works/pi-tui';
initTheme('dark',false);
const theme:any={fg:(_c:string,s:string)=>s,bg:(_c:string,s:string)=>s,bold:(s:string)=>s};
test('a legal long name preserves the count of other peers on narrow panes',()=>{
 const text=stripVTControlCharacters(waitingView(['a'.repeat(32),'b','c'],new Map(),theme).render(40)[0]);
 console.log('LONG_NAME_WIDGET',JSON.stringify(text));
 assert.match(text,/\(\+2\)$/);assert.ok(visibleWidth(text)<=40);
});
test('detached spawn rendering no longer says board only',()=>{
 const text=spawnResult({content:[{type:'text',text:'peer started in w1:p9. Detached.'}],details:{name:'peer',pane:'w1:p9',detached:true}}, {expanded:false} as any,theme,{isPartial:false,isError:false} as any)!.render(80).join('\n');
 console.log('DETACHED_RENDERING',text);assert.match(text,/detached/);assert.doesNotMatch(text,/board only/);
});
test('waiting renders within width for long, Chinese and many names, including 0..100 columns',()=>{
 const themes=[theme,{...theme,fg:(_c:string,s:string)=>`\x1b[31m${s}\x1b[39m`}];
 for(const t of themes)for(const names of [['peer'],['a'.repeat(32),'b','c'],['研究员','reviewer','writer'],Array.from({length:16},(_,i)=>`peer-${i}`)]){
  const view=waitingView(names,new Map([[names[0],'blocked']]),t);
  for(let w=0;w<=100;w++){const lines=view.render(w);assert.equal(lines.length,w===0?0:1);assert.ok(lines.every(line=>visibleWidth(line)<=w),`width=${w}`);}
 }
});
test('very narrow waiting fallback must preserve the total when its digits fit',()=>{
 const view=waitingView(['a'.repeat(32),'b','c'],new Map(),theme);
 for(const w of [1,2,4,8,9,10,12,15,16,17]){
  const text=stripVTControlCharacters(view.render(w)[0]);console.log('TINY_WAITING',w,JSON.stringify(text));
  assert.ok(text.includes('3'),`width=${w}: total 3 is hidden in ${JSON.stringify(text)}`);
 }
});
