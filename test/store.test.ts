import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Service } from "../src/service";
import { Store } from "../src/store";
import { tempService } from "./helpers";
import { runApportionment } from "../src/engine";
import { defaultLimits } from "../src/config";

const REGIONS = [
  { code: "NORTH", population: "6000" },
  { code: "SOUTH", population: "3000" },
  { code: "WEST", population: "1000" },
];

describe("SQLite 持久化与幂等", () => {
  it("重复提交复用既有分析，不产生新记录", () => {
    const h = tempService();
    try {
      const v = h.service.createVersion(REGIONS);
      const first = h.service.runAnalysis(v.id, 10);
      const second = h.service.runAnalysis(v.id, 10);
      assert.equal(first.reused, false);
      assert.equal(second.reused, true);
      assert.equal(second.analysis.id, first.analysis.id);
      assert.equal(h.service.listAnalyses(v.id).length, 1);
    } finally {
      h.cleanup();
    }
  });

  it("修改人口产生独立分析，不覆盖旧分配", () => {
    const h = tempService();
    try {
      const v1 = h.service.createVersion(REGIONS);
      const v2 = h.service.createVersion([...REGIONS, { code: "EAST", population: "2000" }]);
      h.service.runAnalysis(v1.id, 10);
      h.service.runAnalysis(v2.id, 12);
      assert.notEqual(v1.id, v2.id);
      assert.equal(h.service.listAnalyses().length, 2);
      assert.equal(h.service.getAnalysis(1).result.seatsByCode.get("NORTH"), 6);
    } finally {
      h.cleanup();
    }
  });

  it("重启后从旧快照回放，记录逐轮一致", () => {
    const h = tempService();
    let analysisId: number;
    let versionId: number;
    const v = h.service.createVersion(REGIONS);
    versionId = v.id;
    analysisId = h.service.runAnalysis(v.id, 10).analysis.id;
    h.service.close(); // 只关闭连接，不删除文件，模拟重启

    // 重新打开同一数据库文件（模拟重启）
    const reopened = new Service(h.dbPath);
    try {
      const analysis = reopened.getAnalysis(analysisId!);
      assert.equal(analysis.versionId, versionId);
      assert.deepEqual(
        analysis.result.rounds.map((r) => [r.round, r.winnerCode, r.seatsBefore, r.seatsAfter]),
        [
          [1, "NORTH", 1, 2],
          [2, "NORTH", 2, 3],
          [3, "SOUTH", 1, 2],
          [4, "NORTH", 3, 4],
          [5, "NORTH", 4, 5],
          [6, "SOUTH", 2, 3],
          [7, "NORTH", 5, 6],
        ],
      );
      assert.deepEqual(Object.fromEntries(analysis.result.seatsByCode), {
        NORTH: 6,
        SOUTH: 3,
        WEST: 1,
      });
    } finally {
      reopened.close();
      const { rmSync } = require("node:fs");
      const { dirname } = require("node:path");
      rmSync(dirname(h.dbPath), { recursive: true, force: true });
    }
  });

  it("事务中途失败完全回滚，无半成品残留", () => {
    const h = tempService();
    try {
      const v = h.service.createVersion(REGIONS);
      const { result } = runApportionment(REGIONS, 10, defaultLimits());
      assert.throws(() =>
        (h.service.store as Store).createAnalysisFailingForTest(v.id, 10, result),
      );
      assert.equal(h.service.listAnalyses(v.id).length, 0);

      // 数据库仍可正常使用
      const ok = h.service.runAnalysis(v.id, 10);
      assert.equal(ok.reused, false);
    } finally {
      h.cleanup();
    }
  });
});

describe("比较两个总席位数", () => {
  it("增加一席恰好一个地区 +1 且无地区减席", () => {
    const h = tempService();
    try {
      const v = h.service.createVersion(REGIONS);
      const a10 = h.service.runAnalysis(v.id, 10).analysis;
      const a11 = h.service.runAnalysis(v.id, 11).analysis;
      const report = h.service.compare(a10.id, a11.id);
      assert.equal(report.deltaSeats, 1);
      assert.equal(report.monotonic, true);
      assert.deepEqual(report.gainedRegions, ["NORTH"]);
      const gains = report.rows.map((r) => r.gained);
      assert.equal(gains.reduce((a, b) => a + b, 0), 1);
      assert.ok(report.rows.every((r) => r.gained >= 0));
    } finally {
      h.cleanup();
    }
  });
});

describe("候选人视角", () => {
  it("能查看任意地区下一席位候选与获胜者关系（含精确平局标记）", () => {
    const h = tempService();
    try {
      const v = h.service.createVersion([
        { code: "A", population: "1000" },
        { code: "B", population: "1000" },
      ]);
      const a = h.service.runAnalysis(v.id, 4).analysis;
      const round1 = a.result.rounds[0]!;
      const loser = round1.candidates.find((c) => c.code === "B")!;
      assert.equal(loser.numeratorSq, round1.winner.numeratorSq);
      assert.equal(loser.denominator, round1.winner.denominator);
      assert.equal(round1.winnerCode, "A");
    } finally {
      h.cleanup();
    }
  });
});
