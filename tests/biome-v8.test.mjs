import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
registerHooks({resolve(s,c,next){return s==='three'?{url:new URL('../vendor/three.module.js',import.meta.url).href,shortCircuit:true}:next(s,c);}});
import { createRoute, randomGenerator } from '../src/core.js';
import { BIOME_IDS, normalizeMix, randomMix, redistributeShares, createBiomeLayout } from '../src/biome-blend.js';
const THREE=await import('../vendor/three.module.js');
const {RailWorld}=await import('../src/world.js');
const {AssetStore}=await import('../src/world.js');
const {planScenery}=await import('../src/scenery-plan.js');
const manifest=JSON.parse(await readFile(new URL('../asset-manifest.json',import.meta.url),'utf8'));

test('mix validation rejects duplicates, invalid totals and a fifth biome; controls preserve exact integer 100%',()=>{
 for(const input of [[],[{biome:'Forest',percent:99}],[{biome:'Forest',percent:50},{biome:'Forest',percent:50}],BIOME_IDS.slice(0,5).map(biome=>({biome,percent:20})),[{biome:'Unknown',percent:100}],[{biome:'Forest',percent:NaN}]])assert.throws(()=>normalizeMix(input));
 const random=randomGenerator('V8-CONTROLS');
 for(let count=1;count<=4;count++)for(let i=0;i<100;i++){
  const rows=randomMix(random,count);assert.equal(new Set(rows.map(r=>r.biome)).size,count);assert.equal(rows.reduce((s,r)=>s+r.percent,0),100);
  for(const value of [0,1,33,99,100]){const next=redistributeShares(rows,i%count,value);assert.equal(next.reduce((s,r)=>s+r.percent,0),100);assert.ok(next.every(r=>Number.isInteger(r.percent)&&r.percent>=0));normalizeMix(next);}
 }
});

test('independently parsed foliage shares GPU resources without disposing a live canonical texture or mixing normal-map color space',()=>{
 globalThis.document={baseURI:'http://127.0.0.1:4173/'};
 const store=new AssetStore(manifest);let disposed=0;
 function fixture(colorSpace=THREE.SRGBColorSpace){const texture=new THREE.Texture();texture.colorSpace=colorSpace;texture.addEventListener('dispose',()=>disposed++);const material=new THREE.MeshStandardMaterial({map:texture,alphaTest:.45,side:THREE.DoubleSide});const parser={associations:new Map([[texture,{textures:0}],[material,{materials:0}]]),json:{textures:[{source:0}],images:[{uri:'../textures/nature-v8/atlas.png'}],materials:[{alphaMode:'MASK',alphaCutoff:.45,doubleSided:true}]}};return{texture,material,parser};}
 const a=fixture(),b=fixture();const first=store.shareMaterial(a.material,a.parser,'assets/models/Quaternius_Test.glb');const again=store.shareMaterial(a.material,a.parser,'assets/models/Quaternius_Test.glb');assert.equal(first,again);assert.equal(disposed,0,'reusing the same material must not invalidate the active GPU texture');
 const second=store.shareMaterial(b.material,b.parser,'assets/models/Quaternius_Other.glb');assert.equal(first,second);assert.equal(first.map,a.texture);assert.equal(disposed,1,'only the redundant newly decoded texture is discarded');
 const normal=fixture(THREE.NoColorSpace);const linear=store.shareMaterial(normal.material,normal.parser,'assets/models/Quaternius_Normal.glb');assert.notEqual(first.map,linear.map);assert.notEqual(first,linear);assert.equal(store.sharedTextures.size,2);store.dispose();
 delete globalThis.document;
});

