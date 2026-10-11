import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { ensure, resolveCached } from '../dist/modules/index.js';

const root = mkdtempSync('/tmp/lmts-race-');
const spec = '@review/race';
let now = new Date('2026-10-10T00:00:00Z');
const doc = (v) => ({schema:'cli.schema.v1',tool:'rt',version:v,
  policy:{dryrun:true,readonly:true},inputs:['json'],operations:[{name:'op',params:[]}]});
const fetchDoc = (v) => async () => new Response(JSON.stringify(doc(v)), {
  status:200, headers:{etag:`v${v}`},
});
assert.equal((await ensure(spec,{root,now:()=>now,fetchImpl:fetchDoc('1')})).ok,true);
now = new Date(now.getTime() + 7 * 3600000);
let stop = false;
let bad = 0;
const readers = Array.from({length:8}, async () => {
  while (!stop) {
    const result = await resolveCached(spec,{root});
    if (!result.ok || !['1','2','3'].includes(result.value.version)) bad++;
  }
});
await Promise.all(Array.from({length:20}, (_, i) => ensure(spec, {
  root, now:()=>now, fetchImpl:fetchDoc(String(2 + (i % 2))),
})));
stop = true;
await Promise.all(readers);
assert.equal(bad, 0);
assert.equal((await resolveCached(spec,{root})).ok, true);
console.log('cache reader/writer race PASS', {readers:8,writers:20,bad});
