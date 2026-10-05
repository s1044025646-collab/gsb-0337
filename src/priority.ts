import { AppError } from "./errors";
import type { CandidateMetric, ExactMetric, Region, RegionInput } from "./types";
import type { Limits } from "./config";

const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

/**
 * 校验人口版本输入并规范化。
 * - 编号去空格后不得为空
 * - 人口必须是严格正整数（拒绝前导零、小数、负号、非数字）
 * - 编号不得重复（与输入顺序无关）
 */
export function validateRegions(input: unknown, limits: Limits): Region[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AppError("REGION_EMPTY", "地区列表必须是非空数组");
  }
  if (input.length > limits.maxRegions) {
    throw new AppError(
      "TOO_MANY_REGIONS",
      `地区数 ${input.length} 超过上限 ${limits.maxRegions}`,
    );
  }

  const seen = new Set<string>();
  const regions: Region[] = [];

  for (const item of input) {
    if (typeof item !== "object" || item === null) {
      throw new AppError("INVALID_REQUEST", "每个地区必须是对象 {code, population}");
    }
    const rawCode = (item as { code?: unknown }).code;
    const rawPop = (item as { population?: unknown }).population;
    const code = typeof rawCode === "string" ? rawCode.trim() : "";
    if (code === "") {
      throw new AppError("INVALID_REQUEST", "地区编号必须是非空字符串");
    }
    if (seen.has(code)) {
      throw new AppError("REGION_CODE_DUPLICATE", `地区编号重复: ${code}`, { code });
    }

    if (typeof rawPop !== "string") {
      throw new AppError(
        "POPULATION_NOT_POSITIVE_INTEGER",
        `地区 ${code} 的人口必须是十进制整数字符串`,
        { code },
      );
    }
    const population = rawPop.trim();
    if (!DECIMAL_RE.test(population) || population === "0") {
      throw new AppError(
        "POPULATION_NOT_POSITIVE_INTEGER",
        `地区 ${code} 的人口必须是严格正整数（拒绝零、负数、小数）: ${rawPop}`,
        { code, population: rawPop },
      );
    }
    if (population.length > limits.maxPopulationDigits) {
      throw new AppError(
        "POPULATION_TOO_MANY_DIGITS",
        `地区 ${code} 的人口位数 ${population.length} 超过上限 ${limits.maxPopulationDigits}`,
        { code, digits: population.length, limit: limits.maxPopulationDigits },
      );
    }

    seen.add(code);
    regions.push({ code, population, populationBig: BigInt(population) });
  }

  return regions;
}

export function validateTotalSeats(totalSeats: unknown, regionCount: number, limits: Limits): number {
  if (typeof totalSeats !== "number" || !Number.isInteger(totalSeats)) {
    throw new AppError("SEATS_NOT_INTEGER", "总席位必须是整数");
  }
  if (totalSeats < regionCount) {
    throw new AppError(
      "SEATS_BELOW_REGION_COUNT",
      `总席位 ${totalSeats} 不能少于地区数 ${regionCount}（本题强制每地至少一席，不允许丢弃小地区）`,
      { totalSeats, regionCount },
    );
  }
  if (totalSeats > limits.maxTotalSeats) {
    throw new AppError(
      "SEATS_ABOVE_LIMIT",
      `总席位 ${totalSeats} 超过上限 ${limits.maxTotalSeats}`,
      { totalSeats, limit: limits.maxTotalSeats },
    );
  }
  return totalSeats;
}

/**
 * 地区已有 n 席时的下一优先级 = population / sqrt(n*(n+1))。
 * 返回平方分数 a/b 所需的 a=population^2 与 b=n(n+1)，以及展示用近似值。
 */
export function exactMetric(population: bigint, n: number): ExactMetric {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new AppError("INVALID_REQUEST", `席位数非法: ${n}`);
  }
  const numeratorSq = population * population;
  const denominator = BigInt(n) * BigInt(n + 1);
  return {
    numeratorSq: numeratorSq.toString(),
    denominator: denominator.toString(),
    priorityApprox: approximatePriority(population, n),
  };
}

/** 仅供展示的小数近似，绝不参与实际选择 */
export function approximatePriority(population: bigint, n: number, digits = 12): string {
  const denominator = BigInt(n) * BigInt(n + 1);
  const scale = 10n ** BigInt(digits + 4);
  const ratioSqScaled = (population * population * scale) / denominator;
  const intSqrt = bigIntSqrt(ratioSqScaled);
  const sqrtScale = 10n ** BigInt((digits + 4) / 2);
  const whole = intSqrt / sqrtScale;
  const frac = intSqrt % sqrtScale;
  return `${whole.toString()}.${frac.toString().padStart((digits + 4) / 2, "0").slice(0, digits)}`;
}

/** 大整数平方根（向下取整） */
export function bigIntSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("sqrt of negative");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

interface Fraction {
  num: bigint; // population^2
  den: bigint; // n*(n+1)
}

function metricFraction(region: Region, n: number): Fraction {
  return { num: region.populationBig * region.populationBig, den: BigInt(n) * BigInt(n + 1) };
}

/**
 * 严格比较两个正优先级：比较平方分数的交叉乘积。
 * 返回 >0 表示 a 更高，<0 表示 b 更高，0 表示精确相等。
 */
export function compareFraction(a: Fraction, b: Fraction): number {
  const left = a.num * b.den;
  const right = b.num * a.den;
  if (left > right) return 1;
  if (left < right) return -1;
  return 0;
}

/**
 * 平局打破：按地区编号固定顺序（Unicode 码点字典序），取排在前者。
 * 输入顺序不影响结果。
 */
export function codeOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function candidateOf(region: Region, seatsBefore: number): CandidateMetric {
  return { code: region.code, seatsBefore, ...exactMetric(region.populationBig, seatsBefore) };
}

/**
 * 在当前席位状态下，独立扫描全部地区选出下一获胜者。
 * 每轮都全量扫描（参考实现语义），不依赖任何增量结构。
 */
export function pickWinner(
  regions: Region[],
  seats: Map<string, number>,
): { winner: Region; candidate: CandidateMetric; candidates: CandidateMetric[] } {
  const ordered = [...regions].sort((x, y) => codeOrder(x.code, y.code));
  const candidates: CandidateMetric[] = [];
  let best: { region: Region; seatsBefore: number } | undefined;
  let bestFraction: Fraction | undefined;

  for (const region of ordered) {
    const seatsBefore = seats.get(region.code) ?? 0;
    candidates.push(candidateOf(region, seatsBefore));
    const fraction = metricFraction(region, seatsBefore);
    if (best === undefined || bestFraction === undefined) {
      best = { region, seatsBefore };
      bestFraction = fraction;
      continue;
    }
    const cmp = compareFraction(fraction, bestFraction);
    // 精确相等时因 ordered 已按编号升序，保持先出现者，不更新
    if (cmp > 0) {
      best = { region, seatsBefore };
      bestFraction = fraction;
    }
  }

  if (!best) throw new AppError("INTERNAL", "无法选出获胜地区");
  return {
    winner: best.region,
    candidate: candidateOf(best.region, best.seatsBefore),
    candidates,
  };
}
