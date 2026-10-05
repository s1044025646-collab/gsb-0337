import { defaultLimits, type Limits } from "./config";
import { runApportionment } from "./engine";
import { validateRegions } from "./priority";
import { Store, type StoredAnalysis, type StoredVersion } from "./store";
import { compareAnalyses, type CompareReport } from "./compare";

export class Service {
  readonly store: Store;
  readonly limits: Limits;

  constructor(dbPath: string, limits?: Limits) {
    this.store = new Store(dbPath);
    this.limits = limits ?? defaultLimits();
  }

  close(): void {
    this.store.close();
  }

  createVersion(regions: unknown): StoredVersion {
    return this.store.createVersion(validateRegions(regions, this.limits));
  }

  listVersions(): StoredVersion[] {
    return this.store.listVersions();
  }

  getVersion(id: number): StoredVersion {
    return this.store.getVersion(id);
  }

  runAnalysis(
    versionId: number,
    totalSeats: number,
  ): { analysis: StoredAnalysis; reused: boolean } {
    const version = this.store.getVersion(versionId);
    const { result } = runApportionment(version.regions, totalSeats, this.limits);
    return this.store.createAnalysis(versionId, totalSeats, result);
  }

  getAnalysis(id: number): StoredAnalysis {
    return this.store.getAnalysis(id);
  }

  listAnalyses(versionId?: number) {
    return this.store.listAnalyses(versionId);
  }

  compare(smallerId: number, largerId: number): CompareReport {
    return compareAnalyses(this.store.getAnalysis(smallerId), this.store.getAnalysis(largerId));
  }
}
