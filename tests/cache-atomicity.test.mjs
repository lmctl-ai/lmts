import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, readFileSync } from 'node:fs';
import { ensure, resolveCached } from '../dist/modules/index.js';

const root = mkdtempSync('/tmp/lmts-cache-');
const spec = '@review/tool';
let now = new Date('2026-10-10T00:00:00Z');
const doc = (v) => ({ schema:'cli.schema.v1', tool:'rt', version:v,
  policy:{dryrun:true,readonly:true}, inputs:['json'],
  operations:[{name:v === '1' ? 'old' : 'newop', params:[]}] });
const fetchDoc = (v) => async () => new Response(JSON.stringify(doc(v)), {
  status:200, headers:{etag:`v${v}`},
});

assert.equal((await ensure(spec, {root, now:()=>now, fetchImpl:fetchDoc('1')})).ok, true);
now = new Date(now.getTime() + 7 * 3600000);
const rename = fs.rename;
let faulted = false;
fs.rename = async function(from, to) {
  if (String(to).endsWith('/meta.json')) {
    faulted = true;
    throw Object.assign(new Error('injected metadata commit failure'), {code:'EIO'});
  }
  return rename.call(this, from, to);
};
let refreshed;
try { refreshed = await ensure(spec, {root, now:()=>now, fetchImpl:fetchDoc('2')}); }
finally { fs.rename = rename; }

assert.equal(faulted, true);
assert.equal(refreshed.ok, true);
assert.equal(refreshed.value.source, 'stale-cache');
const cached = await resolveCached(spec, {root});
assert.equal(cached.ok, true);
assert.equal(cached.value.version, '1');
assert.equal(JSON.parse(readFileSync(cached.value.path, 'utf8')).version, '1');
console.log('cache atomicity PASS');
