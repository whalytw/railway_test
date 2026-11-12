import { DEFAULT_MIX, normalizeMix, proportionalIntegers, redistributeShares, randomMix, BIOME_COLORS } from './biome-blend.js?v=8.0.0';

export class MixControls {
  constructor(container,biomes,onChange) {
    this.container=container;this.biomes=biomes;this.onChange=onChange;this.rows=Array.from({length:4},()=>({biome:'',percent:0}));this.fields=[];
    for(let index=0;index<4;index++){
      const card=document.createElement('div');card.className='mix-slot';card.dataset.slot=String(index);
      const label=document.createElement('label'),title=document.createElement('span');title.textContent=`環境 ${index+1}`;
      const select=document.createElement('select');select.id=`mix-biome-${index}`;select.setAttribute('aria-label',`環境 ${index+1} 地形`);
      for(const [id,name]of [['','未使用此槽'],...Object.entries(biomes).map(([id,info])=>[id,info.name])]){const option=document.createElement('option');option.value=id;option.textContent=name;select.append(option);}
      label.append(title,select);
      const amount=document.createElement('label');amount.className='mix-amount';const number=document.createElement('input');number.type='number';number.min='0';number.max='100';number.step='1';number.id=`mix-percent-${index}`;number.setAttribute('aria-label',`環境 ${index+1} 百分比`);const percent=document.createElement('span');percent.textContent='%';amount.append(number,percent);
      const slider=document.createElement('input');slider.type='range';slider.min='0';slider.max='100';slider.step='1';slider.id=`mix-range-${index}`;slider.setAttribute('aria-label',`環境 ${index+1} 比例滑桿`);
      card.append(label,amount,slider);container.append(card);this.fields.push({card,select,number,slider});
      select.addEventListener('change',()=>this.changeBiome(index,select.value));
      number.addEventListener('change',()=>this.changePercent(index,number.value,true));
      slider.addEventListener('input',()=>this.changePercent(index,slider.value,false));slider.addEventListener('change',()=>this.changed());
    }
    this.set(DEFAULT_MIX);
  }
  value(){return normalizeMix(this.rows.filter(row=>row.biome));}
  set(input,notify=false){const values=normalizeMix(input);this.rows=Array.from({length:4},(_,i)=>values[i]?{...values[i],percent:Math.round(values[i].percent)}:{biome:'',percent:0});const active=this.rows.filter(row=>row.biome),shares=proportionalIntegers(active.map(row=>row.percent));active.forEach((row,i)=>row.percent=shares[i]);this.refresh();if(notify)this.changed();}
  changeBiome(index,biome){
    const previous=this.rows[index].biome,active=this.rows.filter((row,i)=>i!==index&&row.biome);
    if(!biome&&!active.length){this.refresh();return;}
    if(biome&&active.some(row=>row.biome===biome)){this.refresh();return;}
    this.rows[index]={biome,percent:biome?(previous?this.rows[index].percent:25):0};
    const selected=this.rows.filter(row=>row.biome);
    if(biome&&!previous){const adjusted=redistributeShares(selected,selected.indexOf(this.rows[index]),selected.length===1?100:25);selected.forEach((row,i)=>row.percent=adjusted[i].percent);}
    else {const shares=proportionalIntegers(selected.map(row=>row.percent));selected.forEach((row,i)=>row.percent=shares[i]);}
    this.refresh();this.changed();
  }
  changePercent(index,value,commit){const selected=this.rows.filter(row=>row.biome),target=selected.indexOf(this.rows[index]);if(target<0)return;const adjusted=redistributeShares(selected,target,value);selected.forEach((row,i)=>row.percent=adjusted[i].percent);this.refresh();if(commit)this.changed();}
  randomize(preserve=false){const active=this.value();this.set(randomMix(Math.random,preserve?active.length:2+Math.floor(Math.random()*3),preserve?active.map(row=>row.biome):null),true);}
  changed(){this.onChange?.(this.value());}
  refresh(){
    const chosen=new Set(this.rows.filter(row=>row.biome).map(row=>row.biome));
    this.rows.forEach((row,index)=>{const field=this.fields[index];field.select.value=row.biome;field.number.value=String(row.percent);field.slider.value=String(row.percent);field.number.disabled=field.slider.disabled=!row.biome;field.card.dataset.active=String(Boolean(row.biome));field.card.style.setProperty('--mix-color',BIOME_COLORS[row.biome]||'#9ca994');for(const option of field.select.options)option.disabled=Boolean(option.value&&option.value!==row.biome&&chosen.has(option.value));});
    const active=this.value();const bar=document.getElementById('mix-bar');bar.replaceChildren(...active.map(row=>{const span=document.createElement('span');span.style.width=`${row.percent}%`;span.style.background=BIOME_COLORS[row.biome];span.title=`${this.biomes[row.biome].name} ${row.percent}%`;return span;}));
    this.describe();
  }
  describe(lengthKm=Number(document.getElementById('route-length')?.value)||8){const active=this.value();document.getElementById('mix-summary').textContent=active.map(row=>`${this.biomes[row.biome].name} ${row.percent}% · ${(lengthKm*row.percent/100).toFixed(2)} km`).join('　／　');document.getElementById('mix-total').textContent='合計 100%';document.getElementById('mix-bar').setAttribute('aria-label',document.getElementById('mix-summary').textContent);}
}
