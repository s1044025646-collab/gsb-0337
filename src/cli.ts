#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dbPath, RULES_VERSION } from "./config";
import { Service } from "./service";
import { resultRows } from "./engine";
import { analysisJson, compareJson, toCsv, versionJson } from "./serialize";
import { createApp, pickFreePort } from "./server";
import { AppError } from "./errors";

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, "true");
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] ?? "help", positional: positional.slice(1), flags };
}

function loadRegionsArg(flags: Map<string, string>): unknown {
  const file = flags.get("file");
  if (file) {
    const parsed = JSON.parse(readFileSync(resolve(file), "utf8"));
    return parsed.regions ?? parsed;
  }
  const inline = flags.get("regions");
  if (inline) return JSON.parse(inline);
  throw new AppError("INVALID_REQUEST", "需要 --regions '<JSON>' 或 --file <路径>");
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : `${" ".repeat(width - text.length)}${text}`;
}

function table(headers: string[], rows: string[][], alignRight = new Set<number>()): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const render = (cells: string[]) =>
    cells
      .map((cell, i) => (alignRight.has(i) ? padLeft(cell, widths[i]!) : padRight(cell, widths[i]!)))
      .join("  ");
  return [render(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map((r) => render(r))].join("\n");
}

function printSeats(service: Service, analysisId: number, topRounds: number): void {
  const analysis = service.getAnalysis(analysisId);
  console.log(
    `分析 #${analysis.id}  版本 #${analysis.versionId}  总席位=${analysis.totalSeats}  规则=${analysis.rulesVersion}`,
  );
  console.log(
    table(
      ["地区", "人口", "席位", "人口/席"],
      resultRows(analysis.regions, analysis.result.seatsByCode).map((r) => [
        r.code,
        r.population,
        String(r.seats),
        r.populationPerSeat,
      ]),
      new Set([1, 2, 3]),
    ),
  );

  const shown = analysis.result.rounds.slice(0, topRounds);
  if (shown.length > 0) {
    console.log(`\n前 ${shown.length} 轮优先级（近似值仅用于展示，选择基于 BigInt 交叉乘积）:`);
    for (const round of shown) {
      console.log(
        `第 ${round.round} 轮 -> ${round.winnerCode}（${round.seatsBefore}->${round.seatsAfter}，优先级≈${round.winner.priorityApprox}）`,
      );
      for (const c of round.candidates) {
        const mark = c.code === round.winnerCode ? "* 获胜" : "       ";
        console.log(
          `    ${mark} ${padRight(c.code, 8)} n=${c.seatsBefore} 优先级≈${c.priorityApprox} 平方分数=${c.numeratorSq}/${c.denominator}`,
        );
      }
    }
    if (analysis.result.rounds.length > shown.length) {
      console.log(`... 其余 ${analysis.result.rounds.length - shown.length} 轮见 rounds 命令`);
    }
  } else {
    console.log("\n总席位恰好等于地区数：无需任何分配轮次，每地各得 1 个基础席位。");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = args.flags.get("db") ?? dbPath();

  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    console.log(USAGE);
    return;
  }

  if (args.command === "demo") {
    await runDemo(args.flags.get("db") ?? "data/demo.sqlite");
    return;
  }

  if (args.command === "serve") {
    const service = new Service(path);
    const port = args.flags.get("port") ? Number(args.flags.get("port")) : await pickFreePort();
    const server = createApp({ service });
    server.listen(port, "127.0.0.1", () => {
      console.log(`已启动: http://127.0.0.1:${port}  数据库: ${resolve(path)}`);
    });
    return;
  }

  const service = new Service(path);
  try {
    switch (args.command) {
      case "validate": {
        const version = service.createVersion(loadRegionsArg(args.flags));
        console.log(`校验通过，已创建冻结人口版本 #${version.id}（${version.regions.length} 个地区）`);
        break;
      }
      case "version:list": {
        for (const v of service.listVersions()) {
          console.log(`#${v.id}  ${v.createdAt}  地区数=${v.regions.length}`);
        }
        break;
      }
      case "version:get": {
        console.log(JSON.stringify(versionJson(service.getVersion(Number(args.positional[0]))), null, 2));
        break;
      }
      case "run": {
        const { analysis, reused } = service.runAnalysis(
          Number(args.positional[0]),
          Number(args.positional[1]),
        );
        console.log(reused ? `重复提交：复用既有分析 #${analysis.id}` : `已创建分析 #${analysis.id}`);
        printSeats(service, analysis.id, Number(args.flags.get("rounds") ?? 5));
        break;
      }
      case "show": {
        printSeats(service, Number(args.positional[0]), Number(args.flags.get("rounds") ?? 5));
        break;
      }
      case "rounds": {
        const analysis = service.getAnalysis(Number(args.positional[0]));
        const limit = Number(args.flags.get("limit") ?? analysis.result.rounds.length);
        for (const round of analysis.result.rounds.slice(0, limit)) {
          console.log(
            `第 ${round.round} 轮 ${round.winnerCode} ${round.seatsBefore}->${round.seatsAfter} 平方分数=${round.winner.numeratorSq}/${round.winner.denominator}`,
          );
        }
        break;
      }
      case "candidate": {
        const analysisId = Number(args.positional[0]);
        const roundNo = Number(args.positional[1]);
        const code = args.positional[2]!;
        const analysis = service.getAnalysis(analysisId);
        const round = analysis.result.rounds.find((r) => r.round === roundNo);
        if (!round) throw new AppError("NOT_FOUND", `第 ${roundNo} 轮不存在`);
        const candidate = round.candidates.find((c) => c.code === code);
        if (!candidate) throw new AppError("NOT_FOUND", `第 ${roundNo} 轮中无地区 ${code}`);
        const relation =
          candidate.code === round.winnerCode
            ? "本轮获胜者"
            : candidate.numeratorSq === round.winner.numeratorSq &&
                candidate.denominator === round.winner.denominator
              ? "与获胜者精确相等（平局按编号固定顺序，故未获席）"
              : "低于本轮获胜者";
        console.log(
          JSON.stringify(
            { ...(analysisJson(analysis, roundNo, code).candidateView as object), relationZh: relation },
            null,
            2,
          ),
        );
        break;
      }
      case "compare": {
        const report = service.compare(Number(args.positional[0]), Number(args.positional[1]));
        console.log(JSON.stringify(compareJson(report), null, 2));
        break;
      }
      case "export": {
        const analysis = service.getAnalysis(Number(args.positional[0]));
        if (args.flags.get("format") === "json") {
          console.log(JSON.stringify(analysisJson(analysis), null, 2));
        } else {
          process.stdout.write(toCsv(analysis));
        }
        break;
      }
      default:
        console.log(`未知命令: ${args.command}\n\n${USAGE}`);
        process.exitCode = 2;
    }
  } finally {
    service.close();
  }
}

