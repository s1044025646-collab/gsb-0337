export type RegionInput = {
  id: string;
  population: string;
};

export type Limits = {
  maxRegions: number;
  maxPopulationDigits: number;
  maxTotalSeats: number;
};

export type Region = {
  id: string;
  population: bigint;
};

export type ExactPriority = {
  regionId: string;
  seatsBeforeRound: number;
  population: string;
  priorityNumerator: string;
  priorityDenominator: string;
};

export type RegionCandidatePriority = ExactPriority & {
  currentSeats: number;
  nextSeatNumber: number;
  priorityApproximation: string;
};

export type AllocationRound = {
  roundNumber: number;
  seatNumber: number;
  awardedRegionId: string;
  seatsBefore: number;
  seatsAfter: number;
  winner: ExactPriority;
  candidates: ExactPriority[];
  relationships: Array<{
    regionId: string;
    crossProductWithWinner: string;
    winnerCrossProduct: string;
    comparison: "winner" | "equal" | "candidate";
  }>;
};

export type AllocationResult = {
  regions: Region[];
  totalSeats: number;
  rounds: AllocationRound[];
  finalSeats: Record<string, number>;
};

export const RULE_VERSION = "huntington-hill-1.0.0";

export const DEFAULT_LIMITS: Limits = {
  maxRegions: 1000,
  maxPopulationDigits: 39,
  maxTotalSeats: 100000
};

export class ValidationError extends Error {
  code = "VALIDATION_ERROR";
  details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

export class LimitError extends Error {
  code = "LIMIT_EXCEEDED";
  details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "LimitError";
    this.details = details;
  }
}

export function normalizeLimits(input: Partial<Limits> | undefined, fallback: Limits = DEFAULT_LIMITS): Limits {
  const values = {
    maxRegions: input?.maxRegions ?? fallback.maxRegions,
    maxPopulationDigits: input?.maxPopulationDigits ?? fallback.maxPopulationDigits,
    maxTotalSeats: input?.maxTotalSeats ?? fallback.maxTotalSeats
  };

  for (const [key, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ValidationError(`${key} 必须是正安全整数`, { field: key, value });
    }
  }
  if (values.maxTotalSeats < values.maxRegions) {
    throw new ValidationError("总席位上限不能小于地区数上限", values);
  }
  return values;
}

export function validateRegions(input: unknown, limits: Limits = DEFAULT_LIMITS): Region[] {
  if (!Array.isArray(input)) {
    throw new ValidationError("regions 必须是数组");
  }
  if (input.length === 0) {
    throw new ValidationError("至少需要一个地区");
  }
  if (input.length > limits.maxRegions) {
    throw new LimitError("地区数超过上限", {
      size: input.length,
      maxRegions: limits.maxRegions
    });
  }

  const seen = new Set<string>();
  const normalized: Region[] = [];

  input.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      throw new ValidationError(`第 ${index} 个地区不是对象`, { index });
    }
    const region = item as Partial<RegionInput>;
    if (typeof region.id !== "string" || !/^[1-9][0-9]*$/.test(region.id)) {
      throw new ValidationError(`第 ${index} 个地区编号必须是无前导零的正十进制整数字符串`, { index });
    }
    if (typeof region.population !== "string" || !/^[1-9][0-9]*$/.test(region.population)) {
      throw new ValidationError(`地区 ${region.id ?? index} 的人口必须是无前导零的正十进制整数字符串`, {
        regionId: region.id,
        index
      });
    }
    if (region.population.length > limits.maxPopulationDigits) {
      throw new LimitError(`地区 ${region.id} 的人口位数超过上限`, {
        regionId: region.id,
        digits: region.population.length,
        maxPopulationDigits: limits.maxPopulationDigits
      });
    }
    if (seen.has(region.id)) {
      throw new ValidationError(`地区编号重复: ${region.id}`, { regionId: region.id });
    }
    seen.add(region.id);
    let population: bigint;
    try {
      population = BigInt(region.population);
    } catch {
      throw new ValidationError(`地区 ${region.id} 的人口无法解析为整数`);
    }
    if (population <= 0n) {
      throw new ValidationError(`地区 ${region.id} 的人口必须严格为正`, { regionId: region.id });
    }
    normalized.push({ id: region.id, population });
  });

  return normalized.sort((a, b) => compareRegionId(a.id, b.id));
}

