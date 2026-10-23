import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Do not import private-state/model: their dependency graph is outside this
// filtering regression. Extract only the literal allowlist and named functions.
// Extraction is format-sensitive. Review these boundaries when functions change;
// this fixture is not a general JavaScript parser or a hostile-code sandbox.
const source = readFileSync(new URL('../scripts/lib/private-state.mjs', import.meta.url), 'utf8');
function oneMatch(pattern, label) {
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `exactly one ${label}`);
  return matches[0][1];
}
const listText = oneMatch(/^const PUBLIC_CHILD_ENV_KEYS = new Set\(\[([\s\S]*?)^\]\);/gm, 'public allowlist');
const keys = JSON.parse(`[${listText.replace(/,\s*$/, '')}]`);
assert.ok(Array.isArray(keys) && keys.every(key => typeof key === 'string'));
const functions = ['boundedPublicEnvValue', 'publicChildEnv', 'publicModelEnv'].map(name =>
  oneMatch(new RegExp(`^(?:export )?(function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\})`, 'gm'), name));
const fixturePrelude = `
  'use strict';
  const process = Object.freeze({env:Object.freeze({})});
  const PUBLIC_DATA_CLASS='public', DEFAULT_PUBLIC_OWNER='M1Vj';
  const publicStateRoot=()=>'/fixture/state';
  const publicEphemeralDirectories=()=>({state:'/fixture/state',runner:'/fixture',home:'/fixture/home',config:'/fixture/config',data:'/fixture/data',cache:'/fixture/cache',tmp:'/fixture/tmp'});
  const publicRepository=env=>{if(env.FLEET_PUBLIC_REPOSITORY!=='M1Vj/public-repo')throw Error('fixture-public-target');return env.FLEET_PUBLIC_REPOSITORY;};
  const resolveArtifactManifest=()=>'/fixture/artifact.json';
`;
function filter(env, allowlist = keys) {
  const context = vm.createContext(Object.create(null), {codeGeneration:{strings:false,wasm:false}});
  context.inputJSON = JSON.stringify(env);
  const code = `${fixturePrelude}\nconst PUBLIC_CHILD_ENV_KEYS=new Set(${JSON.stringify(allowlist)});\n${functions.join('\n')}\nJSON.stringify(publicModelEnv(JSON.parse(inputJSON)));`;
  return JSON.parse(new vm.Script(code).runInContext(context,{timeout:1000}));
}
const seed={FLEET_DATA_CLASS:'public',FLEET_PUBLIC_REPOSITORY:'M1Vj/public-repo',PATH:'/fixture/bin'};

test('public model environment preserves explicit dispatcher suppression',()=>{
  assert.equal(keys.filter(key=>key==='FLEET_INDEFINITE_DISABLE').length,1);
  assert.equal(filter({...seed,FLEET_INDEFINITE_DISABLE:'1'}).FLEET_INDEFINITE_DISABLE,'1');
});
test('control case reproduces loss without the allowlist entry',()=>{
  const without=keys.filter(key=>key!=='FLEET_INDEFINITE_DISABLE');
  assert.equal(filter({...seed,FLEET_INDEFINITE_DISABLE:'1'},without).FLEET_INDEFINITE_DISABLE,undefined);
});
test('model credential and private-variable exclusions remain intact',()=>{
  const excluded=['GH_TOKEN','GITHUB_TOKEN','FLEET_GH_TOKEN','FLEET_READ_TOKEN','FLEET_OPENCODE_AUTH','FLEET_OPENCODE_AUTH_2','OPENCODE_AUTH_CONTENT','OPENCODE_API_KEY','NODE_OPTIONS','NODE_PATH','GITHUB_WORKSPACE','ARBITRARY_PRIVATE'];
  const result=filter({...seed,FLEET_INDEFINITE_DISABLE:'1',...Object.fromEntries(excluded.map(key=>[key,'fixture-not-a-secret']))});
  for(const key of excluded)assert.equal(Object.hasOwn(result,key),false,key);
});
test('invalid disable values retain bounded filtering',()=>{
  for(const value of [undefined,null,'','1\n','1\0','1\u007f','1'.repeat(4097)])assert.equal(Object.hasOwn(filter({...seed,FLEET_INDEFINITE_DISABLE:value}),'FLEET_INDEFINITE_DISABLE'),false);
});
test('bounded scalar values are preserved without inventing suppression',()=>{
  for(const value of ['0','false',1,false,'1'.repeat(4096)])assert.equal(filter({...seed,FLEET_INDEFINITE_DISABLE:value}).FLEET_INDEFINITE_DISABLE,String(value));
  assert.deepEqual(filter(seed),filter(seed,keys.filter(key=>key!=='FLEET_INDEFINITE_DISABLE')));
});
test('inert public helper boundary remains in force',()=>{
  const result=filter({...seed,HOME:'/private',FLEET_STATE_ROOT:'/private-state'});
  assert.equal(result.HOME,'/fixture/home');
  assert.equal(result.FLEET_STATE_ROOT,'/fixture/state');
  assert.throws(()=>filter({FLEET_INDEFINITE_DISABLE:'1'}),/fixture-public-target/);
});