async function runDemo(path: string): Promise<void> {
  const service = new Service(path);
  try {
    console.log("=== Huntington-Hill 席位分摊演示（虚构数据） ===");
    console.log(`规则版本: ${RULES_VERSION}\n`);

    console.log("演示一：三个地区，人口不同，总席位 10");
    const v1 = service.createVersion([
      { code: "NORTH", population: "6000" },
      { code: "SOUTH", population: "3000" },
      { code: "WEST", population: "1000" },
    ]);
    const a1 = service.runAnalysis(v1.id, 10).analysis;
    printSeats(service, a1.id, 7);

    console.log("\n\n演示二：三个地区人口完全相同，总席位 5，触发固定平局规则（编号字典序）");
    const v2 = service.createVersion([
      { code: "C", population: "1000" },
      { code: "A", population: "1000" },
      { code: "B", population: "1000" },
    ]);
    const a2 = service.runAnalysis(v2.id, 5).analysis;
    printSeats(service, a2.id, 2);

    console.log("\n\n演示三：比较总席位 10 与 11（单调性：仅部分地区 +1，无地区减席）");
    const a1b = service.runAnalysis(v1.id, 11).analysis;
    console.log(JSON.stringify(compareJson(service.compare(a1.id, a1b.id)), null, 2));
  } finally {
    service.close();
  }
}

const USAGE = [
  `Huntington-Hill 席位分摊后端 CLI（规则版本 ${RULES_VERSION}）`,
  "",
  "用法:",
  "  hh demo                                              运行内置演示",
  "  hh validate --regions '<JSON数组>' [--file a.json]   校验并冻结人口版本",
  "  hh version:list                                      列出口径版本",
  "  hh version:get <versionId>                           查看冻结版本",
  "  hh run <versionId> <totalSeats> [--rounds 5]         执行分摊并显示席位表与前若干轮",
  "  hh show <analysisId> [--rounds 5]                    查看分析（重启后从快照回放）",
  "  hh rounds <analysisId> [--limit N]                   逐轮记录",
  "  hh candidate <analysisId> <round> <code>             查看某地区候选优先级及与获胜者关系",
  "  hh compare <analysisA> <analysisB>                   比较两个总席位数",
  "  hh export <analysisId> [--format csv|json]           导出",
  "  hh serve [--port 7070]                               启动 HTTP API（默认选空闲端口）",
  "",
  "通用选项:",
  "  --db <路径>     指定 SQLite 文件（默认 data/hh.sqlite）",
  "",
  "环境变量: HH_PORT HH_DATA_DIR HH_DB_PATH HH_MAX_REGIONS HH_MAX_POPULATION_DIGITS HH_MAX_TOTAL_SEATS",
].join("\n");

main().catch((error: unknown) => {
  if (error instanceof AppError) {
    console.error(`错误 [${error.code}] ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
