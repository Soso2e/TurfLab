import type { SimulationInput } from "../packages/simulation/src/engine";
import { CUTOFF, SOURCE } from "./fixtures";
export const simulationFixture: SimulationInput = {
  cutoff_at: CUTOFF,
  distance_m: 1600,
  going_factor: 1,
  segments: [
    { length_m: 1000, gradient: 0.005, curvature: 0.3, phase: "middle" },
    { length_m: 600, gradient: 0.002, curvature: 0, phase: "finish" },
  ],
  scenarios: [
    { pace: "slow", weight: 0.3 },
    { pace: "middle", weight: 0.5 },
    { pace: "high", weight: 0.2 },
  ],
  runners: [1, 2, 3, 4].map((i) => ({
    entry_id: `e${i}`,
    horse_number: i,
    speed: 0.5 + i * 0.025,
    stamina: 0.6,
    acceleration: 0.6,
    early_position: 0.5,
    jockey_control: 0.5,
    draw: i,
    going_fit: 0.6,
    confidence: 0.5,
    source: SOURCE,
  })),
};
