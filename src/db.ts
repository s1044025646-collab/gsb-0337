import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  allocate,
  approximateRatio,
  assertPublication,
  canonicalPopulationChecksum,
  DEFAULT_LIMITS,
  Limits,
  normalizeLimits,
  Region,
  RULE_VERSION,
  validateRegions
} from "./core.js";

type PopulationVersionRecord = {
  id: string;
  checksum: string;
  ruleVersion: string;
  limits: Limits;
  regions: Region[];
  createdAt: string;
};

type AllocationSummary = {
  id: string;
  populationVersionId: string;
  totalSeats: number;
  ruleVersion: string;
  createdAt: string;
};

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item
  );
}

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS population_versions (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL UNIQUE,
      rule_version TEXT NOT NULL,
      limits_json TEXT NOT NULL,
      regions_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS allocations (
      id TEXT PRIMARY KEY,
      population_version_id TEXT NOT NULL REFERENCES population_versions(id),
      total_seats INTEGER NOT NULL,
      rule_version TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(population_version_id, total_seats, rule_version)
    );
    CREATE TABLE IF NOT EXISTS allocation_rounds (
      allocation_id TEXT NOT NULL REFERENCES allocations(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL,
      seat_number INTEGER NOT NULL,
      awarded_region_id TEXT NOT NULL,
      seats_before INTEGER NOT NULL,
      seats_after INTEGER NOT NULL,
      round_json TEXT NOT NULL,
      PRIMARY KEY (allocation_id, round_number)
    );
  `);
  db.exec(
    `INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '1'), ('rule_version', '${RULE_VERSION}');`
  );
  return db;
}

export function createPopulationVersion(
  db: DatabaseSync,
  regionsInput: unknown,
  limitsInput: Partial<Limits> = {},
  idFactory: () => string = defaultId
): PopulationVersionRecord & { existed: boolean } {
  const limits = normalizeLimits(limitsInput);
  const regions = validateRegions(regionsInput, limits);
  const checksum = canonicalPopulationChecksum(regions, limits);
  const existing = db
    .prepare("SELECT * FROM population_versions WHERE checksum = ?")
    .get(checksum) as Record<string, unknown> | undefined;
  if (existing) {
    return { ...mapPopulationVersion(existing), existed: true };
  }

  const id = idFactory();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO population_versions(id, checksum, rule_version, limits_json, regions_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, checksum, RULE_VERSION, json(limits), json(regions), createdAt);
  return { id, checksum, ruleVersion: RULE_VERSION, limits, regions, createdAt, existed: false };
}

export function getPopulationVersion(db: DatabaseSync, id: string): PopulationVersionRecord {
  const row = db.prepare("SELECT * FROM population_versions WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw notFound("未找到人口版本", { populationVersionId: id });
  return mapPopulationVersion(row);
}

function mapPopulationVersion(row: Record<string, unknown>): PopulationVersionRecord {
  const limits = normalizeLimits(JSON.parse(String(row.limits_json)), DEFAULT_LIMITS);
  const rawRegions = JSON.parse(String(row.regions_json)) as Array<{ id: string; population: string }>;
  return {
    id: String(row.id),
    checksum: String(row.checksum),
    ruleVersion: String(row.rule_version),
    limits,
    regions: rawRegions.map((region) => ({ id: region.id, population: BigInt(region.population) })),
    createdAt: String(row.created_at)
  };
}

export function createAllocation(
  db: DatabaseSync,
  populationVersionId: string,
  totalSeats: number,
  idFactory: () => string = defaultId
): AllocationSummary & { result: unknown; existed: boolean } {
  const version = getPopulationVersion(db, populationVersionId);
  const existing = db
    .prepare(
      "SELECT * FROM allocations WHERE population_version_id = ? AND total_seats = ? AND rule_version = ?"
    )
    .get(populationVersionId, totalSeats, RULE_VERSION) as Record<string, unknown> | undefined;
  if (existing) {
    const result = JSON.parse(String(existing.result_json));
    return {
      id: String(existing.id),
      populationVersionId,
      totalSeats: Number(existing.total_seats),
      ruleVersion: String(existing.rule_version),
      createdAt: String(existing.created_at),
      result,
      existed: true
    };
  }

  const result = computeVersionAllocation(version, totalSeats);
  const id = idFactory();
  const createdAt = new Date().toISOString();
  const tx = db.prepare("BEGIN IMMEDIATE");
  const commit = db.prepare("COMMIT");
  const rollback = db.prepare("ROLLBACK");
  tx.run();
  try {
    db.prepare(
      `INSERT INTO allocations(id, population_version_id, total_seats, rule_version, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, populationVersionId, totalSeats, RULE_VERSION, json(result), createdAt);

    const insertRound = db.prepare(
      `INSERT INTO allocation_rounds(allocation_id, round_number, seat_number, awarded_region_id, seats_before, seats_after, round_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const round of result.rounds) {
      insertRound.run(
        id,
        round.roundNumber,
        round.seatNumber,
        round.awardedRegionId,
        round.seatsBefore,
        round.seatsAfter,
        json(round)
      );
    }
    commit.run();
  } catch (error) {
    rollback.run();
    throw error;
  }

  return {
    id,
    populationVersionId,
    totalSeats,
    ruleVersion: RULE_VERSION,
    createdAt,
    result,
    existed: false
  };
}

function computeVersionAllocation(version: PopulationVersionRecord, totalSeats: number) {
  return allocate(version.regions.map((region) => ({
    id: region.id,
    population: region.population.toString()
  })), totalSeats, version.limits);
}

export function getAllocation(db: DatabaseSync, id: string) {
  const row = db.prepare("SELECT * FROM allocations WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw notFound("未找到分配", { allocationId: id });
  return mapAllocation(row);
}

function mapAllocation(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    populationVersionId: String(row.population_version_id),
    totalSeats: Number(row.total_seats),
    ruleVersion: String(row.rule_version),
    createdAt: String(row.created_at),
    result: JSON.parse(String(row.result_json))
  };
}

export function getRounds(db: DatabaseSync, allocationId: string, limit = 50, offset = 0) {
  getAllocation(db, allocationId);
  return (db
    .prepare(
      "SELECT round_json FROM allocation_rounds WHERE allocation_id = ? ORDER BY round_number LIMIT ? OFFSET ?"
    )
    .all(allocationId, limit, offset) as Array<{ round_json: string }>).map((row) => JSON.parse(row.round_json));
}

export function compareAllocations(db: DatabaseSync, lowerId: string, higherId: string) {
  const lower = getAllocation(db, lowerId);
  const higher = getAllocation(db, higherId);
  if (lower.populationVersionId !== higher.populationVersionId) {
    throw badRequest("只能比较同一个冻结人口版本的两个总席位数");
  }
  if (higher.totalSeats !== lower.totalSeats + 1) {
    throw badRequest("此报告要求第二个总席位数恰好比第一个多一席");
  }
  const lowerSeats: Record<string, number> = lower.result.finalSeats;
  const higherSeats: Record<string, number> = higher.result.finalSeats;
  const changes = Object.keys(higherSeats)
    .map((regionId) => ({
      regionId,
      before: lowerSeats[regionId] ?? 0,
      after: higherSeats[regionId] ?? 0,
      delta: (higherSeats[regionId] ?? 0) - (lowerSeats[regionId] ?? 0)
    }))
    .filter((change) => change.delta !== 0);

  const version = getPopulationVersion(db, lower.populationVersionId);
  const populationPerSeat = version.regions.map((region) => {
    const seats = higherSeats[region.id] ?? 0;
    return {
      regionId: region.id,
      population: region.population.toString(),
      seats,
      populationPerSeatApproximate: approximateRatio(region.population, BigInt(seats)),
      populationPerSeatIntegerPart: (region.population / BigInt(seats)).toString(),
      remainder: (region.population % BigInt(seats)).toString()
    };
  });
  return {
    lowerAllocationId: lowerId,
    higherAllocationId: higherId,
    populationVersionId: lower.populationVersionId,
    lowerTotalSeats: lower.totalSeats,
    higherTotalSeats: higher.totalSeats,
    seatChanges: changes,
    populationPerSeat,
    note: "新增一席只应使一个地区增加一席；人口每席为整数商和余数，不声称其他分摊公理最优。"
  };
}

export function exportAllocation(db: DatabaseSync, id: string) {
  const allocation = getAllocation(db, id);
  const version = getPopulationVersion(db, allocation.populationVersionId);
  return {
    exportedAt: new Date().toISOString(),
    populationVersion: {
      ...version,
      regions: version.regions.map((region) => ({ id: region.id, population: region.population.toString() }))
    },
    allocation
  };
}

export function listAllocations(db: DatabaseSync): AllocationSummary[] {
  return (db
    .prepare(
      "SELECT id, population_version_id, total_seats, rule_version, created_at FROM allocations ORDER BY created_at DESC, id"
    )
    .all() as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    populationVersionId: String(row.population_version_id),
    totalSeats: Number(row.total_seats),
    ruleVersion: String(row.rule_version),
    createdAt: String(row.created_at)
  }));
}

export function defaultId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function notFound(message: string, details?: unknown) {
  return Object.assign(new Error(message), { code: "NOT_FOUND", details });
}

export function badRequest(message: string, details?: unknown) {
  return Object.assign(new Error(message), { code: "BAD_REQUEST", details });
}
