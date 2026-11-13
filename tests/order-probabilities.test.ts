import { expect, it } from "vitest";
import { simulateOrders } from "../scripts/bet-plans";
import {
  fitDiscount, MIN_DISCOUNT_RACES, orderLogLikelihood, orderProbabilities, ticketKey,
} from "../scripts/order-probabilities";

const p = new Map([[1, 0.5], [2, 0.3], [3, 0.2]]);

it("matches the closed-form Plackett-Luce values", () => {
  const exact = orderProbabilities(p);
  expect(exact.win).toEqual({ "1": 0.5, "2": 0.3, "3": 0.2 });
  // P(1 then 2) = 0.5 * 0.3 / (1 - 0.5)
  expect(exact.tickets["exacta:1-2"]).toBeCloseTo(0.3, 6);
  expect(exact.tickets["exacta:2-1"]).toBeCloseTo((0.3 * 0.5) / 0.7, 6);
  expect(exact.tickets["quinella:1-2"]).toBeCloseTo(0.3 + (0.3 * 0.5) / 0.7, 6);
  expect(exact.tickets["trio:1-2-3"]).toBeCloseTo(1, 6);
  expect(exact.top3["3"]).toBeCloseTo(1, 6);
  expect(ticketKey("wide", [3, 1])).toBe("wide:1-3");
});

it("adds up for a full field and ignores the scale of the input", () => {
  const field = new Map(Array.from({ length: 16 }, (_, i) => [i + 1, 1 + (i % 5)] as const));
  const exact = orderProbabilities(field);
  const total = (type: string) => Object.entries(exact.tickets)
    .filter(([k]) => k.startsWith(type + ":")).reduce((s, [, v]) => s + v, 0);
  expect(Object.values(exact.win).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
  expect(total("exacta")).toBeCloseTo(1, 3);
  expect(total("quinella")).toBeCloseTo(1, 3);
  expect(total("trio")).toBeCloseTo(1, 3);
  expect(total("wide")).toBeCloseTo(3, 3);
  expect(Object.values(exact.top3).reduce((a, b) => a + b, 0)).toBeCloseTo(3, 4);
  const doubled = orderProbabilities(new Map([...field].map(([n, v]) => [n, v * 2])));
  expect(doubled.tickets).toEqual(exact.tickets);
});

it("agrees with an independent simulation within sampling error, without its noise", () => {
  const field = new Map([[1, 0.17], [2, 0.1], [3, 0.085], [4, 0.175], [5, 0.11], [6, 0.18], [7, 0.18]]);
  const exact = orderProbabilities(field);
  const trials = 200_000;
  const mc = simulateOrders(field, trials, 5);
  for (const [key, value] of Object.entries(exact.tickets)) {
    const standardError = Math.sqrt((value * (1 - value)) / trials);
    expect(Math.abs(value - (mc.tickets[key] ?? 0))).toBeLessThan(5 * standardError + 1e-4);
  }
  // Same input, same output: there is no seed to vary.
  expect(orderProbabilities(field)).toEqual(exact);
});

it("moves place probability away from the favourite when discounted", () => {
  const field = new Map([[1, 0.6], [2, 0.2], [3, 0.1], [4, 0.1]]);
  const harville = orderProbabilities(field);
  const discounted = orderProbabilities(field, [0.8, 0.65]);
  expect(discounted.win).toEqual(harville.win);
  // The favourite's win chance is untouched, so less of the second-place mass
  // behind another winner goes to it and more to the outsiders.
  expect(discounted.tickets["exacta:2-1"]).toBeLessThan(harville.tickets["exacta:2-1"]);
  expect(discounted.top3["4"]).toBeGreaterThan(harville.top3["4"]);
  expect(Object.values(discounted.top3).reduce((a, b) => a + b, 0)).toBeCloseTo(3, 4);
});

it("reports no discount on a thin sample and recovers one from enough races", () => {
  const field = new Map([[1, 0.45], [2, 0.25], [3, 0.15], [4, 0.1], [5, 0.05]]);
  expect(orderLogLikelihood(field, [1, 2, 3], [1, 1])).toBeCloseTo(
    Math.log(0.45 * (0.25 / 0.55) * (0.15 / 0.3)), 9);
  expect(orderLogLikelihood(field, [1, 2, 9], [1, 1])).toBeNull();
  expect(fitDiscount([{ p: field, finish: [1, 2, 3] }])).toMatchObject({ discount: null, races: 1 });

  // Draw finishes from a known discounted model with a fixed generator.
  let state = 12345;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const truth = orderProbabilities(field, [0.7, 0.5]);
  const triples = Object.entries(truth.tickets).length; // only to keep the table used
  expect(triples).toBeGreaterThan(0);
  const draw = (): [number, number, number] => {
    const left = [...field.keys()];
    const order: number[] = [];
    [1, 0.7, 0.5].forEach((power) => {
      const weights = left.map((n) => field.get(n)! ** power);
      let pick = random() * weights.reduce((a, b) => a + b, 0);
      let index = 0;
      for (; index < left.length - 1; index++) {
        pick -= weights[index];
        if (pick <= 0) break;
      }
      order.push(left.splice(index, 1)[0]);
    });
    return order as [number, number, number];
  };
  const races = Array.from({ length: 3000 }, () => ({ p: field, finish: draw() }));
  const fitted = fitDiscount(races);
  expect(fitted.races).toBeGreaterThanOrEqual(MIN_DISCOUNT_RACES);
  expect(fitted.discount![0]).toBeGreaterThanOrEqual(0.55);
  expect(fitted.discount![0]).toBeLessThanOrEqual(0.85);
  expect(fitted.discount![1]).toBeLessThanOrEqual(0.7);
  expect(fitted.log_likelihood_gain!).toBeGreaterThan(0);
});
