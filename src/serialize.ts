import { RULES_VERSION } from "./config";
import { resultRows } from "./engine";
import type { StoredAnalysis, StoredVersion } from "./store";
import type { CompareReport } from "./compare";

export function versionJson(v: StoredVersion) {
  return {
    id: v.id,
    createdAt: v.createdAt,
    regionCount: v.regions.length,
    regions: v.regions.map((r) => ({ code: r.code, population: r.population })),
  };
}

export function analysisJson(a: StoredAnalysis, candidateRound?: number, candidateCode?: string) {
  const rows = resultRows(a.regions, a.result.seatsByCode);
  const payload: Record<string, unknown> = {
    id: a.id,
    versionId: a.versionId,
    totalSeats: a.totalSeats,
    rulesVersion: a.rulesVersion,
    createdAt: a.createdAt,
    regions: rows,
    rounds: a.result.rounds.map((round) => ({
      round: round.round,
      winnerCode: round.winnerCode,
      seatsBefore: round.seatsBefore,
      seatsAfter: round.seatsAfter,
      winner: round.winner,
      candidates: round.candidates,
    })),
  };
  if (candidateRound !== undefined && candidateCode !== undefined) {
    const round = a.result.rounds.find((r) => r.round === candidateRound);
    const candidate = round?.candidates.find((c) => c.code === candidateCode);
    if (round && candidate) {
      payload.candidateView = {
        round: round.round,
        candidate,
        winnerCode: round.winnerCode,
        relation:
          candidate.code === round.winnerCode
            ? "winner"
            : candidate.numeratorSq === round.winner.numeratorSq &&
                candidate.denominator === round.winner.denominator
              ? "equal"
              : "below",
      };
    }
  }
  return payload;
}

export function compareJson(c: CompareReport) {
  return {
    note:
      "报告仅说明新增席位去向与各地区人口每席；不声称任何比例指标最优，也不保证满足其他分摊方法的配额公理。",
    rulesVersion: RULES_VERSION,
    ...c,
  };
}

export function toCsv(analysis: StoredAnalysis): string {
  const lines = ["code,population,seats,population_per_seat"];
  for (const row of resultRows(analysis.regions, analysis.result.seatsByCode)) {
    lines.push(`${row.code},${row.population},${row.seats},${row.populationPerSeat}`);
  }
  return `${lines.join("\r\n")}\r\n`;
}
