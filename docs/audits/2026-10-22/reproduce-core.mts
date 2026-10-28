// Diagnostic reproduction: assertions confirm the audited defect exists.
// Run from the repository root with node --import tsx docs/audits/2026-10-22/reproduce-core.mts
import assert from 'node:assert/strict';
import { randomSalt } from '../../../packages/crypto/src/index.ts';
import { scriptedModel } from '../../../packages/llm/src/index.ts';
import { redactText } from '../../../packages/redact/src/index.ts';
import { compile } from '../../../packages/shield/src/index.ts';
import { RelayClient, memoryPendingStore } from '../../../packages/inference/src/index.ts';
import { createRelay, memoryResponseStore } from '../../../packages/relay-core/src/index.ts';
import { directTransport } from '../../../packages/tor/src/index.ts';
import { generateMintKeys, memoryProofStore, memorySpentStore, Mint, Wallet } from '../../../packages/wallet/src/index.ts';
import { fixedRate, simulatedWatcher } from '../../../packages/zcash/src/index.ts';
import { Ledger } from '../../../packages/ledger/src/index.ts';
import { createDaemon } from '../../../apps/daemon/src/api.ts';
import { runResearch } from '../../../apps/daemon/src/research.ts';

const proofResults: object[] = [];
const add = (id: string, evidence: object) => proofResults.push({ id, ...evidence });
const MODEL = 'audit-cloud';
const price = {model: MODEL,inputPerMTok:360000,outputPerMTok:1080000};
const local = (overrides: { entities?: object[], pieces?: string[], decoys?: string[] }={}) => scriptedModel((m) => {
  const sys=m[0]!.content;
  if (sys.includes('identifying details')) return JSON.stringify({entities: overrides.entities??[]});
  if (sys.includes('say what it names')) return JSON.stringify({items:[]});
  if (sys.includes('general kind')) return JSON.stringify({hints:{}});
  if (sys.includes("the user's request")) return JSON.stringify({pieces:overrides.pieces??['How should reporters document intimidation?']});
  if (sys.includes('You are an AI provider')) return JSON.stringify({score:0,inferences:[]});
  if (sys.includes('different people might ask')) return JSON.stringify({decoys:overrides.decoys??['Which trees tolerate salt spray along coasts?']});
  return 'local answer';
}, 'audit-local');
function setup(options: {now?:()=>number, responseStore?: any, upstream?: any, intercept?: (url:string,res:Response)=>Promise<Response>, pending?:any, store?:any}={}) {
  const mint=new Mint(generateMintKeys(),memorySpentStore());
  const watcher=simulatedWatcher(fixedRate(50));
  const upstream=options.upstream??scriptedModel(()=> 'an answer');
  const handler=createRelay({mint, watcher,models:new Map([[MODEL,{upstream,price}]]),searchPrice:1000,responses:options.responseStore??memoryResponseStore(15*60*1000,options.now)});
  const wallet=new Wallet(options.store??memoryProofStore());
  const transport=directTransport(async(url,init)=> {
    const res=await handler(new Request(url,init));
    return options.intercept?options.intercept(url,res):res;
  });
  const client=new RelayClient({baseUrl:'http://relay.test',transport,wallet,...(options.pending?{pending:options.pending}:{})});
  const fund=async(credits:number)=>{
    const q=await client.quote(credits);
    watcher.simulatePayment(q.quoteId);
    await client.redeemTopup(q);
  };
  return {mint,watcher,upstream,handler,wallet,client,transport,fund};
}
const messages=[{role:'user' as const,content:'What is the answer?'}];

