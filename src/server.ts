import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { candidatePriority, DEFAULT_LIMITS, Limits } from "./core.js";
import {
  badRequest,
  compareAllocations,
  createAllocation,
  createPopulationVersion,
  exportAllocation,
  getAllocation,
  getPopulationVersion,
  getRounds,
  listAllocations,
  openDatabase
} from "./db.js";

type JsonHandler = (body: any, params: URLSearchParams, id: string | undefined) => unknown | Promise<unknown>;

const dataDir = process.env.HH_DATA_DIR ?? join(process.cwd(), "data");
const db = openDatabase(join(dataDir, "huntington-hill.sqlite"));

const routes: Array<[string, string, JsonHandler]> = [
  ["POST", "/health", () => ({ ok: true })],
  ["POST", "/versions", (body) => createPopulationVersion(db, body.regions, readLimits(body))],
  ["GET", "/versions", (_body, params) => getPopulationVersion(db, String(params.get("id")))],
  ["POST", "/allocations", (body) => {
    if (typeof body.populationVersionId !== "string") throw badRequest("populationVersionId 必须是字符串");
    if (typeof body.totalSeats !== "number") throw badRequest("totalSeats 必须是数字");
    return createAllocation(db, body.populationVersionId, body.totalSeats);
  }],
  ["GET", "/allocations", (_body, params) => {
    const id = params.get("id");
    return id ? getAllocation(db, id) : { allocations: listAllocations(db) };
  }],
  ["GET", "/rounds", (_body, params) => {
    const id = params.get("allocationId");
    if (!id) throw badRequest("缺少 allocationId");
    const limit = readPositiveInteger(params.get("limit"), 50);
    const offset = readNonNegativeInteger(params.get("offset"), 0);
    return { allocationId: id, rounds: getRounds(db, id, limit, offset) };
  }],
  ["GET", "/regions", async (_body, params) => {
    const allocationId = params.get("allocationId");
    const regionId = params.get("regionId");
    if (!allocationId || !regionId) throw badRequest("需要 allocationId 和 regionId");
    const allocation = getAllocation(db, allocationId);
    const seats = allocation.result.finalSeats[regionId];
    if (seats === undefined) throw badRequest("该分配中不存在此地区", { allocationId, regionId });
    const version = getPopulationVersion(db, allocation.populationVersionId);
    const region = version.regions.find((item) => item.id === regionId);
    if (!region) throw badRequest("冻结人口版本中不存在此地区", { allocationId, regionId });
    const candidate = candidatePriority(region, seats);
    const roundNumber = params.get("roundNumber");
    let relationship: unknown;
    if (roundNumber !== null) {
      const rounds = getRounds(db, allocationId, 100000, 0);
      const round = rounds.find((item) => item.roundNumber === Number(roundNumber));
      if (!round) throw badRequest("未找到指定轮次", { roundNumber });
      relationship = round.relationships.find((item: { regionId: string }) => item.regionId === regionId);
    }
    return {
      allocationId,
      regionId,
      seats,
      nextPriority: candidate,
      relationshipToRoundWinner: relationship
    };
  }],
  ["POST", "/compare", (body) => compareAllocations(db, body.lowerAllocationId, body.higherAllocationId)],
  ["GET", "/export", (_body, params) => exportAllocation(db, String(params.get("allocationId")))]
];

function readLimits(body: any): Partial<Limits> {
  if (!body.limits) return {};
  return {
    maxRegions: body.limits.maxRegions ?? DEFAULT_LIMITS.maxRegions,
    maxPopulationDigits: body.limits.maxPopulationDigits ?? DEFAULT_LIMITS.maxPopulationDigits,
    maxTotalSeats: body.limits.maxTotalSeats ?? DEFAULT_LIMITS.maxTotalSeats
  };
}

function readPositiveInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw badRequest("limit 必须是正整数");
  return parsed;
}

function readNonNegativeInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw badRequest("offset 必须是非负整数");
  return parsed;
}

async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)));
}

export function createApp(): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = request.method === "POST" ? await readJson(request) : {};
      const route = routes.find(([method, pathname]) => method === request.method && pathname === url.pathname);
      if (!route) {
        send(response, 404, { error: { code: "NOT_FOUND", message: "路由不存在" } });
        return;
      }
      const result = await route[2](body, url.searchParams, undefined);
      send(response, 200, { data: result });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const status = code === "NOT_FOUND" ? 404 : code === "LIMIT_EXCEEDED" ? 422 : 400;
      send(response, status, {
        error: {
          code: code ?? "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "未知错误",
          details: (error as { details?: unknown }).details
        }
      });
    }
  });
}

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("无法获取空闲端口")));
        return;
      }
      probe.close(() => resolve(address.port));
    });
    probe.on("error", reject);
  });
}

async function main(): Promise<void> {
  const configuredPort = Number(process.env.PORT ?? "0");
  const port = Number.isSafeInteger(configuredPort) && configuredPort > 0 ? configuredPort : await pickFreePort();
  const server = createApp();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Huntington-Hill API: http://127.0.0.1:${port}`);
    console.log(`SQLite: ${join(dataDir, "huntington-hill.sqlite")}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
