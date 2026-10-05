export interface RegionInput {
  /** 地区稳定编号（非空字符串） */
  code: string;
  /** 规范十进制整数字符串，严格为正 */
  population: string;
}

export interface Region extends RegionInput {
  populationBig: bigint;
}

/** 精确比较量：优先级平方为 a/b，a = population^2，b = n(n+1) */
export interface ExactMetric {
  /** 优先级，十进制小数近似（仅供展示，绝不参与选择） */
  priorityApprox: string;
  /** 分子（人口平方，BigInt 十进制串） */
  numeratorSq: string;
  /** 分母（n*(n+1)） */
  denominator: string;
}

export interface CandidateMetric extends ExactMetric {
  code: string;
  /** 比较时该地区已有席位数 n */
  seatsBefore: number;
}

/** 单轮逐席分配记录 */
export interface RoundRecord {
  round: number;
  winnerCode: string;
  seatsBefore: number;
  seatsAfter: number;
  /** 获胜者用于本轮比较的精确量 */
  winner: CandidateMetric;
  /** 本轮参与比较的全部地区 */
  candidates: CandidateMetric[];
}

export interface ApportionmentResult {
  rounds: RoundRecord[];
  /** 各地区最终席位数 */
  seatsByCode: Map<string, number>;
}