for (const name of ['ada obi','张伟']) {
  const r=await redactText(local({entities:[{text:name,kind:'person'}]}),`is ${name} at risk?`,[]);
  assert.equal(r.table.length,0);
  assert.ok(r.text.includes(name));
  add('R1-redaction-rejects-correct-name',{name,text:r.text,table:r.table});
}
{
  const p=await compile(local({decoys:['Where can tourists buy train tickets in Lagos?']}),{task:'How should reporters document intimidation?',table:[{original:'Lagos',placeholder:'[PLACE_1]',kind:'place',hint:'a city'}],level:'private',salt:randomSalt()});
  const leaked=p.pieces.find(p=>p.role==='decoy'&&p.messages.some(m=>m.content.includes('Lagos')));
  assert.ok(leaked);
  add('R2-decoy-bypasses-leak-floor',{leakedPiece:leaked});
}
{
  const s=setup(); await s.fund(1000000);
  const ledger=new Ledger();
  const daemon=createDaemon({local:local(),relay:s.client,ledger,wallet:s.wallet,transport:s.transport,syncUrl:'http://sync.test',torState:()=>({ready:true,progress:100}),localModelOk:async()=>true,allowedOrigins:[],localApiKey:'audit'});
  const r=await daemon(new Request('http://127.0.0.1:7878/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer audit','content-type':'application/json'},body:JSON.stringify({model:'zireh/local',messages:[{role:'user',content:'Keep this only on my computer.'}]})}));
  const body=await r.json(); assert.equal(r.status,200); assert.equal(body.model,'zireh/standard'); assert.equal(s.upstream.calls.length,1);
  add('R3-local-model-routes-to-cloud',{status:r.status,responseModel:body.model,cloudCalls:s.upstream.calls.length});
}
{
  let now=0; let drop=true;
  const s=setup({now:()=>now,intercept:async(url,res)=>{if(url.endsWith('/chat')&&drop){drop=false;throw Error('lost response');}return res;}});
  await s.fund(1000000); const c=await s.client.prepareChat(MODEL,messages,100);
  try{await s.client.send(c);}catch{}
  const before=s.wallet.balance; now=16*60*1000;
  const r=await s.client.recover(); assert.equal(r.failed[0]!.code,'token_spent'); assert.equal(s.client.pending.list().length,0);
  add('R4-expired-recovery-loses-payment',{initialBalance:1000000,balanceBeforeRecovery:before,balanceAfterRecovery:s.wallet.balance,error:r.failed[0]!.code,pending:s.client.pending.list().length,paidCoins:c.proofs.reduce((n,p)=>n+p.amount,0)});
}
{
  let drop=true; const s=setup({intercept:async(url,res)=>{if(url.endsWith('/topup/mint')&&drop){drop=false;throw Error('lost mint reply');}return res;}});
  const quote=await s.client.quote(1000000); s.watcher.simulatePayment(quote.quoteId);
  try{await s.client.redeemTopup(quote);}catch{}
  let failure=''; try{await s.client.redeemTopup(quote);}catch(e){failure=(e as any).code;}
  assert.equal(failure,'quote_unpaid'); assert.equal(s.wallet.balance,0);
  add('R5-topup-response-loss',{balance:s.wallet.balance,quoteState:s.watcher.state(quote.quoteId),retryError:failure,pending:s.client.pending.list().length});
}
{
  const s=setup({intercept:async(url,res)=>{if(!url.endsWith('/chat'))return res;const b=await res.json();b.settlement.change=[];return Response.json(b);}});
  await s.fund(1000000); const c=await s.client.prepareChat(MODEL,messages,100); const r=await s.client.send(c);
  assert.equal(r.kind,'chat'); if(r.kind!=='chat')throw Error(); assert.equal(r.bill.overcharged,false); assert.ok(1000000-s.wallet.balance>r.charged);
  add('R6-missing-change-passes-bill-audit',{reportedCharge:r.charged,actualBalanceReduction:1000000-s.wallet.balance,audit:r.bill});
}
{
  const s=setup({upstream:scriptedModel(()=>{throw Error('upstream failed after receiving prompt');})}); await s.fund(1000000); const ledger=new Ledger(); const events:any[]=[];
  try{await runResearch({local:local(),relay:s.client,ledger,wallet:s.wallet},{task:'How should reporters document intimidation?',context:[],level:'standard',table:[],salt:randomSalt(),model:MODEL},e=>events.push(e));}catch{}
  assert.equal(s.upstream.calls.length,1); assert.equal(ledger.receipts().length,0);
  add('R7-failed-call-absent-from-log',{cloudCalls:s.upstream.calls.length,receipts:ledger.receipts().length,events:events.filter(e=>e.type==='piece')});
}
{
  const pending=memoryPendingStore();let failSave=false;const s=setup({pending:{...pending,save(c:any){if(failSave)throw Error('pending write failed');pending.save(c);}}}); await s.fund(1048576); failSave=true;
  try{await s.client.prepareChat(MODEL,messages,100);}catch{}
  assert.equal(s.wallet.balance,0);assert.equal(pending.list().length,0);
  add('R8-prepare-crash-gap',{initialBalance:1048576,balance:s.wallet.balance,pending:pending.list().length});
}
{
  const s=setup({upstream:scriptedModel(async()=>{await new Promise(r=>setTimeout(r,25));return 'answer';})});await s.fund(1048576);const ledger=new Ledger();let error='';
  try{await runResearch({local:local(),relay:s.client,ledger,wallet:s.wallet},{task:'How should reporters document intimidation?',context:[],level:'private',table:[],salt:randomSalt(),model:MODEL},()=>{});}catch(e){error=(e as Error).message;}
  await new Promise(r=>setTimeout(r,80));assert.ok(error.includes('have 0'));assert.equal(s.upstream.calls.length,1);
  add('R9-denominations-break-concurrent-plan',{initialBalance:1048576,error,cloudCalls:s.upstream.calls.length,receipts:ledger.receipts().length,balance:s.wallet.balance});
}
console.log(JSON.stringify(proofResults,null,2));
