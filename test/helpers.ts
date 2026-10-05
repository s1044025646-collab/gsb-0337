import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../src/service";

export interface Harness {
  service: Service;
  dbPath: string;
}

export function tempService(): { service: Service; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hh-test-"));
  const dbPath = join(dir, "test.sqlite");
  const service = new Service(dbPath);
  return {
    service,
    dbPath,
    cleanup: () => {
      service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
