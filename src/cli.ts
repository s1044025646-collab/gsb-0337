#!/usr/bin/env node
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { allocate, approximateRatio, Limits } from "./core.js";
import {
  compareAllocations,
  createAllocation,
  createPopulationVersion,
  exportAllocation,
  getAllocation,
  openDatabase
} from "./db.js";

const args = process.argv.slice(2);
const command = args.shift();
const dataDir = process.env.HH_DATA_DIR ?? join(process.cwd(), "data");
const db = openDatabase(join(dataDir, "huntington-hill.sqlite"));

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2);
}

function parseRegions(value: string) {
  try {
    return JSON.parse(value).regions;
  } catch {
    throw new Error("--regions 必须是包含 regions 的 JSON 字符串或 JSON 文件路径");
  }
}

function regionsFromFlag(): unknown {
  const index = args.indexOf("--regions");
  const source = index >= 0 ? args[index + 1] : undefined;
  if (!source) throw new Error("缺少 --regions");
  if (source.startsWith("{")) return parseRegions(source);
  return JSON.parse(readFileSync(source, "utf8")).regions;
}

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function limits(): Partial<Limits> {
  return {
    maxRegions: Number(flag("--max-regions") ?? 1000),
    maxPopulationDigits: Number(flag("--max-pop-digits") ?? 39),
    maxTotalSeats: Number(flag("--max-total-seats") ?? 100000)
  };
}

function printTable(result: ReturnType<typeof allocate>, rounds = 5): void {
  console.log("席位表:");
  console.table(
    result.regions.map((region) => ({
      地区: region.id,
      人口: region.population.toString(),
      席位: result.finalSeats[region.id],
      人口每席近似: approximateRatio(region.population, BigInt(result.finalSeats[region.id]))
    }))
  );
  console.log(`前 ${Math.min(rounds, result.rounds.length)} 轮优先级:`);
  for (const round of result.rounds.slice(0, rounds)) {
    console.log(
      `第${round.roundNumber}轮/总席${round.seatNumber}: 获席 ${round.awardedRegionId} (${round.seatsBefore}→${round.seatsAfter}); ` +
        `优先级平方 ${round.winner.priorityNumerator}/${round.winner.priorityDenominator}`
    );
  }
}

try {
  if (command === "demo") {
    const distinct = [
      { id: "1", population: "600" },
      { id: "2", population: "300" },
      { id: "3", population: "100" }
    ];
    const distinctResult = allocate(distinct, 10);
    console.log("== 不同人口，10 席 ==");
    printTable(distinctResult, 6);
    const tied = [
      { id: "1", population: "100" },
      { id: "2", population: "100" },
      { id: "3", population: "100" }
    ];
    const tiedResult = allocate(tied, 6);
    console.log("== 相同人口，6 席，固定平局顺序 ==");
    printTable(tiedResult, 3);
  } else if (command === "create-version") {
    console.log(json(createPopulationVersion(db, regionsFromFlag(), limits())));
  } else if (command === "allocate") {
    const versionId = flag("--version");
    const totalSeats = Number(flag("--total-seats"));
    if (!versionId) throw new Error("缺少 --version");
    const created = createAllocation(db, versionId, totalSeats);
    console.log(json({ id: created.id, existed: created.existed, result: created.result }));
  } else if (command === "show") {
    const allocation = getAllocation(db, String(flag("--allocation")));
    printTable(allocation.result as ReturnType<typeof allocate>, Number(flag("--rounds") ?? 10));
  } else if (command === "compare") {
    console.log(json(compareAllocations(db, String(flag("--lower")), String(flag("--higher")))));
  } else if (command === "export") {
    console.log(json(exportAllocation(db, String(flag("--allocation")))));
  } else {
    console.log(`命令: demo | create-version --regions file.json [--total-seats N] | allocate --version ID --total-seats N | show --allocation ID | compare --lower ID --higher ID | export --allocation ID`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
