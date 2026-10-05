export interface Limits {
  /** 最多地区数 */
  maxRegions: number;
  /** 人口十进制位数上限（不含前导零的规范十进制串长度） */
  maxPopulationDigits: number;
  /** 总席位上限 */
  maxTotalSeats: number;
}

export const RULES_VERSION = "huntington-hill:2025-10";

export function defaultLimits(): Limits {
  return {
    maxRegions: intFromEnv("HH_MAX_REGIONS", 1000),
    maxPopulationDigits: intFromEnv("HH_MAX_POPULATION_DIGITS", 39),
    maxTotalSeats: intFromEnv("HH_MAX_TOTAL_SEATS", 100_000),
  };
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function dataDir(): string {
  return process.env.HH_DATA_DIR || "data";
}

export function dbPath(): string {
  return process.env.HH_DB_PATH || `${dataDir().replace(/[\\/]+$/, "")}/hh.sqlite`;
}
