import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocate,
  compareRegionId,
  RULE_VERSION,
  ValidationError,
  RegionInput,
  AllocationResult
} from "./core.js";
import {
  createAllocation,
  createPopulationVersion,
  compareAllocations,
  getAllocation,
  openDatabase
} from "./db.js";

const three: RegionInput[] = [
  { id: "1", population: "600" },
  { id: "2", population: "300" },
  { id: "3", population: "100" }
];

function referenceAllocate(input: RegionInput[], totalSeats: number) {
  const regions = [...input].sort((a, b) => compareRegionId(a.id, b.id));
  const seats = new Map(regions.map((region) => [region.id, 1n]));
  const winners: string[] = [];
  for (let seat = regions.length + 1; seat <= totalSeats; seat += 1) {
    let winner: (RegionInput & { numerator: bigint; denominator: bigint }) | undefined;
    for (const region of regions) {
      const current = seats.get(region.id)!;
      const numerator = BigInt(region.population) ** 2n;
      const denominator = current * (current + 1n);
      if (
        !winner ||
        numerator * winner.denominator > winner.numerator * denominator ||
        (numerator * winner.denominator === winner.numerator * denominator &&
          compareRegionId(region.id, winner.id) < 0)
      ) {
        winner = { ...region, numerator, denominator };
      }
    }
    assert.ok(winner);
    winners.push(winner.id);
    seats.set(winner.id, seats.get(winner.id)! + 1n);
  }
  return { winners, seats: Object.fromEntries(seats) };
}

test("不同人口的前若干轮与独立全量扫描一致", () => {
  const result = allocate(three, 10);
  const reference = referenceAllocate(three, 10);
  assert.deepEqual(result.rounds.map((round) => round.awardedRegionId), reference.winners);
  assert.deepEqual(result.finalSeats, { "1": 6, "2": 3, "3": 1 });
  assert.equal(result.rounds[0].awardedRegionId, "1");
  assert.equal(result.rounds[1].awardedRegionId, "1");
  assert.equal(result.rounds[2].awardedRegionId, "2");
});

test("相同人口使用固定地区编号平局", () => {
  const tied = [
    { id: "3", population: "100" },
    { id: "1", population: "100" },
    { id: "2", population: "100" }
  ];
  const result = allocate(tied, 6);
  assert.deepEqual(result.rounds.map((round) => round.awardedRegionId), ["1", "2", "3"]);
  assert.deepEqual(result.finalSeats, { "1": 2, "2": 2, "3": 2 });
});

test("总席位等于地区数时只有基础席位", () => {
  const result = allocate(three, 3);
  assert.deepEqual(result.finalSeats, { "1": 1, "2": 1, "3": 1 });
  assert.equal(result.rounds.length, 0);
});

test("支持单地区、大整数和上限拒绝", () => {
  const huge = [{ id: "1", population: "9".repeat(39) }];
  const result = allocate(huge, 5);
  assert.equal(result.finalSeats["1"], 5);
  assert.throws(() => allocate(huge, 5, { maxRegions: 1, maxPopulationDigits: 38, maxTotalSeats: 5 }), /上限/);
  assert.throws(() => allocate(three, 10, { maxRegions: 3, maxPopulationDigits: 39, maxTotalSeats: 9 }), /总席位超过上限/);
});

for (const invalid of [
  [],
  [{ id: "1", population: "0" }],
  [{ id: "1", population: "-1" }],
  [{ id: "1", population: "1.5" }],
  [{ id: "0", population: "1" }],
  [{ id: "1", population: "1" }, { id: "1", population: "2" }]
]) {
  test(`拒绝非法输入 ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => allocate(invalid as RegionInput[], Math.max(1, invalid.length)), ValidationError);
  });
}

test("总席位少于地区数时明确禁止丢弃地区", () => {
  assert.throws(() => allocate(three, 2), /不能少于地区数/);
});

test("人口统一乘正整数且输入重排不改变结果", () => {
  const scaled = three.map((region) => ({ ...region, population: (BigInt(region.population) * 123456789n).toString() }));
  const reordered = [...scaled].reverse();
  assert.deepEqual(allocate(scaled, 12).finalSeats, allocate(three, 12).finalSeats);
  assert.deepEqual(allocate(reordered, 12).rounds.map((round) => round.awardedRegionId), allocate(scaled, 12).rounds.map((round) => round.awardedRegionId));
});

test("SQLite 保存、幂等重复提交、比较、回放、事务失败和重启读取", () => {
  const dir = mkdtempSync(join(tmpdir(), "hh-test-"));
  try {
    const dbPath = join(dir, "test.sqlite");
    const db = openDatabase(dbPath);
    const version = createPopulationVersion(db, three);
    const duplicateVersion = createPopulationVersion(db, [...three].reverse());
    assert.equal(duplicateVersion.id, version.id);
    assert.equal(duplicateVersion.existed, true);

    const seven = createAllocation(db, version.id, 7) as unknown as { id: string; result: AllocationResult };
    const eight = createAllocation(db, version.id, 8) as unknown as { id: string; result: AllocationResult };
    assert.equal(createAllocation(db, version.id, 7).id, seven.id);

    const changedVersion = createPopulationVersion(db, [
      { id: "1", population: "601" },
      { id: "2", population: "300" },
      { id: "3", population: "100" }
    ]);
    assert.notEqual(changedVersion.id, version.id);

    const report = compareAllocations(db, seven.id, eight.id);
    assert.equal(report.seatChanges.length, 1);
    assert.equal(report.seatChanges[0].delta, 1);
    for (const region of Object.keys(seven.result.finalSeats)) {
      assert.equal((eight.result.finalSeats[region] ?? 0) >= (seven.result.finalSeats[region] ?? 0), true);
    }

    assert.throws(() => createAllocation(db, version.id, 9, () => seven.id));
    assert.throws(() => getAllocation(db, "rollback-must-not-create-records"));

    db.close();
    const restarted = openDatabase(dbPath);
    const reloaded = getAllocation(restarted, eight.id);
    assert.equal(reloaded.ruleVersion, RULE_VERSION);
    assert.deepEqual(reloaded.result.finalSeats, eight.result.finalSeats);
    assert.deepEqual(reloaded.result.rounds, eight.result.rounds);
    restarted.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
