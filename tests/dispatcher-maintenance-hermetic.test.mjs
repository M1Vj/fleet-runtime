import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Read source as text, never import the dispatcher or start its server/harvester.
// This deliberately small, format-sensitive extraction must be reviewed when
// the maintenance block changes. VM isolation is not a hostile-code sandbox.
// Finite fake ticks do not prove process survival, successful harvesting,
// real scheduling, or deployed indefinite useful work.
const source = readFileSync(new URL('../scripts/lib/indefinite-dispatcher.mjs', import.meta.url), 'utf8');
const matches = [...source.matchAll(/^  const pruneInterval = setInterval\(\(\) => \{\n([\s\S]*?)^  if \(pruneInterval\.unref\) pruneInterval\.unref\(\);/gm)];
assert.equal(matches.length, 1, 'unique maintenance block');
const block = matches[0][0];
// Fail closed before evaluating source: only this reviewed statement shape is
// admitted, not surrounding startup, networking, cleanup or module code.
assert.match(block, /^  const pruneInterval = setInterval\(\(\) => \{\n    try \{\n      pool\.pruneDeadProxies\(\);\n      if \(pool\.getHealthyProxies\(\)\.length < 8\) \{\n        harvester\.triggerAutoReplenish\("PRUNE_INTERVAL_DEGRADED"\);\n      \}\n    \} catch \{\}\n  \}, 30000\);\n  if \(pruneInterval\.unref\) pruneInterval\.unref\(\);$/);

function simulate({ healthy = [7, 8, 0], failAt = [] } = {}, code = block) {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  context.inputJSON = JSON.stringify({ healthy, failAt });
  // Every callable double is created inside the realm. Only JSON crosses it.
  new vm.Script(`
    'use strict';
    const input = JSON.parse(inputJSON);
    let now = 0, tick = 0, prune = 0, unrefs = 0;
    const calls = [], registrations = [], snapshots = [];
    const register = (fn, delay, repeat) => {
      if (typeof fn !== 'function' || delay !== 30000) throw Error('fixture registration');
      registrations.push({ fn, delay, repeat, next: now + delay, active: true });
      return { unref() { unrefs++; } };
    };
    const setInterval = (fn, delay) => register(fn, delay, true);
    const setTimeout = (fn, delay) => register(fn, delay, false);
    const pool = {
      pruneDeadProxies() { prune++; if (input.failAt.includes(tick)) throw Error('fixture prune failure'); },
      getHealthyProxies() { return Array(input.healthy[tick - 1]).fill(null); }
    };
    const harvester = { triggerAutoReplenish(reason) { calls.push({ tick, reason }); } };
    ${code}
    const advance = () => {
      tick++; now += 30000;
      let thrown = null;
      for (const r of registrations) {
        if (!r.active || r.next > now) continue;
        if (r.repeat) r.next += r.delay; else r.active = false;
        try { r.fn(); } catch (error) { thrown = String(error.message); }
      }
      snapshots.push({ tick, prune, calls: calls.slice(), thrown });
    };
  `).runInContext(context, { timeout: 100 });
  for (let i = 0; i < healthy.length; i++) {
    new vm.Script('advance();').runInContext(context, { timeout: 100 });
  }
  return JSON.parse(new vm.Script(`JSON.stringify({ snapshots, unrefs,
    registrations: registrations.map(({delay, repeat}) => ({delay, repeat})),
    processType: typeof process, fetchType: typeof fetch })`).runInContext(context, { timeout: 100 }));
}

function verify(result, healthy, failAt = []) {
  assert.equal(result.registrations.length, 1, 'one registration');
  assert.equal(result.registrations[0].delay, 30000, 'maintenance cadence');
  assert.equal(result.unrefs, 1, 'existing unref policy');
  const expected = [];
  for (let i = 0; i < healthy.length; i++) {
    const s = result.snapshots[i], tick = i + 1;
    assert.equal(s.thrown, null, 'MAINTENANCE_CAUGHT_FAILURE');
    assert.equal(s.prune, tick, 'MAINTENANCE_PRUNE_COUNT');
    if (!failAt.includes(tick) && healthy[i] < 8) expected.push({ tick, reason: 'PRUNE_INTERVAL_DEGRADED' });
    assert.deepEqual(s.calls, expected, 'MAINTENANCE_REPLENISH_CALLS');
  }
}

test('maintenance recurs across degraded and healthy threshold transitions', () => {
  const healthy = [7, 8, 0, 9, 7, 8];
  const result = simulate({ healthy });
  verify(result, healthy);
  assert.equal(result.processType, 'undefined');
  assert.equal(result.fetchType, 'undefined');
});

test('a failed prune cycle does not prevent later healthy and degraded cycles', () => {
  const healthy = [0, 9, 7, 8, 0], failAt = [1, 4];
  verify(simulate({ healthy, failAt }), healthy, failAt);
});

test('maintenance continues over additional finite simulated intervals', () => {
  const healthy = Array.from({ length: 100 }, (_, i) => i % 2 ? 8 : 7);
  verify(simulate({ healthy }), healthy);
});

// Mutate only the validated extracted statement, never production source.
// Compilation/evaluation happens before the expected assertion failure, so a
// syntax/ReferenceError cannot masquerade as a successful negative control.
test('negative control: one-shot scheduling fails repeated-prune oracle', () => {
  const healthy = [7, 8, 0];
  const result = simulate({ healthy }, block.replace('setInterval(', 'setTimeout('));
  assert.throws(() => verify(result, healthy), /MAINTENANCE_PRUNE_COUNT/);
});

test('negative control: omitted replenishment fails degraded-pool oracle', () => {
  const healthy = [7, 8, 0];
  const result = simulate({ healthy }, block.replace('harvester.triggerAutoReplenish("PRUNE_INTERVAL_DEGRADED");', 'void 0;'));
  assert.throws(() => verify(result, healthy), /MAINTENANCE_REPLENISH_CALLS/);
});

test('negative control: removed catch fails caught-cycle oracle', () => {
  const healthy = [0, 9, 7], failAt = [1];
  const mutant = block.replace('    try {\n', '').replace('    } catch {}\n', '');
  const result = simulate({ healthy, failAt }, mutant);
  assert.equal(result.snapshots[0].thrown, 'fixture prune failure');
  assert.throws(() => verify(result, healthy, failAt), /MAINTENANCE_CAUGHT_FAILURE/);
});

test('negative control: stopping work after first callback fails later-prune oracle', () => {
  const healthy = [7, 8, 0];
  const mutant = 'let fixtureInvocations = 0;\n' + block.replace('    try {', '    if (++fixtureInvocations > 1) return;\n    try {');
  const result = simulate({ healthy }, mutant);
  assert.throws(() => verify(result, healthy), /MAINTENANCE_PRUNE_COUNT/);
});
