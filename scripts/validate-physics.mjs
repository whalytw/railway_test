import { writeFile } from 'node:fs/promises';
import { createPhysics, stepPhysics, createRoute, leverForSpeed, leverReference, RATED_POWER, CART_MASS } from '../src/core.js';
function run(throttle, grade, seconds = 240, state = createPhysics()) {
  for (let i = 0; i < seconds * 120; i++) stepPhysics(state, 1 / 120, throttle, grade);
  return state;
}
const lever90 = leverForSpeed(90), full = run(1, 0), speedBeforeReduction = full.speed * 3.6;
const reduction = run(lever90, 0, 180, full).speed * 3.6;
const results = {
  version: '2.0.0', massKg: CART_MASS, ratedPowerWatts: RATED_POWER, ratedHorsepower: RATED_POWER / 745.699872,
  lever90: leverReference(lever90), old53PercentPosition: leverReference(0.53),
  constantSlopeEquilibriaKmh: { flat90: run(lever90, 0).speed * 3.6, uphill25Permille90: run(lever90, 0.025).speed * 3.6,
    downhill25Permille90: run(lever90, -0.025).speed * 3.6, uphill25PermilleFull: run(1, 0.025).speed * 3.6 },
  flatLeverReduction: { beforeKmh: speedBeforeReduction, referenceKmh: 90, afterKmh: reduction },
  routeFeasibility: []
};
for (const length of [5000, 8000, 15000]) for (const stations of [2, 3]) {
  const route = createRoute(length, 'vertical', 8192, { elevationLimit: 500, stations });
  results.routeFeasibility.push({ lengthMetres: route.length, stations, actualThreeDimensionalLength: route.distances.at(-1), elevation: route.elevation });
}
await writeFile(new URL('../validation/physics-v2-results.json', import.meta.url), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
