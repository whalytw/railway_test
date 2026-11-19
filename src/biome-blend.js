// Each geographical coordinate has one shared biome mixture.
import { TAU, clamp, smoothstep, randomGenerator } from './core.js?v=13.0.0';

export const BIOME_IDS = ['Forest','Hills','Pastoral','Desert','Rural','Lakeside','Snow','Volcano'];
export const BIOME_COLORS = { Forest:'#58816a', Hills:'#9eac71', Pastoral:'#d0b662', Desert:'#d4a879', Rural:'#a68162', Lakeside:'#6da7b4', Snow:'#c6dcdf', Volcano:'#897389' };
export const DEFAULT_MIX = [{biome:'Forest',percent:35},{biome:'Hills',percent:25},{biome:'Pastoral',percent:25},{biome:'Lakeside',percent:15}];

export function normalizeMix(entries, strict = true) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 4) throw new Error('請選擇 1～4 種環境。');
  const seen = new Set(), result = [];
  for (const row of entries) {
    const percent = Number(row.percent), biome = row.biome;
    if (!BIOME_IDS.includes(biome) || seen.has(biome)) throw new Error('每個環境槽請選擇不同地形。');
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('地形比例必須介於 0% 與 100%。');
    seen.add(biome); if (percent > 0) result.push({biome,percent});
  }
  const total = result.reduce((sum,row)=>sum+row.percent,0);
  if (!result.length || strict && Math.abs(total-100)>1e-6) throw new Error('環境比例合計必須是 100%。');
  return result.map(row=>({...row,percent:row.percent/total*100}));
}

export function proportionalIntegers(values, total = 100) {
  if (!values.length) return [];
  const sum=values.reduce((a,b)=>a+Math.max(0,b),0);
  const exact=values.map(value=>(sum?Math.max(0,value)/sum:1/values.length)*total);
  const result=exact.map(Math.floor);
  const order=exact.map((value,index)=>({index,remainder:value-result[index]})).sort((a,b)=>b.remainder-a.remainder||a.index-b.index);
  for(let left=total-result.reduce((a,b)=>a+b,0),i=0;left>0;left--,i++)result[order[i%order.length].index]++;
  return result;
}
export function redistributeShares(entries,index,value) {
  if (!entries[index] || entries.length>4 || entries.length<1) throw new Error('環境槽不存在。');
  const next=entries.map(row=>({...row}));
  if(next.length===1){next[0].percent=100;return next;}
  const selected=Math.round(clamp(Number(value)||0,0,100));
  const others=next.map((row,i)=>({row,i})).filter(row=>row.i!==index);
  const shares=proportionalIntegers(others.map(item=>item.row.percent),100-selected);
  next[index].percent=selected;others.forEach((item,i)=>next[item.i].percent=shares[i]);return next;
}
export function randomMix(random=Math.random,count=4,selected=null) {
  count=Math.round(clamp(count,1,4));
  const choices=selected?[...selected]:[...BIOME_IDS];
  if(!selected)for(let i=choices.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[choices[i],choices[j]]=[choices[j],choices[i]];}
  const ids=choices.slice(0,count),minimum=count===1?100:5;
  const shares=proportionalIntegers(ids.map(()=>0.1+random()**1.4),100-minimum*count);
  return ids.map((biome,i)=>({biome,percent:minimum+shares[i]}));
}