export function validateTotalSeats(totalSeats: unknown, regionCount: number, limits: Limits): number {
  if (typeof totalSeats !== "number" || !Number.isSafeInteger(totalSeats)) {
    throw new ValidationError("总席位必须是安全整数");
  }
  if (totalSeats < regionCount) {
    throw new ValidationError("总席位不能少于地区数；本题强制每个地区至少一席，不能丢弃小地区", {
      totalSeats,
      regionCount
    });
  }
  if (totalSeats > limits.maxTotalSeats) {
    throw new LimitError("总席位超过上限", {
      totalSeats,
      maxTotalSeats: limits.maxTotalSeats
    });
  }
  return totalSeats;
}

export function compareRegionId(left: string, right: string): number {
  const lengthDifference = left.length - right.length;
  if (lengthDifference !== 0) return lengthDifference;
  return left < right ? -1 : left > right ? 1 : 0;
}

function priority(region: Region, seats: number): ExactPriority {
  const populationSquared = region.population * region.population;
  const denominator = BigInt(seats) * BigInt(seats + 1);
  return {
    regionId: region.id,
    seatsBeforeRound: seats,
    population: region.population.toString(),
    priorityNumerator: populationSquared.toString(),
    priorityDenominator: denominator.toString()
  };
}

function chooseHigher(left: ExactPriority, right: ExactPriority): ExactPriority {
  const leftCross = BigInt(left.priorityNumerator) * BigInt(right.priorityDenominator);
  const rightCross = BigInt(right.priorityNumerator) * BigInt(left.priorityDenominator);
  if (leftCross > rightCross) return left;
  if (rightCross > leftCross) return right;
  return compareRegionId(left.regionId, right.regionId) <= 0 ? left : right;
}

export function allocate(regionsInput: unknown, totalSeatsInput: unknown, limitsInput: Partial<Limits> = {}): AllocationResult {
  const limits = normalizeLimits(limitsInput);
  const regions = validateRegions(regionsInput, limits);
  const totalSeats = validateTotalSeats(totalSeatsInput, regions.length, limits);
  const seats = new Map<string, number>(regions.map((region) => [region.id, 1]));
  const nextPriority = new Map<string, ExactPriority>();
  for (const region of regions) {
    nextPriority.set(region.id, priority(region, 1));
  }

  const rounds: AllocationRound[] = [];
  for (let seatNumber = regions.length + 1; seatNumber <= totalSeats; seatNumber += 1) {
    const candidates = regions.map((region) => {
      const candidate = nextPriority.get(region.id);
      if (!candidate) throw new Error(`缺少地区 ${region.id} 的候选优先级`);
      return candidate;
    });
    const winner = candidates.reduce((best, candidate) => chooseHigher(best, candidate));
    const before = seats.get(winner.regionId) ?? 0;
    const after = before + 1;

    const relationships = candidates.map((candidate) => {
      const candidateCross = BigInt(candidate.priorityNumerator) * BigInt(winner.priorityDenominator);
      const winnerCross = BigInt(winner.priorityNumerator) * BigInt(candidate.priorityDenominator);
      return {
        regionId: candidate.regionId,
        crossProductWithWinner: candidateCross.toString(),
        winnerCrossProduct: winnerCross.toString(),
        comparison:
          candidate.regionId === winner.regionId
            ? "winner"
            : candidateCross === winnerCross
              ? "equal"
              : candidateCross < winnerCross
                ? "winner"
                : "candidate"
      } as const;
    });

    rounds.push({
      roundNumber: rounds.length + 1,
      seatNumber,
      awardedRegionId: winner.regionId,
      seatsBefore: before,
      seatsAfter: after,
      winner,
      candidates,
      relationships
    });

    seats.set(winner.regionId, after);
    const awardedRegion = regions.find((region) => region.id === winner.regionId);
    if (!awardedRegion) throw new Error(`获席地区不存在: ${winner.regionId}`);
    nextPriority.set(winner.regionId, priority(awardedRegion, after));
  }

  const finalSeats = Object.fromEntries(regions.map((region) => [region.id, seats.get(region.id) ?? 0]));
  assertPublication(regions, totalSeats, finalSeats);
  return { regions, totalSeats, rounds, finalSeats };
}

