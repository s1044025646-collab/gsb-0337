import { divideApprox } from "./engine";
import type { StoredAnalysis } from "./store";
import type { Region } from "./types";

export interface CompareRow {
  code: string;
  population: string;
  seatsSmall: number;
  seatsLarge: number;
  gained: number;
  populationPerSeatSmall: string;
  populationPerSeatLarge: string;
}

export interface CompareReport {
  smallerAnalysisId: number;
  largerAnalysisId: number;
  smallerTotalSeats: number;
  largerTotalSeats: number;
  deltaSeats: number;
  /** 新增席位去向（应当恰好有 deltaSeats 个地区各增若干席，且无地区减席） */
  rows: CompareRow[];
  gainedRegions: string[];
  monotonic: boolean;
}

/**
 * 比较同一人口版本下两个总席位数（要求后者恰为前者 + n）。
 * Huntington–Hill 是除数法：增加席位只会给部分地区加席，不会让任何地区减席（单调性）。
 * 不声称任何比例指标最优，也不保证满足其他分摊方法的配额公理。
 */
export function compareAnalyses(smaller: StoredAnalysis, larger: StoredAnalysis): CompareReport {
  if (smaller.versionId !== larger.versionId) {
    throw new Error("只能比较同一冻结人口版本下的分析");
  }
  if (larger.totalSeats < smaller.totalSeats) {
    throw new Error("第二个总席位数必须不小于第一个");
  }

  const regionsByCode = new Map<string, Region>();
  for (const region of larger.regions) regionsByCode.set(region.code, region);

  const rows: CompareRow[] = [];
  const gainedRegions: string[] = [];
  let monotonic = true;

  for (const region of larger.regions) {
    const seatsSmall = smaller.result.seatsByCode.get(region.code) ?? 0;
    const seatsLarge = larger.result.seatsByCode.get(region.code) ?? 0;
    const gained = seatsLarge - seatsSmall;
    if (gained < 0) monotonic = false;
    if (gained > 0) gainedRegions.push(region.code);
    rows.push({
      code: region.code,
      population: region.population,
      seatsSmall,
      seatsLarge,
      gained,
      populationPerSeatSmall: divideApprox(region.populationBig, BigInt(seatsSmall), 6),
      populationPerSeatLarge: divideApprox(region.populationBig, BigInt(seatsLarge), 6),
    });
  }

  return {
    smallerAnalysisId: smaller.id,
    largerAnalysisId: larger.id,
    smallerTotalSeats: smaller.totalSeats,
    largerTotalSeats: larger.totalSeats,
    deltaSeats: larger.totalSeats - smaller.totalSeats,
    rows,
    gainedRegions,
    monotonic,
  };
}
