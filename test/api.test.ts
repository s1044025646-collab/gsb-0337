import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp, pickFreePort } from "../src/server";
import { Service } from "../src/service";
import type { Server } from "node:http";

describe("HTTP API", () => {
  let base: string;
  let server: Server;
  let service: Service;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "hh-api-"));
    service = new Service(join(dir, "api.sqlite"));
    server = createApp({ service });
    const port = await pickFreePort();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close();
    rmSync(dir!, { recursive: true, force: true });
  });

  async function json(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any, text: () => res.text() };
  }

  it("健康检查与限制参数", async () => {
    const health = await json("GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    const limits = await json("GET", "/limits");
    assert.equal(limits.status, 200);
    assert.equal(limits.body.maxTotalSeats, 100_000);
  });

  it("完整流程：建版本 -> 分配 -> 逐轮 -> 地区结果 -> 比较 -> 导出", async () => {
    const created = await json("POST", "/versions", {
      regions: [
        { code: "NORTH", population: "6000" },
        { code: "SOUTH", population: "3000" },
        { code: "WEST", population: "1000" },
      ],
    });
    assert.equal(created.status, 201);
    const versionId = created.body.id;

    const ran = await json("POST", `/versions/${versionId}/analyses`, { totalSeats: 10 });
    assert.equal(ran.status, 201);
    assert.equal(ran.body.totalSeats, 10);
    assert.equal(ran.body.rounds.length, 7);
    const analysisId = ran.body.id;

    // 重复提交返回 200 + reused
    const again = await json("POST", `/versions/${versionId}/analyses`, { totalSeats: 10 });
    assert.equal(again.status, 200);
    assert.equal(again.body.reused, true);

    // 候选视角
    const candidate = await json("GET", `/analyses/${analysisId}/rounds/1/candidates/WEST?round=1`);
    assert.equal(candidate.status, 200);
    assert.equal(candidate.body.candidateView.relation, "below");

    // 增加一席并比较
    const ran11 = await json("POST", `/versions/${versionId}/analyses`, { totalSeats: 11 });
    const cmp = await json("GET", `/compare?a=${analysisId}&b=${ran11.body.id}`);
    assert.equal(cmp.body.monotonic, true);
    assert.deepEqual(cmp.body.gainedRegions, ["NORTH"]);

    // CSV 导出
    const res = await fetch(`${base}/analyses/${analysisId}/export`);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    const csv = await res.text();
    assert.match(csv, /^code,population,seats,population_per_seat\r?\nNORTH,6000,6,/);
  });

  it("明确错误码：零人口 400 / 席位不足 400 / 不存在 404", async () => {
    const bad = await json("POST", "/versions", {
      regions: [{ code: "A", population: "0" }],
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "POPULATION_NOT_POSITIVE_INTEGER");

    const dup = await json("POST", "/versions", {
      regions: [
        { code: "X", population: "1" },
        { code: "X", population: "2" },
      ],
    });
    assert.equal(dup.body.error.code, "REGION_CODE_DUPLICATE");

    const created = await json("POST", "/versions", {
      regions: [{ code: "A", population: "1" }],
    });
    const tooFew = await json("POST", `/versions/${created.body.id}/analyses`, { totalSeats: 0 });
    assert.equal(tooFew.status, 400);
    assert.equal(tooFew.body.error.code, "SEATS_BELOW_REGION_COUNT");

    const missing = await json("GET", "/analyses/99999");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "NOT_FOUND");

    const badJson = await fetch(`${base}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);
  });
});
