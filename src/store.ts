import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RULES_VERSION } from "./config";
import { AppError } from "./errors";
import { replayFromSnapshot, verifyTotals } from "./engine";
import type { ApportionmentResult, Region } from "./types";

export interface StoredVersion {
  id: number;
  createdAt: string;
  regions: Region[];
}

export interface StoredAnalysis {
  id: number;
  versionId: number;
  totalSeats: number;
  rulesVersion: string;
  createdAt: string;
  regions: Region[];
  result: ApportionmentResult;
}

interface AnalysisRow {
  id: number;
  version_id: number;
  total_seats: number;
  rules_version: string;
  created_at: string;
}

interface RegionRow {
  seq: number;
  code: string;
  population: string;
}

interface RoundRow {
  round: number;
  winner_code: string;
  seats_before: number;
  seats_after: number;
}

interface FinalRow {
  code: string;
  seats: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /** 手动事务：函数抛错时回滚并向上抛出 */
  private inTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS version_regions (
        version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        code TEXT NOT NULL,
        population TEXT NOT NULL,
        PRIMARY KEY (version_id, code)
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
        total_seats INTEGER NOT NULL,
        rules_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (version_id, total_seats, rules_version)
      );
      CREATE TABLE IF NOT EXISTS rounds (
        analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
        round INTEGER NOT NULL,
        winner_code TEXT NOT NULL,
        seats_before INTEGER NOT NULL,
        seats_after INTEGER NOT NULL,
        PRIMARY KEY (analysis_id, round)
      );
      CREATE TABLE IF NOT EXISTS final_seats (
        analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        seats INTEGER NOT NULL,
        PRIMARY KEY (analysis_id, code)
      );
    `);
  }

  createVersion(regions: Region[]): StoredVersion {
    const createdAt = new Date().toISOString();
    const tx = this.db.prepare(
      "INSERT INTO versions (created_at) VALUES (?)",
    );
    const insertRegion = this.db.prepare(
      "INSERT INTO version_regions (version_id, seq, code, population) VALUES (?, ?, ?, ?)",
    );
    const id = this.inTransaction(() => {
      const info = tx.run(createdAt);
      const versionId = Number(info.lastInsertRowid);
      regions.forEach((region, seq) => {
        insertRegion.run(versionId, seq, region.code, region.population);
      });
      return versionId;
    });
    return { id, createdAt, regions };
  }

  listVersions(): StoredVersion[] {
    const rows = this.db.prepare("SELECT id, created_at FROM versions ORDER BY id").all() as Array<{
      id: number;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      regions: this.loadRegions(row.id),
    }));
  }

  getVersion(versionId: number): StoredVersion {
    const row = this.db
      .prepare("SELECT id, created_at FROM versions WHERE id = ?")
      .get(versionId) as { id: number; created_at: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", `人口版本不存在: ${versionId}`);
    return { id: row.id, createdAt: row.created_at, regions: this.loadRegions(row.id) };
  }

  private loadRegions(versionId: number): Region[] {
    const rows = this.db
      .prepare("SELECT seq, code, population FROM version_regions WHERE version_id = ? ORDER BY seq")
      .all(versionId) as unknown as RegionRow[];
    return rows.map((row) => ({
      code: row.code,
      population: row.population,
      populationBig: BigInt(row.population),
    }));
  }

  /**
   * 创建分析（幂等）：同一冻结版本 + 总席位 + 规则版本重复提交直接返回既有结果。
   * 全部写入放在单个事务中；任一步失败全部回滚，不会留下半成品。
   */
  createAnalysis(
    versionId: number,
    totalSeats: number,
    result: ApportionmentResult,
  ): { analysis: StoredAnalysis; reused: boolean } {
    this.getVersion(versionId);

    const existing = this.db
      .prepare("SELECT id FROM analyses WHERE version_id = ? AND total_seats = ? AND rules_version = ?")
      .get(versionId, totalSeats, RULES_VERSION) as { id: number } | undefined;
    if (existing) {
      return { analysis: this.getAnalysis(existing.id), reused: true };
    }

    const version = this.getVersion(versionId);
    const createdAt = new Date().toISOString();
    const insertAnalysis = this.db.prepare(
      "INSERT INTO analyses (version_id, total_seats, rules_version, created_at) VALUES (?, ?, ?, ?)",
    );
    const insertRound = this.db.prepare(
      "INSERT INTO rounds (analysis_id, round, winner_code, seats_before, seats_after) VALUES (?, ?, ?, ?, ?)",
    );
    const insertFinal = this.db.prepare(
      "INSERT INTO final_seats (analysis_id, code, seats) VALUES (?, ?, ?)",
    );

    const id = this.inTransaction(() => {
      const info = insertAnalysis.run(versionId, totalSeats, RULES_VERSION, createdAt);
      const analysisId = Number(info.lastInsertRowid);
      for (const round of result.rounds) {
        insertRound.run(
          analysisId,
          round.round,
          round.winnerCode,
          round.seatsBefore,
          round.seatsAfter,
        );
      }
      for (const region of version.regions) {
        insertFinal.run(analysisId, region.code, result.seatsByCode.get(region.code) ?? 0);
      }
      return analysisId;
    });

    return { analysis: this.getAnalysis(id), reused: false };
  }

  getAnalysis(analysisId: number): StoredAnalysis {
    const row = this.db
      .prepare("SELECT id, version_id, total_seats, rules_version, created_at FROM analyses WHERE id = ?")
      .get(analysisId) as AnalysisRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", `分析不存在: ${analysisId}`);

    const version = this.getVersion(row.version_id);
    const roundRows = this.db
      .prepare("SELECT round, winner_code, seats_before, seats_after FROM rounds WHERE analysis_id = ? ORDER BY round")
      .all(analysisId) as unknown as RoundRow[];
    const finalRows = this.db
      .prepare("SELECT code, seats FROM final_seats WHERE analysis_id = ?")
      .all(analysisId) as unknown as FinalRow[];

    const seatsByCode = new Map<string, number>(finalRows.map((f) => [f.code, f.seats]));

    // 从冻结快照重放，重建每轮的完整精确比较量并核对持久化记录
    const replay = replayFromSnapshot(version.regions, row.total_seats, {
      maxRegions: Number.MAX_SAFE_INTEGER,
      maxPopulationDigits: Number.MAX_SAFE_INTEGER,
      maxTotalSeats: Number.MAX_SAFE_INTEGER,
    });
    if (replay.rounds.length !== roundRows.length) {
      throw new AppError("REPLAY_MISMATCH", `分析 ${analysisId} 轮次数与快照回放不一致`);
    }
    for (let i = 0; i < roundRows.length; i += 1) {
      const stored = roundRows[i]!;
      const redone = replay.rounds[i]!;
      if (
        stored.round !== redone.round ||
        stored.winner_code !== redone.winnerCode ||
        stored.seats_before !== redone.seatsBefore ||
        stored.seats_after !== redone.seatsAfter
      ) {
        throw new AppError(
          "REPLAY_MISMATCH",
          `分析 ${analysisId} 第 ${stored.round} 轮与快照回放不一致`,
        );
      }
    }
    verifyTotals(version.regions, seatsByCode, row.total_seats);

    return {
      id: row.id,
      versionId: row.version_id,
      totalSeats: row.total_seats,
      rulesVersion: row.rules_version,
      createdAt: row.created_at,
      regions: version.regions,
      result: { rounds: replay.rounds, seatsByCode },
    };
  }

  listAnalyses(versionId?: number): Array<AnalysisRow & { region_count: number }> {
    const sql = `
      SELECT a.id, a.version_id, a.total_seats, a.rules_version, a.created_at,
             (SELECT COUNT(*) FROM version_regions vr WHERE vr.version_id = a.version_id) AS region_count
      FROM analyses a
      ${versionId === undefined ? "" : "WHERE a.version_id = ?"}
      ORDER BY a.id`;
    const stmt = this.db.prepare(sql);
    return (versionId === undefined ? stmt.all() : stmt.all(versionId)) as unknown as Array<
      AnalysisRow & { region_count: number }
    >;
  }

  /** 故意制造事务失败（测试用）：在同一事务内插入分析后抛错，验证回滚无残留 */
  createAnalysisFailingForTest(
    versionId: number,
    totalSeats: number,
    result: ApportionmentResult,
  ): never {
    this.getVersion(versionId);
    const version = this.getVersion(versionId);
    const insertAnalysis = this.db.prepare(
      "INSERT INTO analyses (version_id, total_seats, rules_version, created_at) VALUES (?, ?, ?, ?)",
    );
    const insertFinal = this.db.prepare(
      "INSERT INTO final_seats (analysis_id, code, seats) VALUES (?, ?, ?)",
    );
    this.inTransaction(() => {
      const info = insertAnalysis.run(versionId, totalSeats, RULES_VERSION, new Date().toISOString());
      const analysisId = Number(info.lastInsertRowid);
      for (const region of version.regions) {
        insertFinal.run(analysisId, region.code, result.seatsByCode.get(region.code) ?? 0);
      }
      throw new Error("forced failure");
    });
    throw new Error("unreachable");
  }
}
