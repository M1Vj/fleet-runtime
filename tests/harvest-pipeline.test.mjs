import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  ProxyPool,
  DynamicProxyHarvester,
  HARVEST_SOURCES,
  isPrivateOrReservedHost,
} from "../scripts/lib/indefinite-dispatcher.mjs";

test("DynamicProxyHarvester: instantiation and pool binding", () => {
  const pool = new ProxyPool(null);
  const harvester = new DynamicProxyHarvester(pool);
  assert.equal(harvester.pool, pool);
  assert.equal(harvester.isHarvesting, false);
  assert.equal(typeof harvester.triggerAutoReplenish, "function");
  assert.equal(typeof harvester.runHarvest, "function");
});

test("DynamicProxyHarvester: triggerAutoReplenish triggers on starvation and respects throttling", async () => {
  const pool = new ProxyPool(null);
  pool.loadProxiesFromLines(["http://198.51.100.1:8080"]);
  const harvester = new DynamicProxyHarvester(pool);
  pool.harvester = harvester;
  pool.triggerAutoReplenish = (r) => harvester.triggerAutoReplenish(r);

  let runHarvestCallCount = 0;
  harvester.runHarvest = async () => {
    runHarvestCallCount++;
    return 5;
  };

  // 1. Starvation trigger (healthy < 4) triggers immediately
  harvester.triggerAutoReplenish("TEST_STARVATION");
  assert.equal(runHarvestCallCount, 1);

  // 2. Immediate duplicate while harvesting is running should be skipped (zero concurrency duplicate)
  harvester.isHarvesting = true;
  harvester.harvestStartedAt = Date.now();
  harvester.triggerAutoReplenish("TEST_DUPLICATE");
  assert.equal(runHarvestCallCount, 1);

  // 3. Reset harvesting state
  harvester.isHarvesting = false;
  harvester.harvestStartedAt = null;
  harvester.lastHarvestAt = Date.now();

  // 4. Non-critical trigger (<8 but >=4) should be throttled by cooldown
  pool.loadProxiesFromLines([
    "http://198.51.100.1:8080",
    "http://198.51.100.2:8080",
    "http://198.51.100.3:8080",
    "http://198.51.100.4:8080",
    "http://198.51.100.5:8080",
  ]);
  harvester.triggerAutoReplenish("TEST_LOW_POOL");
  // Should NOT trigger because lastHarvestAt is now and cooldown is 45s for low pool
  assert.equal(runHarvestCallCount, 1);

  // 5. If simulated lastHarvestAt is older than cooldown, it triggers
  harvester.lastHarvestAt = Date.now() - 50_000;
  harvester.triggerAutoReplenish("TEST_EXPIRED_COOLDOWN");
  assert.equal(runHarvestCallCount, 2);
});

test("HARVEST_SOURCES: all 29 sources are authentic github raw content URLs", () => {
  assert.ok(Array.isArray(HARVEST_SOURCES));
  assert.equal(HARVEST_SOURCES.length, 29);
  for (const src of HARVEST_SOURCES) {
    assert.match(src, /^https:\/\/raw\.githubusercontent\.com\//);
    assert.doesNotMatch(src, /localhost|127\.0\.0\.1/);
  }
});

test("isPrivateOrReservedHost: filters SSRF and non-public endpoints", () => {
  assert.equal(isPrivateOrReservedHost("127.0.0.1"), true);
  assert.equal(isPrivateOrReservedHost("10.254.1.1"), true);
  assert.equal(isPrivateOrReservedHost("172.16.5.4"), true);
  assert.equal(isPrivateOrReservedHost("192.168.1.1"), true);
  assert.equal(isPrivateOrReservedHost("169.254.169.254"), true);
  assert.equal(isPrivateOrReservedHost("8.8.8.8"), false);
  assert.equal(isPrivateOrReservedHost("1.1.1.1"), false);
});

test("Indefinite Anti-Downgrade Invariants: presence of non-downgrade directives", () => {
  const codePath = path.resolve("scripts/lib/indefinite-dispatcher.mjs");
  const code = fs.readFileSync(codePath, "utf8");

  assert.ok(code.includes("DO NOT DOWNGRADE, REMOVE, WEAKEN, OR ABBREVIATE THIS CODE"));
  assert.ok(code.includes("CRITICAL INVARIANT: DO NOT REMOVE OR DOWNGRADE"));
  assert.ok(code.includes("FLEET DYNAMIC PROXY HARVESTER"));
  assert.ok(code.includes("ANTI-DOWNGRADE INVARIANT"));
});
