// Isolated store tests use cloned in-memory IndexedDB values and mocked API/hooks.
// They exercise the actual bundled store implementation. The browser board check was separate.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const bundlePath=join(mkdtempSync(join(tmpdir(),'zireh-store-audit-')),'store.mjs');
const bundleUrl=pathToFileURL(bundlePath).href;
const require=createRequire(`${root}/package.json`);
const {build}=createRequire(require.resolve('tsx'))('esbuild');
await build({entryPoints:[`${root}/apps/web/src/store.ts`],outfile:bundlePath,bundle:true,format:'esm',platform:'node',plugins:[{name:'audit-stubs',setup(b:any){
 b.onResolve({filter:/^(idb-keyval|react)$/},(a:any)=>({path:a.path,namespace:'audit'}));
 b.onResolve({filter:/^\.\/api\.ts$/},()=>({path:'api',namespace:'audit'}));
 b.onLoad({filter:/.*/,namespace:'audit'},(a:any)=>({contents:a.path==='idb-keyval'?`export const get=async k=>structuredClone(globalThis.__storeAudit.db.get(k)); export const set=async(k,v)=>{globalThis.__storeAudit.db.set(k,structuredClone(v));};`:a.path==='react'?`export const useRef=v=>({current:v});export const useSyncExternalStore=(subscribe,snapshot)=>{const initial=snapshot();globalThis.__storeAudit.selectors.push({snapshot,initial});return initial;};`:`export const api=globalThis.__storeAudit.api;` }));
}}]});
const g:any=globalThis;g.__storeAudit={db:new Map(),selectors:[],api:{push:async()=>{throw Error('offline');},pull:async()=>{throw Error('offline');}}};
const a=await import(`${bundleUrl}?a`);await a.load();
const id=await a.createCase({title:'Disposable audit case',question:'How does sync behave?',privacy:'private',memberName:'Tester'});await a.syncCase(id);
const recA=a.useStore((s:any)=>s.cases[id]);
const b=await import(`${bundleUrl}?b`);await b.load();
const makeEvidence=(title:string)=>({id:crypto.randomUUID().replaceAll('-',''),caseId:id,kind:'note',title,body:'audit',sha256:'a'.repeat(64),addedBy:a.myMemberId(id),addedAt:new Date().toISOString()});
const evA=makeEvidence('Only tab A holds this evidence');await a.save(id,'evidence',evA);await a.syncCase(id);
const selector=g.__storeAudit.selectors[0];assert.equal(Object.is(selector.initial,selector.snapshot()),true);
const evB=makeEvidence('Added in tab B');await b.save(id,'evidence',evB);await b.syncCase(id);
const reloaded=await import(`${bundleUrl}?reloaded`);await reloaded.load();
const persisted=reloaded.useStore((s:any)=>s.cases[id]);
assert.deepEqual(persisted.evidence.map((e:any)=>e.title),['Added in tab B']);
const outbox=g.__storeAudit.db.get('workspaces')[0].outbox;
assert.ok(!outbox.some((e:any)=>e.id===evA.id));
console.log(JSON.stringify({id:'S1-two-tabs-lose-offline-evidence',tabAEvidence:recA.evidence.map((e:any)=>e.title),persistedEvidence:persisted.evidence.map((e:any)=>e.title),tabAEnvelopeSurvived:outbox.some((e:any)=>e.id===evA.id),id2:'S2-unchanged-selected-store-reference',sameSnapshot:Object.is(selector.initial,selector.snapshot())},null,2));

// A host can replay a previously valid revision as a new append-only entry.
const {newMember,newCase,newObservation}=await import('../../../packages/cases/src/index.ts');
const {generateCaseKey}=await import('../../../packages/crypto/src/index.ts');
const {sealRecord}=await import('../../../packages/sync/src/index.ts');
const member=newMember('Tester');const c=newCase({title:'Replay audit',question:'Can old data reappear?',privacy:'private',createdBy:member.id});const key=generateCaseKey();
const observation=newObservation(c.id,{kind:'ai',runId:'a'.repeat(32),requestedBy:member.id},{text:'An AI draft.',evidenceIds:[]});
const caseEnv=await sealRecord(key,'cases',c);const draftEnv=await sealRecord(key,'observations',observation);const acceptedEnv=await sealRecord(key,'observations',{...observation,status:'accepted'});
const log:any[]=[caseEnv,draftEnv,acceptedEnv];const db=new Map();db.set('workspaces',[{caseId:c.id,caseKey:key,memberId:member.id,cursor:0,outbox:[]}]);
g.__storeAudit={db,selectors:[],api:{push:async()=>({cursor:log.length}),pull:async(_id:any,_token:any,after:any)=>({records:log.map((e,i)=>({...e,seq:i+1})).filter(e=>e.seq>after),cursor:log.length,head:log.length})}};
const replayStore=await import(`${bundleUrl}?replay`);await replayStore.load();await replayStore.syncCase(c.id);const beforeReplay=replayStore.useStore((s:any)=>s.cases[c.id]).observations[0].status;
log.push(draftEnv);await replayStore.syncCase(c.id);const afterReplay=replayStore.useStore((s:any)=>s.cases[c.id]).observations[0].status;
assert.equal(beforeReplay,'accepted');assert.equal(afterReplay,'draft');
console.log(JSON.stringify({id:'S3-host-replay-rolls-back-accepted-observation',beforeReplay,afterReplay},null,2));
