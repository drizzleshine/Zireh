// Diagnostic reproduction: assertions confirm the audited defect exists.
// Run from the repository root with node --import tsx docs/audits/2026-10-22/reproduce-sync-size.mts
import assert from 'node:assert/strict';
import {createSyncHost,openHostDb} from '../../../apps/sync-host/src/host.ts';
import {newCase,newEvidence,newMember,caseToken} from '../../../packages/cases/src/index.ts';
import {generateCaseKey} from '../../../packages/crypto/src/index.ts';
import {sealRecord} from '../../../packages/sync/src/index.ts';
const host=createSyncHost(openHostDb(':memory:'));const key=generateCaseKey();const member=newMember('Tester');const c=newCase({title:'Size test',question:'Can queued evidence sync?',privacy:'private',createdBy:member.id});
const records=await Promise.all([1,2].map(i=>sealRecord(key,'evidence',newEvidence(c.id,member.id,{kind:'document',title:`Offline document ${i}`,body:'a'.repeat(1600000)}))));
const push=async(rows:any[])=>host(new Request(`http://sync.test/v1/cases/${c.id}/records`,{method:'POST',headers:{'x-case-token':caseToken(key),'content-type':'application/json'},body:JSON.stringify({records:rows})}));
const together=await push(records);const single=await push([records[0]!]);assert.equal(together.status,413);assert.equal(single.status,200);
console.log(JSON.stringify({id:'Y1-count-batched-outbox-exceeds-host-limit',records:records.length,batchBytes:Buffer.byteLength(JSON.stringify({records})),batchStatus:together.status,singleStatus:single.status},null,2));
