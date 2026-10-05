import type { Limits } from "./config";
import { AppError } from "./errors";
import { candidateOf, pickWinner, validateRegions, validateTotalSeats } from "./priority";
import type { ApportionmentResult, Region, RegionInput, RoundRecord } from "./types";

/**
 * Huntington–Hill 等比例分摊：
 * 1. 每个地区先获得 1 个基础席位；
 * 2. 剩余席位逐个分配，每轮选优先级 population/sqrt(n(n+1)) 最高的地区；
 * 3. 平局按地区编号固定顺序（字典序）处理。
 * 全程使用 BigInt 交叉乘积比较，不做一次比例四舍五入。
 */
export function runApportionment(
  rawRegions: RegionInput[] | unknown,
  totalSeats: number,
  limits: Limits,
): { regions: Region[]; totalSeats: number; result: ApportionmentResult } {
  const regions = validateRegions(rawRegions, limits);
  validateTotalSeats(totalSeats, regions.length, limits);

  const seats = new Map<string, number>();
  for (const region of regions) seats.set(region.code, 1);

  const rounds: RoundRecord[] = [];
  let assigned = regions.length;
  let roundNo = 0;

  while (assigned < totalSeats) {
    roundNo += 1;
    const { winner, candidate, candidates } = pickWinner(regions, seats);
    const seatsBefore = seats.get(winner.code) ?? 0;
    const seatsAfter = seatsBefore + 1;
    seats.set(winner.code, seatsAfter);
    assigned += 1;
    rounds.push({
      round: roundNo,
      winnerCode: winner.code,
      seatsBefore,
      seatsAfter,
      winner: candidate,
      candidates,
    });
  }

  verifyTotals(regions, seats, totalSeats);
  return { regions, totalSeats, result: { rounds, seatsByCode: seats } };
}

/** 发布前核对：席位总数一致且每地至少一席 */
export function verifyTotals(
  regions: Region[],
  seats: Map<string, number>,
  totalSeats: number,
): void {
  let sum = 0;
  for (const region of regions) {
    const n = seats.get(region.code);
    if (n === undefined || n < 1) {
      throw new AppError("INTERNAL", `地区 ${region.code} 最终席位少于 1`);
    }
    sum += n;
  }
  if (sum !== totalSeats) {
    throw new AppError("INTERNAL", `席位总数核对失败: 合计 ${sum} != ${totalSeats}`);
  }
}

/** 从冻结快照重新回放，验证与持久化记录完全一致 */
export function replayFromSnapshot(
  regions: Region[],
  totalSeats: number,
  limits: Limits,
): ApportionmentResult {
  validateTotalSeats(totalSeats, regions.length, limits);
  const seats = new Map<string, number>();
  for (const region of regions) seats.set(region.code, 1);

  const rounds: RoundRecord[] = [];
  let assigned = regions.length;
  let roundNo = 0;
  while (assigned < totalSeats) {
    roundNo += 1;
    const { winner, candidate, candidates } = pickWinner(regions, seats);
    const seatsBefore = seats.get(winner.code) ?? 0;
    seats.set(winner.code, seatsBefore + 1);
    assigned += 1;
    rounds.push({
      round: roundNo,
      winnerCode: winner.code,
      seatsBefore,
      seatsAfter: seatsBefore + 1,
      winner: candidate,
      candidates,
    });
  }
  verifyTotals(regions, seats, totalSeats);
  return { rounds, seatsByCode: seats };
}

/** 查看指定地区在给定席位状态下的下一候选优先级，以及与本轮获胜者的关系 */
export function candidateRelation(
  region: Region,
  seatsBefore: number,
  winnerCode: string,
  winnerPopulation: bigint,
  winnerSeatsBefore: number,
): { candidate: ReturnType<typeof candidateOf>; relation: "winner" | "below" | "equal" } {
  const candidate = candidateOf(region, seatsBefore);
  if (region.code === winnerCode) return { candidate, relation: "winner" };
  const a = region.populationBig * region.populationBig * BigInt(winnerSeatsBefore) * BigInt(winnerSeatsBefore + 1);
  const b = winnerPopulation * winnerPopulation * BigInt(seatsBefore) * BigInt(seatsBefore + 1);
  if (a === b) return { candidate, relation: "equal" };
  return { candidate, relation: "below" };
}

export interface RegionResultRow {
  code: string;
  population: string;
  seats: number;
  /** 人口每席（展示近似，BigInt 定点） */
  populationPerSeat: string;
}

export function resultRows(regions: Region[], seats: Map<string, number>): RegionResultRow[] {
  return regions.map((region) => {
    const n = seats.get(region.code) ?? 0;
    return {
      code: region.code,
      population: region.population,
      seats: n,
      populationPerSeat: divideApprox(region.populationBig, BigInt(n), 6),
    };
  });
}

export function divideApprox(num: bigint, den: bigint, digits: number): string {
  if (den <= 0n) return "0";
  const scale = 10n ** BigInt(digits);
  const scaled = (num * scale) / den;
  const whole = scaled / scale;
  const frac = scaled % scale;
  return `${whole.toString()}.${frac.toString().padStart(digits, "0")}`;
}
