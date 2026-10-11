import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensure, list, remove, resolveCached } from '../dist/modules/index.js';

const root = mkdtempSync('/tmp/lmts-lifecycle-');
const spec = '@review/lifecycle';
const doc = {schema:'cli.schema.v1',tool:'rt',version:'1',
  policy:{dryrun:true,readonly:true},inputs:['json'],operations:[{name:'op',params:[]}]};
let now = new Date('2026-10-10T00:00:00Z');
const first = await ensure(spec,{root,now:()=>now,fetchImpl:async()=>new Response(JSON.stringify(doc),{status:200,headers:{etag:'v1'}})});
assert.equal(first.ok,true);
const snapshotMetaPath = join(dirname(first.value.module.path), 'meta.json');
const snapshotMeta = readFileSync(snapshotMetaPath, 'utf8');
now = new Date(now.getTime() + 7 * 3600000);
const notModified = await ensure(spec,{root,now:()=>now,fetchImpl:async()=>new Response(null,{status:304,headers:{etag:'v1'}})});
assert.equal(notModified.ok,true);
assert.equal(notModified.value.source,'network');
assert.equal(readFileSync(snapshotMetaPath, 'utf8'), snapshotMeta, '304 must preserve metadata for an existing reader snapshot');
assert.equal((await resolveCached(spec,{root})).ok,true);
assert.equal((await list({root})).some((entry)=>entry.spec==='@review/lifecycle#latest'),true);
// A failed 304 pointer commit must preserve the last verified generation.
const snapshot = notModified.value.module;
now = new Date(now.getTime() + 7 * 3600000);
const rename = fs.rename;
let faulted = false;
fs.rename = async function(from, to) {
  if (String(to).endsWith('/CURRENT')) {
    faulted = true;
    throw new Error('injected CURRENT commit failure');
  }
  return rename.call(this, from, to);
};
let failed304;
try {
  failed304 = await ensure(spec,{root,now:()=>now,fetchImpl:async()=>new Response(null,{status:304})});
} finally { fs.rename = rename; }
assert.equal(faulted, true);
assert.equal(failed304.ok, true);
assert.equal(failed304.value.source, 'stale-cache');
const preserved = await resolveCached(spec,{root});
assert.equal(preserved.ok, true);
assert.deepEqual(preserved.value, snapshot);

// A damaged pointer cannot silently fall back to another cache layout.
const currentPath = join(snapshot.dir, 'CURRENT');
const current = await fs.readFile(currentPath, 'utf8');
for (const corrupt of ['../escape', 'bad\\name', 'missing-generation']) {
  await fs.writeFile(currentPath, corrupt);
  const result = await resolveCached(spec,{root});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CACHE_CORRUPT');
}
await fs.writeFile(currentPath, current);
const removed = (await remove(spec,{root}));
assert.equal(removed.ok,true);
assert.equal(removed.value.removed.length,1);
assert.equal((await resolveCached(spec,{root})).ok,false);
console.log('cache 304/list/remove PASS');
