import assert from 'node:assert/strict';
import { validate } from '../dist/validate-entry.js';

const required = {name:'inherited', params:[{name:'toString', type:'json', occurs:'1'}]};
const missing = validate(required, {});
assert.equal(missing.ok, false);
assert.equal(missing.issues[0].code, 'MISSING_REQUIRED');

const aliased = {name:'alias', params:[{name:'value', aliases:['toString'], type:'json', occurs:'1'}]};
assert.equal(validate(aliased, {}).ok, false);
assert.equal(validate(aliased, {toString: 3}).ok, true);
console.log('own property validation PASS');

for (const name of ['toString', 'hasOwnProperty']) {
  const canonical = {name:'canonical', params:[{name, type:'json', occurs:'1'}]};
  assert.equal(validate(canonical, {}).ok, false);
  assert.equal(validate(canonical, {[name]: 3}).ok, true);
  const alias = {name:'alias', params:[{name:'value', aliases:[name], type:'json', occurs:'1'}]};
  assert.equal(validate(alias, {}).ok, false);
  assert.equal(validate(alias, {value: undefined, [name]: 3}).ok, true);
  assert.equal(validate(alias, Object.create(null)).ok, false);
}
