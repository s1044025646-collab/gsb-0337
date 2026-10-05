import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runApportionment } from "../src/engine";
import { bigIntSqrt, compareFraction, validateRegions } from "../src/priority";
import { defaultLimits } from "../src/config";

const LIMITS = defaultLimits();

/**
 * 独立参考计算：每轮全量扫描全部地区，用 Number 无法表示时仍用 BigInt 交叉乘积
 * （与生产实现分别书写，避免共享代码掩盖错误）。
 */
function reference(
  regions: Array<{ code: string; population: bigint }>,
  totalSeats: number,
): Map<string, number> {
  const codes = regions.map((r) => r.code).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const seats = new Map(codes.map((c) => [c, 1]));
  const pop = new Map(regions.map((r) => [r.code, r.population]));
  let assigned = codes.length;
  while (assigned < totalSeats) {
    let winner: string | undefined;
    let bestNum = 0n;
    let bestDen = 1n;
    for (const code of codes) {
      const n = seats.get(code)!;
      const p = pop.get(code)!;
      const num = p * p;
      const den = BigInt(n) * BigInt(n + 1);
      if (winner === undefined || num * bestDen > bestNum * den) {
        winner = code;
        bestNum = num;
        bestDen = den;
      }
    }
    seats.set(winner!, (seats.get(winner!) ?? 0) + 1);
    assigned += 1;
  }
  return seats;
}

describe("bigIntSqrt", () => {
  it("对完全平方数与非完全平方数取整", () => {
    assert.equal(bigIntSqrt(0n), 0n);
    assert.equal(bigIntSqrt(1n), 1n);
    assert.equal(bigIntSqrt(2n), 1n);
    assert.equal(bigIntSqrt(4n), 2n);
    assert.equal(bigIntSqrt(36_000_000n), 6000n);
    assert.equal(bigIntSqrt(10n ** 40n), 10n ** 20n);
  });
});

describe("validateRegions 拒绝非法输入", () => {
  const reject = (code: string, regions: unknown) => {
    assert.throws(
      () => validateRegions(regions, LIMITS),
      (e: { code?: string }) => e.code === code,
    );
  };

  it("空列表", () => reject("REGION_EMPTY", []));
  it("重复编号", () =>
    reject("REGION_CODE_DUPLICATE", [
      { code: "A", population: "1" },
      { code: "A", population: "2" },
    ]));
  it("零人口", () => reject("POPULATION_NOT_POSITIVE_INTEGER", [{ code: "A", population: "0" }]));
  it("负数", () => reject("POPULATION_NOT_POSITIVE_INTEGER", [{ code: "A", population: "-5" }]));
  it("小数", () => reject("POPULATION_NOT_POSITIVE_INTEGER", [{ code: "A", population: "1.5" }]));
  it("前导零", () => reject("POPULATION_NOT_POSITIVE_INTEGER", [{ code: "A", population: "01" }]));
  it("非字符串数字", () => reject("POPULATION_NOT_POSITIVE_INTEGER", [{ code: "A", population: 10 }]));
  it("空编号", () => reject("INVALID_REQUEST", [{ code: "  ", population: "10" }]));
  it("人口位数上限", () =>
    reject("POPULATION_TOO_MANY_DIGITS", [{ code: "A", population: "9".repeat(40) }]));
});

