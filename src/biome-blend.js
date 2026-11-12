// Percentages measure soft-weighted railway distance, never object counts or map area.
import { clamp, lerp, wrap, smoothstep } from './core.js?v=8.0.0';

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

export function createBiomeLayout(route, input) {
  const mix=normalizeMix(input), length=route.length;
  const lead=Math.min(length*mix[0].percent/100*0.35,180);
  let cursor=0;
  const regions=mix.map((row,index)=>{const start=cursor;cursor+=length*row.percent/100;return{...row,index,start,end:cursor,metres:cursor-start};});
  const boundaries=regions.length===1?[]:regions.map((region,index)=>({at:region.start,left:regions[(index+regions.length-1)%regions.length].biome,right:region.biome,halfWidth:Math.min(75,regions[(index+regions.length-1)%regions.length].metres*0.2,region.metres*0.2)}));
  function weightsAtDistance(distance,out={}) {
    for(const key of Object.keys(out))delete out[key];
    const s=wrap(distance+lead,length);
    const own=regions.find(region=>s>=region.start&&s<region.end)||regions.at(-1);
    out[own.biome]=1;
    for(const boundary of boundaries){const delta=wrap(s-boundary.at+length/2,length)-length/2;
      if(Math.abs(delta)<=boundary.halfWidth){const t=smoothstep(-boundary.halfWidth,boundary.halfWidth,delta);for(const key of Object.keys(out))delete out[key];out[boundary.left]=1-t;out[boundary.right]=t;break;}}
    return out;
  }
  // Coarse global segments cover the whole map; exact nearby queries preserve
  // the distance quota where the player actually drives. Far interiors fade
  // to the weighted regional base, avoiding a discontinuous Voronoi ridge.
  const anchors=Array.from({length:129},(_,i)=>({...route.sample(i/128*length),s:i/128*length}));
  function nearestPhase(x,z) {
    let best=Infinity,distance=0;
    for(let i=0;i<128;i++){const a=anchors[i],b=anchors[i+1],dx=b.x-a.x,dz=b.z-a.z,t=clamp(((x-a.x)*dx+(z-a.z)*dz)/(dx*dx+dz*dz),0,1),d=(x-a.x-t*dx)**2+(z-a.z-t*dz)**2;
      if(d<best){best=d;distance=lerp(a.s,b.s,t);}}
    if(best<180**2){const exact=route.nearestTo(x,z,Math.max(32,Math.sqrt(best)+8));if(exact.distanceAlong!==undefined)return{s:exact.distanceAlong,distance:exact.distance};}
    return{s:distance,distance:Math.sqrt(best)};
  }
  let lastX=NaN,lastZ=NaN,lastWeights={};
  function weightsAt(x,z) {
    if(x===lastX&&z===lastZ)return lastWeights;
    const nearest=nearestPhase(x,z),out=weightsAtDistance(nearest.s,{});
    const fade=smoothstep(145,290,nearest.distance);
    if(fade>0)for(const row of mix)out[row.biome]=lerp(out[row.biome]||0,row.percent/100,fade);
    lastX=x;lastZ=z;lastWeights=out;return out;
  }
  function choose(weights,random=Math.random){let remaining=random();for(const row of mix){remaining-=weights[row.biome]||0;if(remaining<0)return row.biome;}return mix.at(-1).biome;}
  function dominant(weights){let id=mix[0].biome,best=-1;for(const row of mix)if((weights[row.biome]||0)>best){id=row.biome;best=weights[row.biome]||0;}return id;}
  function report(samples=16384){const sums=Object.fromEntries(mix.map(row=>[row.biome,0]));for(let i=0;i<samples;i++){const weights=weightsAtDistance((i+.5)/samples*length);for(const row of mix)sums[row.biome]+=(weights[row.biome]||0)/samples*length;}
    return{basis:'rail-distance-soft-weight',transitionIncluded:true,routeLengthMetres:length,maximumTransitionMetres:boundaries.length?Math.max(...boundaries.map(row=>row.halfWidth*2)):0,regions:regions.map(row=>({biome:row.biome,requestedPercent:row.percent,actualPercent:sums[row.biome]/length*100,weightedMetres:sums[row.biome],nominalMetres:row.metres,startDistance:wrap(row.start-lead,length),endDistance:wrap(row.end-lead,length)}))};}
  return{mix,regions,boundaries,lead,weightsAtDistance,weightsAt,nearestPhase,choose,dominant,report,
    centerOf:biome=>{const r=regions.find(region=>region.biome===biome);return r?wrap((r.start+r.end)*.5-lead,length):null;}};
}