test('all 70 four-biome combinations preserve their along-track quotas, closed-loop continuity and near-track spatial weights',()=>{
 const route=createRoute(8000,'V8-QUOTAS',8192,{elevationLimit:75,stations:3});let cases=0;
 const configurations=[];
 for(let a=0;a<5;a++)for(let b=a+1;b<6;b++)for(let c=b+1;c<7;c++)for(let d=c+1;d<8;d++)configurations.push([a,b,c,d].map((index,i)=>({biome:BIOME_IDS[index],percent:[40,30,20,10][i]})));
 assert.equal(configurations.length,70);
 for(const mix of configurations){const layout=createBiomeLayout(route,mix),report=layout.report(4096);for(const row of report.regions)assert.ok(Math.abs(row.requestedPercent-row.actualPercent)<.0001,JSON.stringify(row));
  for(const s of [-1e-5,0,1e-5,route.length-1e-5,route.length,route.length+1e-5]){const weights=layout.weightsAtDistance(s);assert.ok(Math.abs(Object.values(weights).reduce((a,b)=>a+b,0)-1)<1e-12);}
  for(let i=0;i<512;i++){const s=(i+.37)/512*route.length,p=route.sample(s),actual=layout.weightsAt(p.x,p.z),expected=layout.weightsAtDistance(s);for(const row of mix)assert.ok(Math.abs((actual[row.biome]||0)-(expected[row.biome]||0))<.003,'spatial region must follow actual railway distance');}
  cases++;
 }assert.equal(cases,70);
 for(const mix of [[{biome:'Snow',percent:100}],[{biome:'Forest',percent:97},{biome:'Desert',percent:1},{biome:'Lakeside',percent:1},{biome:'Volcano',percent:1}]]){const layout=createBiomeLayout(route,mix);for(const row of layout.report().regions)assert.ok(Math.abs(row.actualPercent-row.requestedPercent)<.0001);}
});

test('every imported model is actually placed in a compatible habitat across representative v8 maps',async()=>{
 const configurations=[['Forest',50,'Desert',50],['Forest',35,'Hills',25,'Pastoral',25,'Lakeside',15],['Snow',50,'Volcano',50]];
 const used=new Set(),records=[];
 for(const [i,config]of configurations.entries()){
  const biomeMix=[];for(let j=0;j<config.length;j+=2)biomeMix.push({biome:config[j],percent:config[j+1]});
  const world=new RailWorld(new THREE.Scene(),{manifest},{biomeMix,length:8,stations:3,elevationLimit:75,density:2000,features:true,seed:`V8-HABITATS-${i}`});
  const plan=await planScenery(world);assert.equal(plan.placements.length,2000);
  for(const p of plan.placements){const info=manifest.models[p.id];assert.ok(info.compatibleBiomes.includes(p.biome));assert.ok(world.route.distanceTo(p.x,p.z,p.radius+8)>=p.radius+6.99);if(info.scenePack==='Quaternius_UltimateStylizedNature_202205')used.add(p.id);}
  records.push({seed:world.config.seed,mix:biomeMix,lake:world.lake,distribution:world.biomeReport,nature:plan.stats.naturePack});world.dispose();
 }
 const imported=Object.keys(manifest.models).filter(id=>manifest.models[id].scenePack==='Quaternius_UltimateStylizedNature_202205');
 const missing=imported.filter(id=>!used.has(id));assert.deepEqual(missing,[],'all 63 imports must be used, not merely present in the manifest');
 await writeFile(new URL('../validation/biome-v8-coverage.json',import.meta.url),JSON.stringify({modelsUsed:used.size,available:imported.length,records},null,2)+'\n');
});

test('sprung cart body moves with Rapier Y while every wheel stays on its exact original rail position',async()=>{
 globalThis.self=globalThis;
 globalThis.ProgressEvent=class{constructor(type,init){this.type=type;Object.assign(this,init);}};
 // Geometry/parent-transform test: the PNG decoder is verified separately by
 // assets and browser QA. Supply dimensions without requiring a Node DOM.
 globalThis.createImageBitmap=async blob=>{const png=Buffer.from(await blob.arrayBuffer());return{width:png.readUInt32BE(16),height:png.readUInt32BE(20),close(){}};};
 const {GLTFLoader}=await import('../vendor/GLTFLoader.js');
 for(const vehicle of manifest.vehicles){const bytes=await readFile(new URL('../'+manifest.models[vehicle].url,import.meta.url)),gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
  const world=new RailWorld(new THREE.Scene(),{manifest,get:()=>({root:gltf.scene})},{biomeMix:[{biome:'Forest',percent:100}],length:5,stations:3,elevationLimit:75,density:0,features:false,seed:'V8-WHEELS',vehicle});
  world.buildCart();world.updateCart(567,567,.3,0);world.cart.updateMatrixWorld(true);const before=world.wheels.map(w=>w.node.getWorldPosition(new THREE.Vector3()));const body=world.cart.position.clone();
  for(const offset of [-.08,.012,.08]){world.updateCart(567,567,.3,offset);world.cart.updateMatrixWorld(true);assert.ok(Math.abs(world.cart.position.distanceTo(body)-Math.abs(offset))<1e-9);world.wheels.forEach((w,i)=>assert.ok(w.node.getWorldPosition(new THREE.Vector3()).distanceTo(before[i])<1e-8));}
  assert.equal(world.wheels.length,4);world.dispose();
 }
});