export function assertPublication(
  regions: Region[],
  totalSeats: number,
  finalSeats: Record<string, number>
): void {
  const sum = regions.reduce((total, region) => total + (finalSeats[region.id] ?? 0), 0);
  if (sum !== totalSeats) {
    throw new Error(`发布校验失败：席位总数 ${sum} 不等于 ${totalSeats}`);
  }
  const missing = regions.filter((region) => (finalSeats[region.id] ?? 0) < 1).map((region) => region.id);
  if (missing.length > 0) {
    throw new Error(`发布校验失败：以下地区少于一席: ${missing.join(", ")}`);
  }
}

export function approximateRatio(numerator: string | bigint, denominator: string | bigint, fractionDigits = 6): string {
  const numeratorBig = BigInt(numerator);
  const denominatorBig = BigInt(denominator);
  if (denominatorBig <= 0n) throw new ValidationError("近似小数分母必须为正");
  const scale = 10n ** BigInt(fractionDigits);
  const scaled = numeratorBig * scale * 10n;
  const quotient = scaled / denominatorBig;
  const rounded = (quotient + 5n) / 10n;
  const integer = rounded / scale;
  const fraction = (rounded % scale).toString().padStart(fractionDigits, "0");
  return `${integer}.${fraction}`;
}

export function candidatePriority(region: Region, currentSeats: number): RegionCandidatePriority {
  if (!Number.isSafeInteger(currentSeats) || currentSeats < 1) {
    throw new ValidationError("当前席位数必须是正安全整数");
  }
  const populationSquared = region.population * region.population;
  const denominator = BigInt(currentSeats) * BigInt(currentSeats + 1);
  return {
    regionId: region.id,
    currentSeats,
    nextSeatNumber: currentSeats + 1,
    seatsBeforeRound: currentSeats,
    population: region.population.toString(),
    priorityNumerator: populationSquared.toString(),
    priorityDenominator: denominator.toString(),
    priorityApproximation: priorityApproximation(region.population, denominator)
  };
}

function isqrt(value: bigint): bigint {
  if (value <= 0n) return 0n;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

function priorityApproximation(population: bigint, denominator: bigint, fractionDigits = 6): string {
  const scale = 10n ** BigInt(fractionDigits);
  const scaledRoot = isqrt(denominator * scale * scale);
  return approximateRatio(population * scale, scaledRoot, fractionDigits);
}

export function canonicalPopulationChecksum(regions: Region[], limits: Limits): string {
  const canonical = JSON.stringify({
    ruleVersion: RULE_VERSION,
    limits,
    regions: regions.map((region) => ({ id: region.id, population: region.population.toString() }))
  });
  const bytes = new TextEncoder().encode(canonical);
  let hash = 2166136261 >>> 0;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  const numeric = (hash >>> 0).toString(16).padStart(8, "0");
  let high = 0n;
  for (const byte of bytes) {
    high = (high * 131n + BigInt(byte)) & ((1n << 64n) - 1n);
  }
  return `${numeric}${high.toString(16).padStart(16, "0")}`;
}
