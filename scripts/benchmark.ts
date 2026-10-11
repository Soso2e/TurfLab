import { simulate } from "../packages/simulation/src/engine";
import { simulationFixture } from "../tests/simulation-fixture";
const start = performance.now();
const result = await simulate(
  {
    ...simulationFixture,
    runners: Array.from({ length: 18 }, (_, i) => ({
      ...simulationFixture.runners[i % 4],
      entry_id: `e${i}`,
      horse_number: i + 1,
      draw: i + 1,
    })),
  },
  42,
  10000,
);
process.stdout.write(
  JSON.stringify({
    engine: result.engine_version,
    trial_count: result.trial_count,
    runners: 18,
    elapsed_ms: performance.now() - start,
    runtime: process.version,
    location: "local-node; Workersの実測ではない",
  }) + "\n",
);
