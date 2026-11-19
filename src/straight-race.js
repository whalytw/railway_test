import { clamp, DEPARTURE_COUNTDOWN, lerp } from './core.js?v=13.0.0';

export function checkRaceBoundary(view, beforeElapsed) {
  const { state, engine, previous, rig } = view;
  const finish = rig.track.length;
  let boundary;
  if (state.distance < 0) boundary = 0;
  else if (state.distance >= finish) {
    boundary = finish;
    const fraction = clamp((finish - previous.distance) / (state.distance - previous.distance), 0, 1);
    view.finishTime = Math.max(0, lerp(beforeElapsed, state.elapsed, fraction) - DEPARTURE_COUNTDOWN);
  } else return;
  state.odometer = Math.max(0, state.odometer - Math.abs(state.distance - boundary));
  engine.holdAt(state, boundary);
}

export function raceStandings(finishTimes) {
  const sorted = finishTimes.map((time, lane) => ({ time, lane })).sort((a, b) => a.time - b.time);
  let rank;
  return sorted.map((row, index) => {
    if (index === 0 || row.time.toFixed(3) !== sorted[index - 1].time.toFixed(3)) rank = index + 1;
    return { ...row, rank };
  });
}
