import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('every public hosted job requires explicit owner cost opt-in', () => {
  const root = new URL('../.github/workflows/', import.meta.url);
  let jobs = 0;
  for (const name of fs.readdirSync(root).filter(name => name.endsWith('.yml'))) {
    const source = fs.readFileSync(new URL(name, root), 'utf8');
    const blocks = source.split(/^  [\w-]+:\s*$/m).slice(1);
    for (const block of blocks) {
      if (!/^    runs-on:/m.test(block)) continue;
      jobs++;
      assert.match(block, /^    if: \$\{\{ vars\.FLEET_GITHUB_HOSTED_ALLOWED == 'true'(?: && [^\n]*)? \}\}$/m, name);
      assert.doesNotMatch(block.match(/^    if:.*$/m)[0], /\|\|/, `${name}: opt-in cannot be bypassed with OR`);
    }
  }
  assert.equal(jobs, 27);
});
