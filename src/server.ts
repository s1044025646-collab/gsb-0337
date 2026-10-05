import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dbPath, defaultLimits, RULES_VERSION } from "./config";
import { AppError, errorStatusCode } from "./errors";
import { Service } from "./service";
import { analysisJson, compareJson, toCsv, versionJson } from "./serialize";

interface ParsedUrl {
  pathname: string;
  query: URLSearchParams;
}

function parseUrl(req: IncomingMessage): ParsedUrl {
  const url = new URL(req.url ?? "/", "http://localhost");
  return { pathname: url.pathname.replace(/\/+$/, "") || "/", query: url.searchParams };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 5_000_000) {
        reject(new AppError("INVALID_REQUEST", "请求体过大（上限 5MB）"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new AppError("INVALID_REQUEST", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, text: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function asInt(value: string | null, name: string): number {
  if (value === null) throw new AppError("INVALID_REQUEST", `缺少参数 ${name}`);
  const n = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(n)) throw new AppError("INVALID_REQUEST", `参数 ${name} 不是整数`);
  return n;
}

/** 选择空闲端口（默认行为） */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("无法获取空闲端口")));
      }
    });
    srv.on("error", reject);
  });
}

export interface AppContext {
  service: Service;
}

export function createApp(ctx: AppContext): Server {
  const server = createServer(async (req, res) => {
    const { pathname, query } = parseUrl(req);
    try {
      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { ok: true, rulesVersion: RULES_VERSION });
        return;
      }
      if (req.method === "GET" && pathname === "/limits") {
        sendJson(res, 200, ctx.service.limits);
        return;
      }

      if (req.method === "POST" && pathname === "/versions") {
        const body = (await readJson(req)) as { regions?: unknown };
        const version = ctx.service.createVersion(body?.regions);
        sendJson(res, 201, versionJson(version));
        return;
      }
      if (req.method === "GET" && pathname === "/versions") {
        sendJson(res, 200, { versions: ctx.service.listVersions().map(versionJson) });
        return;
      }

      const versionMatch = /^\/versions\/(\d+)$/.exec(pathname);
      if (req.method === "GET" && versionMatch) {
        sendJson(res, 200, versionJson(ctx.service.getVersion(Number(versionMatch[1]))));
        return;
      }

      const analysesMatch = /^\/versions\/(\d+)\/analyses$/.exec(pathname);
      if (req.method === "POST" && analysesMatch) {
        const versionId = Number(analysesMatch[1]);
        const body = (await readJson(req)) as { totalSeats?: unknown };
        if (typeof body?.totalSeats !== "number") {
          throw new AppError("SEATS_NOT_INTEGER", "请求体必须包含数字 totalSeats");
        }
        const { analysis, reused } = ctx.service.runAnalysis(versionId, body.totalSeats);
        sendJson(res, reused ? 200 : 201, { reused, ...analysisJson(analysis) });
        return;
      }

      if (req.method === "GET" && pathname === "/analyses") {
        const versionParam = query.get("versionId");
        const versionId = versionParam === null ? undefined : asInt(versionParam, "versionId");
        sendJson(res, 200, { analyses: ctx.service.listAnalyses(versionId) });
        return;
      }

      const analysisMatch = /^\/analyses\/(\d+)$/.exec(pathname);
      if (req.method === "GET" && analysisMatch) {
        const analysis = ctx.service.getAnalysis(Number(analysisMatch[1]));
        const roundParam = query.get("round");
        const codeParam = query.get("code");
        const round = roundParam === null ? undefined : asInt(roundParam, "round");
        sendJson(res, 200, analysisJson(analysis, round, codeParam ?? undefined));
        return;
      }

      const candidateMatch = /^\/analyses\/(\d+)\/rounds\/(\d+)\/candidates\/([^/]+)$/.exec(pathname);
      if (req.method === "GET" && candidateMatch) {
        const analysis = ctx.service.getAnalysis(Number(candidateMatch[1]));
        const round = asInt(candidateMatch[2]!, "round");
        const code = decodeURIComponent(candidateMatch[3]!);
        sendJson(res, 200, analysisJson(analysis, round, code));
        return;
      }

      const exportMatch = /^\/analyses\/(\d+)\/export$/.exec(pathname);
      if (req.method === "GET" && exportMatch) {
        const analysis = ctx.service.getAnalysis(Number(exportMatch[1]));
        if (query.get("format") === "json") {
          sendJson(res, 200, analysisJson(analysis));
        } else {
          sendText(res, 200, toCsv(analysis), "text/csv; charset=utf-8");
        }
        return;
      }

      if (req.method === "GET" && pathname === "/compare") {
        const smaller = ctx.service.getAnalysis(asInt(query.get("a"), "a"));
        const larger = ctx.service.getAnalysis(asInt(query.get("b"), "b"));
        sendJson(res, 200, compareJson(ctx.service.compare(smaller.id, larger.id)));
        return;
      }

      sendJson(res, 404, { error: { code: "NOT_FOUND", message: `未知路径: ${pathname}` } });
    } catch (error) {
      if (error instanceof AppError) {
        sendJson(res, errorStatusCode(error.code), {
          error: { code: error.code, message: error.message, details: error.details ?? null },
        });
        return;
      }
      sendJson(res, 500, {
        error: { code: "INTERNAL", message: error instanceof Error ? error.message : "未知错误" },
      });
    }
  });
  return server;
}

async function main(): Promise<void> {
  const configuredPort = process.env.HH_PORT ? Number.parseInt(process.env.HH_PORT, 10) : undefined;
  const port =
    configuredPort !== undefined && Number.isSafeInteger(configuredPort) && configuredPort > 0
      ? configuredPort
      : await pickFreePort();
  const service = new Service(dbPath(), defaultLimits());
  const server = createApp({ service });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Huntington-Hill 后端已启动: http://127.0.0.1:${port}`);
    console.log(`数据库: ${dbPath()}  规则版本: ${RULES_VERSION}`);
  });

  const shutdown = () => {
    server.close(() => {
      service.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