describe("小样例首几轮手算", () => {
  it("6000/3000/1000 总席位 10：逐轮获胜者序列", () => {
    const { result } = runApportionment(
      [
        { code: "NORTH", population: "6000" },
        { code: "SOUTH", population: "3000" },
        { code: "WEST", population: "1000" },
      ],
      10,
      LIMITS,
    );
    const winners = result.rounds.map((r) => r.winnerCode);
    // 手算：N(p1=4242), N(p2=2449>2121), S(p1=2121>N3=1732), N(p3=1732),
    //       N(p4=1341>S2=1224), S(p2=1224>N5=1095), N(p5=1095)
    assert.deepEqual(winners, ["NORTH", "NORTH", "SOUTH", "NORTH", "NORTH", "SOUTH", "NORTH"]);
    assert.deepEqual(Object.fromEntries(result.seatsByCode), { NORTH: 6, SOUTH: 3, WEST: 1 });

    // 第一轮精确量：6000/sqrt(2)，平方分数 36000000/2
    assert.equal(result.rounds[0]!.winner.numeratorSq, "36000000");
    assert.equal(result.rounds[0]!.winner.denominator, "2");
    assert.equal(result.rounds[0]!.seatsBefore, 1);
    assert.equal(result.rounds[0]!.seatsAfter, 2);
  });

  it("每轮结果与独立参考实现一致（多组随机数据）", () => {
    const cases = [
      [17n, 43n, 5n, 129n],
      [1n, 2n, 3n, 4n, 5n, 6n],
      [999_999_999_999n, 1n, 500n],
      [777n, 777n, 778n, 776n],
    ];
    cases.forEach((pops, ci) => {
      const regions = pops.map((p, i) => ({ code: `R${i}`, population: p.toString() }));
      for (const total of [regions.length, regions.length + 1, regions.length + 50]) {
        const { result } = runApportionment(regions, total, LIMITS);
        const ref = reference(
          regions.map((r) => ({ code: r.code, population: BigInt(r.population) })),
          total,
        );
        assert.deepEqual(
          new Map([...result.seatsByCode].sort()),
          new Map([...ref].sort()),
          `case ${ci} total ${total}`,
        );
      }
    });
  });
});

describe("不变性与边界", () => {
  const regions = [
    { code: "A", population: "123" },
    { code: "B", population: "456" },
    { code: "C", population: "789" },
  ];

  it("总席位恰好等于地区数：零轮次，每地 1 席", () => {
    const { result } = runApportionment(regions, 3, LIMITS);
    assert.equal(result.rounds.length, 0);
    assert.deepEqual([...result.seatsByCode.values()], [1, 1, 1]);
  });

  it("单地区：所有席位都归它", () => {
    const { result } = runApportionment([{ code: "ONLY", population: "42" }], 25, LIMITS);
    assert.equal(result.seatsByCode.get("ONLY"), 25);
    assert.equal(result.rounds.length, 24);
  });

  it("总席位少于地区数被拒绝", () => {
    assert.throws(
      () => runApportionment(regions, 2, LIMITS),
      (e: { code?: string }) => e.code === "SEATS_BELOW_REGION_COUNT",
    );
  });

  it("非整数与超上限席位被拒绝", () => {
    assert.throws(() => runApportionment(regions, 3.5, LIMITS), (e: { code?: string }) => e.code === "SEATS_NOT_INTEGER");
    assert.throws(
      () => runApportionment(regions, LIMITS.maxTotalSeats + 1, LIMITS),
      (e: { code?: string }) => e.code === "SEATS_ABOVE_LIMIT",
    );
  });

  it("人口统一乘正整数不改变获胜序列（比例不变）", () => {
    const base = runApportionment(regions, 20, LIMITS).result.rounds.map((r) => r.winnerCode);
    const scaled = runApportionment(
      regions.map((r) => ({ code: r.code, population: (BigInt(r.population) * 1_000_003n).toString() })),
      20,
      LIMITS,
    ).result.rounds.map((r) => r.winnerCode);
    assert.deepEqual(scaled, base);
  });

  it("输入重排不改变结果，平局也与顺序无关", () => {
    const tie = [
      { code: "C", population: "1000" },
      { code: "A", population: "1000" },
      { code: "B", population: "1000" },
    ];
    const r1 = runApportionment(tie, 8, LIMITS).result;
    const r2 = runApportionment([...tie].reverse(), 8, LIMITS).result;
    assert.deepEqual([...r1.seatsByCode].sort(), [...r2.seatsByCode].sort());
    assert.deepEqual(r1.rounds.map((r) => r.winnerCode), r2.rounds.map((r) => r.winnerCode));
    // 3 等分 8 席 = 2,3,3；字典序 A、B 先拿额外席
    assert.deepEqual(Object.fromEntries(r1.seatsByCode), { A: 3, B: 3, C: 2 });
  });

  it("大整数人口：BigInt 交叉乘积不被浮点颠倒", () => {
    // 两个人口相差极近、席位分母差极微的近似平局
    const huge = [
      { code: "BIG", population: (10n ** 38n).toString() },
      { code: "HUG", population: (10n ** 38n + 1n).toString() },
    ];
    const { result } = runApportionment(huge, 4, LIMITS);
    // 平方人口 HUG 严格更大，前两轮基础后第一额外席归 HUG
    assert.equal(result.rounds[0]!.winnerCode, "HUG");
  });
});
