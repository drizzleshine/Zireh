// Diagnostic reproduction: assertions confirm the audited defect exists.
// Run from the repository root with node --import tsx docs/audits/2026-10-22/reproduce-privacy.mts
import assert from 'node:assert/strict';
import {randomSalt,generateCaseKey} from '../../../packages/crypto/src/index.ts';
import {scriptedModel} from '../../../packages/llm/src/index.ts';
import {RelayClient} from '../../../packages/inference/src/index.ts';
import {createRelay,memoryResponseStore} from '../../../packages/relay-core/src/index.ts';
import {directTransport} from '../../../packages/tor/src/index.ts';
import {generateMintKeys,memorySpentStore,memoryProofStore,Mint,Wallet} from '../../../packages/wallet/src/index.ts';
import {fixedRate,simulatedWatcher} from '../../../packages/zcash/src/index.ts';
import {Ledger} from '../../../packages/ledger/src/index.ts';
import {createDaemon} from '../../../apps/daemon/src/api.ts';
import {newMember,newCase,newEvidence,newObservation,newFinding,newConclusion,buildPublication} from '../../../packages/cases/src/index.ts';
import {sealRecord,openRecord} from '../../../packages/sync/src/index.ts';

const results=[];
{
 let release:any;const waiting=new Promise<void>(r=>release=r);let first=true;
 const local=scriptedModel(async m=>{
  if(first){first=false;await waiting;}
  const sys=m[0]!.content;
  if(sys.includes('identifying details'))return '{"entities":[]}';
  if(sys.includes('say what it names'))return '{"items":[]}';
  if(sys.includes('general kind'))return '{"hints":{}}';
  if(sys.includes("the user's request"))return '{"pieces":["How can reporters document intimidation?"]}';
  if(sys.includes('You are an AI provider'))return '{"score":0,"inferences":[]}';
  return 'answer';
 });
 const upstream=scriptedModel(()=> 'cloud answer');const watcher=simulatedWatcher(fixedRate(50));const model='audit';const price={model,inputPerMTok:360000,outputPerMTok:1080000};
 const relayHost=createRelay({mint:new Mint(generateMintKeys(),memorySpentStore()),watcher,models:new Map([[model,{upstream,price}]]),searchPrice:1000,responses:memoryResponseStore()});
 const transport=directTransport((url,init)=>relayHost(new Request(url,init)));const wallet=new Wallet(memoryProofStore());const relay=new RelayClient({baseUrl:'http://relay.test',transport,wallet});
 const quote=await relay.quote(1000000);watcher.simulatePayment(quote.quoteId);await relay.redeemTopup(quote);const ledger=new Ledger();
 const daemon=createDaemon({local,relay,ledger,wallet,transport,syncUrl:'http://sync.test',torState:()=>({ready:true,progress:100}),localModelOk:async()=>true,allowedOrigins:[],localApiKey:'audit'});
 const response=await daemon(new Request('http://127.0.0.1:7878/api/research',{method:'POST',headers:{'x-zireh':'1','content-type':'application/json'},body:JSON.stringify({task:'How can reporters document intimidation?',level:'standard',salt:randomSalt()})}));
 void response.body!.cancel(); // user presses Stop while the first redaction step is pending
 assert.equal(upstream.calls.length,0);release();await new Promise(r=>setTimeout(r,100));assert.equal(upstream.calls.length,1);
 results.push({id:'X1-stop-before-send-still-sends',cloudCallsAfterStop:upstream.calls.length,receipts:ledger.receipts().length});
}
{
 const member=newMember('Team');const c=newCase({title:'Case',question:'What happened?',privacy:'private',createdBy:member.id});
 const e=newEvidence(c.id,member.id,{kind:'note',title:'Confidential interview with Ada Obi',body:'A generic account.'});
 const o=newObservation(c.id,{kind:'member',memberId:member.id},{text:'The dates agree.',evidenceIds:[e.id]});
 const f=newFinding(c.id,member.id,{statement:'The records agree.',observationIds:[o.id],uncertainty:''});
 const conclusion=newConclusion(c.id,member.id,undefined,{outcome:'resolved',summary:'The records agree.',findingIds:[f.id],openQuestion:''});
 const rec={case:c,members:[member],evidence:[e],observations:[o],findings:[f],reviews:[],pseudonyms:[],comments:[],links:[],board:{},conclusions:[conclusion]};
 const pub=buildPublication(rec,{hideNames:false}).publication;
 const scanTexts=[pub.title,pub.question,pub.conclusion?.summary??'',pub.conclusion?.openQuestion??'',...pub.findings.flatMap(f=>[f.statement,f.uncertainty,...f.observations.map(o=>o.text)])];
 assert.ok(!scanTexts.join(' ').includes('Ada Obi'));
 const hidden=buildPublication(rec,{hideNames:true}).publication;
 assert.ok(JSON.stringify(hidden).includes('Ada Obi'));
 results.push({id:'X2-publish-scan-omits-evidence-title',scanInputContainsName:false,namesHidden:hidden.namesHidden,exportedEvidenceTitle:hidden.findings[0]!.observations[0]!.evidence[0]!.title});
 const key=generateCaseKey();const old=await sealRecord(key,'observations',{...o,status:'draft'});const accepted=await sealRecord(key,'observations',{...o,status:'accepted'});
 const last=[await openRecord(key,old),await openRecord(key,accepted),await openRecord(key,old)].at(-1)!;
 assert.equal((last.record as any).status,'draft');results.push({id:'X3-old-ciphertext-replay-is-valid',lastStatus:(last.record as any).status});
}
console.log(JSON.stringify(results,null,2));