export function createBiomeLayout(route, input, seed = 'map') {
  const mix = normalizeMix(input), d = route.squareSize, halfDepth = route.halfDepth ?? d / 2, area = 4 * d * halfDepth;
  const random = randomGenerator(seed + ':biome-field');
  const phase = Array.from({ length: 3 }, () => random() * TAU);
  const tilt = (random() - 0.5) * 0.58;
  const halfWidth = mix.length === 1 ? 0 : clamp(d * 0.09, 56, 105);
  function field(x, z) {
    const u = x / d, v = z / d;
    return x + tilt * z + d * (0.18 * Math.sin(TAU * v + phase[0])
      + 0.074 * Math.sin(2 * TAU * v + phase[1])
      + 0.047 * Math.sin(TAU * (v + 0.48 * u) + phase[2]));
  }

  // Solve the cumulative area of each smooth boundary on a uniform world grid.
  // Shared transition widths keep the cumulative weights ordered in small regions.
  const nx = 160, nz = 80, samples = new Float64Array(nx * nz);
  let low = Infinity, high = -Infinity;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const value = field(-d + (i + 0.5) / nx * 2 * d, (j + 0.5) / nz * (2 * halfDepth) - halfDepth);
    samples[j * nx + i] = value;
    low = Math.min(low, value); high = Math.max(high, value);
  }
  let accumulated = 0;
  const boundaries = mix.slice(0, -1).map(row => {
    accumulated += row.percent / 100;
    let left = low - halfWidth, right = high + halfWidth;
    for (let step = 0; step < 28; step++) {
      const mid = (left + right) / 2;
      let included = 0;
      for (const value of samples) included += 1 - smoothstep(mid - halfWidth, mid + halfWidth, value);
      if (included < accumulated * samples.length) left = mid;
      else right = mid;
    }
    return (left + right) / 2;
  });
  function weightsAtField(value, out) {
    let previous = 0;
    for (const [i, boundary] of boundaries.entries()) {
      const next = 1 - smoothstep(boundary - halfWidth, boundary + halfWidth, value);
      out[mix[i].biome] = next - previous;
      previous = next;
    }
    out[mix.at(-1).biome] = 1 - previous;
    return out;
  }
  let lastX = NaN, lastZ = NaN, lastWeights;
  const single = mix.length === 1 ? { [mix[0].biome]: 1 } : null;
  function weightsAt(x, z, out) {
    if (out) return weightsAtField(field(x, z), out);
    if (single) return single;
    if (x !== lastX || z !== lastZ) {
      lastX = x; lastZ = z;
      lastWeights = weightsAtField(field(x, z), {});
    }
    return lastWeights;
  }
  const location = {};
  function weightsAtDistance(distance, out = {}) {
    const p = route.sample(distance, location);
    return weightsAt(p.x, p.z, out);
  }
  function choose(weights, randomSource = Math.random) {
    let remaining = randomSource();
    for (const row of mix) {
      remaining -= weights[row.biome] || 0;
      if (remaining < 0) return row.biome;
    }
    return mix.at(-1).biome;
  }
  function dominant(weights) {
    let best = mix[0].biome;
    for (const row of mix) if ((weights[row.biome] || 0) > (weights[best] || 0)) best = row.biome;
    return best;
  }
  function report(railSamples = 4096) {
    const areaShares = mix.map(() => 0), railShares = mix.map(() => 0), weights = {};
    // Independently measure the finished field with a finer grid.
    const columns = 192, rows = 96;
    for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
      weightsAt(-d + (i + 0.5) / columns * 2 * d, (j + 0.5) / rows * (2 * halfDepth) - halfDepth, weights);
      mix.forEach((row, k) => { areaShares[k] += weights[row.biome]; });
    }
    for (let i = 0; i < railSamples; i++) {
      weightsAtDistance((i + 0.5) / railSamples * route.length, weights);
      mix.forEach((row, k) => { railShares[k] += weights[row.biome]; });
    }
    return {
      basis: 'map-area-soft-weight', mapAreaSquareMetres: area, transitionIncluded: true,
      nominalTransitionMetres: halfWidth * 2, routeLengthMetres: route.length,
      regions: mix.map((row, i) => {
        const share = areaShares[i] / (columns * rows), railShare = railShares[i] / railSamples;
        return { biome: row.biome, requestedPercent: row.percent, actualPercent: share * 100,
          weightedSquareMetres: share * area, routePercent: railShare * 100, routeWeightedMetres: railShare * route.length };
      })
    };
  }
  function centerOf(biome) {
    if (!mix.some(row => row.biome === biome)) return null;
    let best = 0, distance = null;
    const weights = {};
    for (let i = 0; i < 512; i++) {
      const s = route.length * (i + 0.5) / 512;
      const value = weightsAtDistance(s, weights)[biome];
      if (value > best) { best = value; distance = s; }
    }
    return distance;
  }
  return { mix, weightsAtDistance, weightsAt, choose, dominant, report, centerOf };
}
