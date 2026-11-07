import * as THREE from 'three';
import { AssetStore, RailWorld, createAtmosphere, PALETTES } from './world.js?v=5.0.0';
import { createPhysics, stepPhysics, FIXED_STEP, clamp, lerp, wrap, resolveBiomes, randomGenerator, nextStation, biomeMix, createElevationProfile, leverReference, leverForSpeed, RATED_POWER, CART_MASS, MAX_GRADE, MIN_VERTICAL_RADIUS } from './core.js?v=5.0.0';
import { riverBend } from './route-features.js?v=5.0.0';
import { copyMotion, interpolateMotion, zoomView, anchorCamera } from './presentation.js?v=5.0.0';
import { DENSITY_OPTIONS, SCENERY_VERSION } from './scenery-plan.js?v=5.0.0';

const $ = id => document.getElementById(id);
let renderer, scene, camera, atmosphere, manifest, store, world;
let mode = 'loading', physics = createPhysics(), cameraMode = 'chase', buildEpoch = 0;
let accumulator = 0, lastTime = 0, hudElapsed = 0, visibilityElapsed = 0, titleTime = 0;
let orbitYaw = 0, orbitPitch = 0.20, orbitDistance = 18, cameraSnapped = false;
let cabYaw = 0, cabPitch = 0;
const previousMotion = copyMotion(physics), renderMotion = copyMotion(physics);
let dragging = null, previewChangeTimer, notificationTimer;
let frameSamples = [], fpsHistory = [], metricTime = 0, metricFrames = 0, sessionConfig = null;
let longFrameCount = 0, countdownFinished = false;
let filteredFrameTime = 1 / 60;
const desiredCamera = new THREE.Vector3(), lookTarget = new THREE.Vector3(), smoothLook = new THREE.Vector3();
const cameraOffset = new THREE.Vector3(), lookOffset = new THREE.Vector3(), eyePosition = new THREE.Vector3(), viewDirection = new THREE.Vector3();
const startButton = $('start-button'), loading = $('loading');
const minimap = $('minimap'), mapContext = minimap.getContext('2d');
const profileCanvas = $('elevation-profile'), profileContext = profileCanvas.getContext('2d'), slopeSample = {};
const menu = $('title-screen'), hud = $('game-hud');
const biomeNames = ['Forest', 'Hills', 'Pastoral', 'Desert', 'Rural', 'Lakeside', 'Snow', 'Volcano'];

function showError(error) {
  console.error(error); $('error-message').textContent = error.message || String(error); $('error-overlay').hidden = false;
  loading.hidden = true; startButton.disabled = false;
}
window.addEventListener('error', event => { if (event.error) showError(event.error); });
window.addEventListener('unhandledrejection', event => showError(event.reason));
$('retry-button').addEventListener('click', () => location.reload());

function notify(message) {
  $('notification').textContent = message; $('notification').hidden = false;
  clearTimeout(notificationTimer); notificationTimer = setTimeout(() => $('notification').hidden = true, 3500);
}
function loadingProgress(progress, message) {
  $('loading-progress').style.width = `${Math.max(2, progress * 100)}%`;
  $('loading-status').textContent = message;
}
function seedValue() {
  const entered = $('seed').value.trim();
  if (entered) return entered;
  const bytes = new Uint32Array(1); crypto.getRandomValues(bytes); return bytes[0].toString(36).toUpperCase();
}
function selectedVehicle() { return document.querySelector('input[name="vehicle"]:checked')?.value || manifest.vehicles[0]; }
function formConfig() {
  const seed = seedValue();
  const [biomeA, biomeB] = resolveBiomes($('biome-a').value, $('biome-b').value, biomeNames, randomGenerator(`${seed}:biomes`));
  return { biomeA, biomeB, length: Number($('route-length').value), stations: Number($('station-count').value), vehicle: selectedVehicle(),
    density: Number($('density').value), viewDistance: Number($('view-distance').value), resolution: Number($('resolution').value),
    shadows: $('shadows').value === 'on', sceneryShadows: $('scenery-shadows').value === 'on', elevationLimit: Number($('elevation-limit').value),
    features: $('features').value === 'on', skyline: $('skyline').value === 'on', sleeperFilter: $('sleeper-filter').value === 'on', sleeperSpacing: Number($('sleeper-spacing').value), seed };
}
function savePreferences() {
  try {
    const values = {};
    for (const id of ['biome-a', 'biome-b', 'route-length', 'station-count', 'elevation-limit', 'density', 'view-distance', 'resolution', 'shadows', 'scenery-shadows', 'features', 'skyline', 'sleeper-filter', 'sleeper-spacing', 'seed']) values[id] = $(id).value;
    values.vehicle = selectedVehicle(); localStorage.setItem('rail-loop-lab:preferences:v1', JSON.stringify(values));
  } catch { /* Private browsing may disable local storage. */ }
}
function restorePreferences() {
  try {
    const values = JSON.parse(localStorage.getItem('rail-loop-lab:preferences:v1') || '{}');
    for (const [id, value] of Object.entries(values)) {
      if (id === 'vehicle') { const input = [...document.querySelectorAll('input[name="vehicle"]')].find(el => el.value === value); if (input) input.checked = true; }
      else if ($(id) && (id === 'seed' || [...$(id).options].some(option => option.value === value))) $(id).value = value;
    }
  } catch { /* Preferences are optional. */ }
}
function populateForm() {
  $('density').replaceChildren(...DENSITY_OPTIONS.map(count => {
    const option = document.createElement('option'); option.value = String(count);
    const label = count === 1000 ? '入門' : count <= 3500 ? '輕量' : count <= 5000 ? '中量' : count <= 10000 ? '標準' : count <= 16000 ? '進階' : count <= 30000 ? '加壓' : '極限';
    option.textContent = `${label} · ${count.toLocaleString()}`; option.selected = count === 8000; return option;
  }));
  for (const id of biomeNames) for (const target of ['biome-a', 'biome-b']) {
    const option = document.createElement('option'); option.value = id; option.textContent = manifest.biomes[id].name; $(target).append(option);
  }
  for (let km = 5; km <= 15; km++) {
    const option = document.createElement('option'); option.value = String(km); option.textContent = `${km} 公里`; option.selected = km === 8; $('route-length').append(option);
  }
  for (let height = 0; height <= 500; height += 25) {
    const option = document.createElement('option'); option.value = String(height); option.textContent = height === 0 ? '0 m · 平坦' : `${height} 公尺`;
    option.selected = height === 75; $('elevation-limit').append(option);
  }
  for (const [index, id] of manifest.vehicles.entries()) {
    const label = document.createElement('label'); label.className = 'vehicle-option';
    const input = document.createElement('input'); input.type = 'radio'; input.name = 'vehicle'; input.value = id; input.checked = index === 0;
    const image = document.createElement('img'); image.src = manifest.models[id].preview || `assets/previews/${id}.png`; image.alt = ''; image.loading = 'eager';
    const text = document.createElement('span'); text.textContent = manifest.models[id].name;
    label.append(input, image, text); $('vehicle-choices').append(label);
    input.addEventListener('change', schedulePreview);
  }
  restorePreferences(); updatePresetHint(); updateReliefHint(); buildLeverScale();
  for (const id of ['route-length', 'station-count', 'elevation-limit']) $(id).addEventListener('change', () => { updateReliefHint(); schedulePreview(); });
  $('density').addEventListener('change', updatePresetHint);
  $('biome-a').addEventListener('change', schedulePreview); $('biome-b').addEventListener('change', schedulePreview);
  $('randomize').addEventListener('click', () => {
    const [a, b] = resolveBiomes('random', 'random', biomeNames);
    $('biome-a').value = a; $('biome-b').value = b; schedulePreview();
  });
}
function updatePresetHint() { $('preset-hint').textContent = `${$('density').selectedOptions[0].textContent.split(' · ')[0]} / ${Number($('density').value).toLocaleString()} 物件`; }
function updateReliefHint() {
  const requested = Number($('elevation-limit').value);
  if (!requested) { $('relief-hint').textContent = '軌道完全平坦；沿線山丘景觀仍保留。'; return; }
  const profile = createElevationProfile(Number($('route-length').value) * 1000, requested, Number($('station-count').value));
  $('relief-hint').textContent = `縱坡 ≤25‰、站區水平；預估實際高差 ${profile.range.toFixed(1)} m${profile.range < requested - 0.1 ? '（依路長限縮）' : ''}。`;
}
function buildLeverScale() {
  for (const kmh of [120, 90, 60, 30, 0, -15, -30]) {
    const u = leverForSpeed(kmh), reference = leverReference(u);
    const left = document.createElement('span'), right = document.createElement('span');
    left.className = `speed-tick${kmh === 0 ? ' neutral' : ''}`; right.className = `power-tick${kmh === 0 ? ' neutral' : ''}`;
    left.dataset.lever = right.dataset.lever = String(u);
    left.textContent = kmh === 0 ? 'N / 0' : kmh < 0 ? `−${-kmh}` : String(kmh);
    right.textContent = `${reference.powerPercent < 10 ? reference.powerPercent.toFixed(1) : reference.powerPercent.toFixed(0)}%`;
    $('lever-speed-ticks').append(left); $('lever-power-ticks').append(right);
  }
}
function schedulePreview() {
  if (mode !== 'title') return;
  clearTimeout(previewChangeTimer);
  previewChangeTimer = setTimeout(async () => {
    if (mode !== 'title') return;
    try {
      const config = previewConfig();
      await loadWorld(config, false);
      if (mode === 'title') updatePreviewCaption(config);
    } catch (error) { notify(error.message); }
  }, 300);
}
function previewConfig() {
  let a = $('biome-a').value, b = $('biome-b').value;
  if (a === 'random') a = b === 'Forest' ? 'Pastoral' : 'Forest';
  if (b === 'random' || a === b) b = a === 'Lakeside' ? 'Forest' : 'Lakeside';
  return { biomeA: a, biomeB: b, length: 5, stations: 3, elevationLimit: Number($('elevation-limit').value), vehicle: selectedVehicle(), density: 2000,
    features: true, skyline: true, sleeperFilter: true, sleeperSpacing: 0.75, viewDistance: 450, resolution: 1, shadows: false, sceneryShadows: false, seed: 'LOOP-PREVIEW' };
}
function updatePreviewCaption(config) { $('preview-caption').textContent = `${manifest.biomes[config.biomeA].name} × ${manifest.biomes[config.biomeB].name} / 即時 3D 預覽`; }

async function loadWorld(config, showLoading = true) {
  const epoch = ++buildEpoch;
  if (showLoading) { loading.hidden = false; loadingProgress(0, '開始建立新場景…'); }
  const nextWorld = new RailWorld(scene, store, config);
  try {
    await nextWorld.build((p, text) => { if (showLoading && epoch === buildEpoch) loadingProgress(p, text); });
    if (epoch !== buildEpoch) { nextWorld.dispose(); return false; }
    if (world) world.dispose(); world = nextWorld;
    renderer.renderLists.dispose();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, config.resolution));
    renderer.shadowMap.enabled = config.shadows || config.sceneryShadows; atmosphere.setBiomes(config.biomeA, config.biomeB);
    cameraSnapped = false; visibilityElapsed = 100; titleTime = 0; resize();
    return true;
  } catch (error) { nextWorld.dispose(); throw error; }
}

async function startGame(event) {
  event.preventDefault();
  if (mode !== 'title') return;
  let config;
  try { config = formConfig(); } catch (error) { $('form-error').hidden = false; $('form-error').textContent = error.message; return; }
  $('form-error').hidden = true; startButton.disabled = true; clearTimeout(previewChangeTimer); savePreferences();
  mode = 'loading'; $('loading-title').textContent = `正在鋪設 ${config.length} 公里軌道`;
  try {
    const loaded = await loadWorld(config, true); if (!loaded) return;
    sessionConfig = config; physics = createPhysics(); copyMotion(physics, previousMotion); copyMotion(physics, renderMotion); accumulator = 0; lastTime = 0;
    fpsHistory = []; frameSamples = []; metricTime = 0; metricFrames = 0; longFrameCount = 0;
    hudElapsed = 0; countdownFinished = false; cameraMode = 'chase'; orbitYaw = 0; orbitPitch = 0.20; orbitDistance = 18; cabYaw = 0; cabPitch = 0;
    menu.hidden = true; hud.hidden = false; loading.hidden = true; $('pause-overlay').hidden = true;
    $('route-label').textContent = `${config.length}.0 KM`;
    $('biome-label').textContent = `A ${manifest.biomes[config.biomeA].name} → B ${manifest.biomes[config.biomeB].name}`;
    $('zone-a-label').textContent = manifest.biomes[config.biomeA].name; $('zone-b-label').textContent = manifest.biomes[config.biomeB].name;
    $('instances').textContent = world.sceneryCount.toLocaleString(); $('pause-label').textContent = '暫停'; $('pause-icon').textContent = 'Ⅱ';
    $('model-variety').textContent = world.sceneryStats.uniqueModels.toLocaleString();
    $('relief-summary').textContent = `實際高差 ${world.route.elevation.range.toFixed(1)} m / 上限 ${config.elevationLimit} m`;
    mode = 'running'; setThrottle(physics.throttle); setCamera('chase'); updateHUD(); updateCamera(1, true); drawMinimap();
    document.body.dataset.state = 'running'; document.body.dataset.ready = 'true';
  } catch (error) { mode = 'title'; showError(error); }
  finally { startButton.disabled = false; }
}
function pauseGame(force) {
  if (!['running', 'paused'].includes(mode)) return;
  const paused = force ?? mode === 'running';
  mode = paused ? 'paused' : 'running'; lastTime = 0;
  if (paused) world.updateEnvironment(0, 0, 1 / 60);
  $('pause-overlay').hidden = !paused; $('countdown').hidden = paused || physics.countdown <= 0;
  $('pause-label').textContent = paused ? '繼續' : '暫停'; $('pause-icon').textContent = paused ? '▷' : 'Ⅱ';
  document.body.dataset.state = mode;
}
async function returnToTitle() {
  if (!['running', 'paused'].includes(mode)) return;
  mode = 'loading'; hud.hidden = true; $('countdown').hidden = true; $('pause-overlay').hidden = true;
  $('loading-title').textContent = '返回軌道試驗場';
  try {
    const config = previewConfig(); await loadWorld(config, true);
    physics = createPhysics(); copyMotion(physics, previousMotion); copyMotion(physics, renderMotion); accumulator = 0; mode = 'title'; menu.hidden = false; loading.hidden = true; lastTime = 0;
    orbitYaw = 0; orbitPitch = 0.20; orbitDistance = 18; cabYaw = 0; cabPitch = 0; cameraMode = 'chase'; cameraSnapped = false;
    updatePreviewCaption(config); document.body.dataset.state = 'title'; resize();
  } catch (error) { showError(error); }
}

function setThrottle(value) {
  value = clamp(value, -1, 1); if (Math.abs(value) < 0.015) value = 0;
  for (const kmh of [120, 90, 60, 30, 0, -15, -30]) { const detent = leverForSpeed(kmh); if (Math.abs(value - detent) < 0.012) { value = detent; break; } }
  physics.throttle = value;
  const reference = leverReference(value);
  const top = 15 + (1 - value) * 0.5 * ($('lever-track').clientHeight - 30);
  $('lever-handle').style.top = `${top}px`;
  $('lever-handle').setAttribute('aria-valuenow', String(Math.round(value * 100)));
  $('lever-handle').setAttribute('aria-valuetext', value ? `平地速度 ${reference.kmh.toFixed(0)} km/h，可用馬力 ${reference.powerPercent.toFixed(1)}%` : '中立滑行');
  $('throttle-value').textContent = value ? `${reference.kmh < 0 ? '−' : ''}${Math.abs(reference.kmh).toFixed(0)} km/h` : 'N · 滑行';
  $('power-value').textContent = `${reference.powerPercent < 10 ? reference.powerPercent.toFixed(1) : reference.powerPercent.toFixed(0)}%`;
  document.querySelectorAll('[data-lever]').forEach(tick => { tick.style.top = `${15 + (1 - Number(tick.dataset.lever)) * 0.5 * ($('lever-track').clientHeight - 30)}px`; });
  const arm = document.querySelector('.lever-arm');
  arm.style.top = `${Math.min(top, $('lever-track').clientHeight * 0.5)}px`;
  arm.style.height = `${Math.abs(top - $('lever-track').clientHeight * 0.5)}px`;
}
function leverFromPointer(event) {
  const rect = $('lever-track').getBoundingClientRect();
  const amount = 1 - (event.clientY - rect.top - 15) / (rect.height - 30) * 2;
  setThrottle(amount);
}
function installControls() {
  $('setup-form').addEventListener('submit', startGame);
  $('pause-button').addEventListener('click', () => pauseGame()); $('resume-button').addEventListener('click', () => pauseGame(false));
  $('title-button').addEventListener('click', returnToTitle); $('neutral-button').addEventListener('click', () => setThrottle(0));
  const track = $('lever-track');
  track.addEventListener('pointerdown', event => { event.preventDefault(); track.setPointerCapture(event.pointerId); dragging = { type: 'lever', pointerId: event.pointerId }; leverFromPointer(event); });
  track.addEventListener('pointermove', event => { if (dragging?.type === 'lever') leverFromPointer(event); });
  track.addEventListener('pointerup', () => dragging = null); track.addEventListener('pointercancel', () => dragging = null);
  track.addEventListener('lostpointercapture', () => dragging = null);
  $('lever-handle').addEventListener('keydown', event => {
    if (event.key === 'Home') { event.preventDefault(); setThrottle(1); }
    if (event.key === 'End') { event.preventDefault(); setThrottle(-1); }
  });
  window.addEventListener('keydown', event => {
    if (!['running', 'paused'].includes(mode) || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
    if (event.key === 'ArrowUp') { event.preventDefault(); setThrottle(physics.throttle + 0.06); }
    if (event.key === 'ArrowDown') { event.preventDefault(); setThrottle(physics.throttle - 0.06); }
    if (event.code === 'Space') { event.preventDefault(); setThrottle(0); }
    if (event.code === 'KeyP' || event.code === 'Escape') { event.preventDefault(); if (!event.repeat) pauseGame(); }
    if (event.code === 'KeyC' && !event.repeat) setCamera(cameraMode === 'chase' ? 'cab' : cameraMode === 'cab' ? 'overview' : 'chase');
  });
  document.querySelectorAll('[data-camera]').forEach(button => button.addEventListener('click', () => setCamera(button.dataset.camera)));
  $('preview-camera').addEventListener('click', () => { cameraMode = cameraMode === 'overview' ? 'chase' : 'overview'; cameraSnapped = false; visibilityElapsed = 100; });
  const canvas = $('scene');
  canvas.addEventListener('pointerdown', event => { if (mode === 'paused') return; canvas.setPointerCapture(event.pointerId); dragging = { type: 'camera', x: event.clientX, y: event.clientY }; });
  canvas.addEventListener('pointermove', event => {
    if (dragging?.type !== 'camera') return;
    if (cameraMode === 'cab') {
      cabYaw += (event.clientX - dragging.x) * 0.005;
      cabPitch = clamp(cabPitch - (event.clientY - dragging.y) * 0.004, -1.25, 1.25);
    } else {
      orbitYaw -= (event.clientX - dragging.x) * 0.006;
      orbitPitch = clamp(orbitPitch + (event.clientY - dragging.y) * 0.004, -0.02, 1.05);
    }
    dragging.x = event.clientX; dragging.y = event.clientY;
  });
  canvas.addEventListener('pointerup', () => dragging = null); canvas.addEventListener('pointercancel', () => dragging = null); canvas.addEventListener('lostpointercapture', () => dragging = null);
  canvas.addEventListener('wheel', event => {
    if (!['running', 'title'].includes(mode) || cameraMode === 'overview') return;
    event.preventDefault();
    const next = zoomView(cameraMode, orbitDistance, event.deltaY, mode === 'title');
    orbitDistance = next.distance;
    if (next.mode !== cameraMode) {
      if (next.mode === 'cab') { cabYaw = 0; cabPitch = 0; }
      setCamera(next.mode, false);
    }
  }, { passive: false });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && mode === 'running') { pauseGame(true); notify('分頁已切換，行駛與計時自動暫停。'); }
    lastTime = 0; metricTime = 0; metricFrames = 0;
  });
  $('fullscreen').addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { notify('目前的瀏覽器視窗不支援全螢幕。'); }
  });
  $('export-report').addEventListener('click', exportReport);
  window.addEventListener('resize', resize);
  $('scene').addEventListener('webglcontextlost', event => { event.preventDefault(); if (mode === 'running') pauseGame(true); showError(new Error('GPU 渲染內容已中斷。請降低物件數、解析度或陰影設定後重新載入。')); });
}
function setCamera(next, snap = true) {
  cameraMode = next; if (snap) cameraSnapped = false; visibilityElapsed = 100;
  if (next === 'cab') { orbitDistance = 0; if (snap) { cabYaw = 0; cabPitch = 0; } }
  else if (next === 'chase' && snap && orbitDistance < 7) orbitDistance = 18;
  document.querySelectorAll('[data-camera]').forEach(button => button.classList.toggle('active', button.dataset.camera === next));
  $('camera-hint').textContent = next === 'cab' ? '拖曳自由轉頭 · 滾輪向下拉遠' : next === 'chase' ? '拖曳旋轉 · 滾輪最近進入駕駛' : '拖曳旋轉全景';
}
function resize() {
  if (!renderer) return;
  renderer.setSize(innerWidth, innerHeight, false);
  const panelWidth = mode === 'title' && innerWidth > 760 ? document.querySelector('.setup-panel').getBoundingClientRect().right : 0;
  renderer.setViewport(panelWidth, 0, innerWidth - panelWidth, innerHeight);
  camera.aspect = (innerWidth - panelWidth) / innerHeight; camera.updateProjectionMatrix();
  if (mode !== 'title') setThrottle(physics.throttle);
}
function updateCamera(dt, snap = false) {
  if (!world?.cart) return;
  const p = world.cartSample, cart = world.cart.position, distanceAlong = renderMotion.distance;
  const structure = mode === 'running' ? world.structureAt(distanceAlong, 17) : null;
  let targetFov;
  eyePosition.set(cart.x + p.tx3 * 0.35 + p.upX * 1.60, cart.y + p.ty * 0.35 + p.upY * 1.60, cart.z + p.tz3 * 0.35 + p.upZ * 1.60);
  if (cameraMode === 'overview') {
    const d = world.route.squareSize, angle = orbitYaw * 0.25;
    const midHeight = world.route.elevation.range * 0.5;
    desiredCamera.set(Math.sin(angle) * d * 0.35, d * 1.18 + midHeight, d * 0.70);
    lookTarget.set(0, midHeight - 30, 0); targetFov = 53; camera.far = 45000;
  } else if (cameraMode === 'cab') {
    const sign = renderMotion.speed < -0.4 ? -1 : 1, horizontal = Math.cos(cabPitch);
    viewDirection.set(sign * Math.sin(cabYaw) * horizontal, Math.sin(cabPitch), sign * Math.cos(cabYaw) * horizontal).applyQuaternion(world.cart.quaternion);
    desiredCamera.copy(eyePosition); lookTarget.copy(eyePosition).addScaledVector(viewDirection, 45);
    targetFov = 72; camera.far = 18000;
  } else {
    const angle = p.yaw + orbitYaw + (mode === 'title' ? 0.58 : 0.20);
    const distance = orbitDistance;
    desiredCamera.set(cart.x - Math.sin(angle) * distance, cart.y + 3.6 + Math.sin(orbitPitch) * distance * 0.8, cart.z - Math.cos(angle) * distance);
    const ahead = world.route.sample(distanceAlong + 8);
    lookTarget.set(ahead.x, ahead.y + 1.4, ahead.z);
    const terrainY = world.heightAt(desiredCamera.x, desiredCamera.z); desiredCamera.y = Math.max(desiredCamera.y, terrainY + 2);
    targetFov = 57 + Math.min(6, Math.abs(renderMotion.speed) * 0.13); camera.far = 18000;
    if (structure) {
      const behind = world.route.sample(distanceAlong - Math.min(7.5, distance)), ahead = world.route.sample(distanceAlong + 5);
      desiredCamera.set(behind.x, behind.y + 2.35, behind.z); lookTarget.set(ahead.x, ahead.y + 1.3, ahead.z); targetFov = 64;
    }
    // Smoothly travel the last seven metres into the driver's eye position.
    const eyeBlend = 1 - THREE.MathUtils.smoothstep(distance, 0, 7);
    desiredCamera.lerp(eyePosition, eyeBlend);
    viewDirection.set(p.tx3, p.ty, p.tz3);
    smoothLook.copy(eyePosition).addScaledVector(viewDirection, 45);
    lookTarget.lerp(smoothLook, eyeBlend); targetFov = lerp(targetFov, 72, eyeBlend);
  }
  const reset = snap || !cameraSnapped, blend = reset ? 1 : 1 - Math.exp(-dt * 12);
  if (cameraMode === 'overview') {
    camera.position.lerp(desiredCamera, blend); smoothLook.lerp(lookTarget, blend); camera.lookAt(smoothLook);
  } else anchorCamera(camera, cart, desiredCamera, lookTarget, cameraOffset, lookOffset, dt, reset, cameraMode === 'cab' ? 30 : 10);
  camera.fov = lerp(camera.fov, targetFov, blend); camera.updateProjectionMatrix();
  cameraSnapped = true;
  const overview = cameraMode === 'overview', far = world.config.viewDistance;
  scene.fog.near = overview ? world.route.squareSize * 2.5 : far * 0.36;
  scene.fog.far = overview ? world.route.squareSize * 6 : far;
  const insideTunnel = mode === 'running' && !overview ? world.tunnelFactor(distanceAlong - (cameraMode === 'cab' ? 0 : Math.min(7.5, orbitDistance))) : 0;
  scene.fog.near = lerp(scene.fog.near, 3, insideTunnel); scene.fog.far = lerp(scene.fog.far, 68, insideTunnel);
  world.cart.visible = cameraMode !== 'cab' && !(cameraMode === 'chase' && camera.position.distanceTo(cart) < 4.2);
  atmosphere.update(camera, cart, world.config.shadows || world.config.sceneryShadows, insideTunnel, world.config.sceneryShadows);
}
function updateHUD() {
  $('timer').textContent = physics.elapsed.toFixed(1);
  const speed = physics.speed * 3.6;
  $('speed').textContent = `${speed < -0.18 ? '−' : ''}${Math.abs(speed).toFixed(0)}`;
  $('speed-meter-fill').style.width = `${Math.abs(speed) / (speed < 0 ? 30 : 120) * 100}%`;
  const stateText = physics.countdown > 0 ? '準備出發' : speed < -0.2 ? '倒退行駛' : physics.throttle === 0 ? Math.abs(speed) < 0.2 ? '已停止' : '中立滑行' : physics.throttle < 0 && speed > 0.2 ? '物理煞車' : Math.abs(speed) >= 119.8 ? '最高速度' : '動力行駛';
  $('drive-state').textContent = stateText;
  $('odometer').textContent = (physics.odometer / 1000).toFixed(2);
  $('lap-count').textContent = `第 ${Math.floor(physics.odometer / world.route.length) + 1} 圈`;
  const mix = biomeMix(world.cart.position.x, world.cart.position.z, world.route.squareSize);
  $('current-zone').textContent = mix > 0.22 && mix < 0.78 ? '過渡區' : mix < 0.5 ? 'A 區' : 'B 區';
  const travelGrade = world.cartSample.grade * (physics.speed < -0.1 || Math.abs(physics.speed) < 0.1 && physics.throttle < 0 ? -1 : 1);
  $('grade-value').textContent = `${Math.abs(travelGrade) < 0.0001 ? '平路' : travelGrade > 0 ? '↗ 上坡' : '↘ 下坡'} · ${(Math.abs(travelGrade) * 1000).toFixed(1)}‰`;
  $('height-value').textContent = `高度 ${(world.cartSample.y + 0.405).toFixed(1)} m`;
  const currentFeature = world.structureAt(physics.distance);
  if (currentFeature) $('feature-status').textContent = `正在通過 · ${currentFeature.name}`;
  else {
    const candidates = [world.features.bridge, world.features.tunnel].filter(Boolean).map(f => ({ ...f, remaining: wrap((physics.speed < -0.1 ? physics.distance - f.end : f.start - physics.distance), world.route.length) })).sort((a, b) => a.remaining - b.remaining);
    $('feature-status').textContent = candidates.length ? `前方地標 · ${candidates[0].name} ${Math.round(candidates[0].remaining).toLocaleString()} m` : '橋隧與河谷已關閉';
  }
  const next = nextStation(world.route, world.stations, physics.distance, physics.speed < -0.1 || physics.speed < 0.1 && physics.throttle < 0 ? -1 : 1);
  $('next-station').textContent = next.name; $('station-distance').textContent = next.remaining < 25 ? '車站附近' : `${Math.round(next.remaining).toLocaleString()} m`;
  if (physics.countdown > 0) {
    $('countdown').hidden = mode === 'paused'; $('countdown').querySelector('strong').textContent = String(Math.ceil(physics.countdown));
  } else {
    $('countdown').hidden = true;
    if (!countdownFinished) { countdownFinished = true; notify('出發！推桿左側為平地速度，右側為可用馬力；上下坡會影響實際車速。'); }
  }
}
function drawMinimap() {
  if (!world) return;
  const ctx = mapContext, w = minimap.width, h = minimap.height, d = world.route.squareSize;
  ctx.clearRect(0, 0, w, h);
  const scale = Math.min((w - 30) / (2 * d), (h - 20) / d);
  const mx = x => w / 2 + x * scale, mz = z => h / 2 + z * scale;
  const gradient = ctx.createLinearGradient(mx(-d), 0, mx(d), 0);
  gradient.addColorStop(0, '#d2ddc3'); gradient.addColorStop(0.43, '#d2ddc3'); gradient.addColorStop(0.57, '#cfdee0'); gradient.addColorStop(1, '#cfdee0');
  ctx.fillStyle = gradient; ctx.beginPath(); ctx.roundRect(mx(-d), mz(-d / 2), 2 * d * scale, d * scale, 12); ctx.fill();
  ctx.setLineDash([4, 6]); ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(mx(0), mz(-d / 2)); ctx.lineTo(mx(0), mz(d / 2)); ctx.stroke(); ctx.setLineDash([]);
  const bridge = world.features.bridge;
  if (bridge) {
    ctx.beginPath();
    for (let b = -150; b <= 150; b += 5) { const a = riverBend(b), x = bridge.x + bridge.nx * b + bridge.tx * a, z = bridge.z + bridge.nz * b + bridge.tz * a; if (b === -150) ctx.moveTo(mx(x), mz(z)); else ctx.lineTo(mx(x), mz(z)); }
    ctx.strokeStyle = '#77aeb7'; ctx.lineWidth = 5; ctx.stroke();
  }
  const path = () => { ctx.beginPath(); for (let i = 0; i <= world.route.samples; i += 12) { const p = world.route.points[i]; if (i === 0) ctx.moveTo(mx(p.x), mz(p.z)); else ctx.lineTo(mx(p.x), mz(p.z)); } ctx.closePath(); };
  path(); ctx.strokeStyle = '#f8f4df'; ctx.lineWidth = 8; ctx.stroke(); path(); ctx.strokeStyle = '#657c65'; ctx.lineWidth = 3; ctx.stroke();
  for (const station of world.stations) {
    ctx.beginPath(); ctx.arc(mx(station.x), mz(station.z), 10, 0, Math.PI * 2); ctx.fillStyle = '#f6f4e7'; ctx.fill();
    ctx.strokeStyle = '#82927a'; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = '#54704f'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(station.index + 1), mx(station.x), mz(station.z));
  }
  for (const f of [world.features.bridge, world.features.tunnel].filter(Boolean)) {
    ctx.fillStyle = f.kind === 'bridge' ? '#427781' : '#92724a'; ctx.beginPath(); ctx.roundRect(mx(f.x) - 11, mz(f.z) - 11, 22, 22, 4); ctx.fill();
    ctx.fillStyle = '#fff8df'; ctx.font = 'bold 14px "Microsoft JhengHei",sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(f.kind === 'bridge' ? '橋' : '隧', mx(f.x), mz(f.z));
  }
  const p = world.cartSample;
  ctx.beginPath(); ctx.arc(mx(p.x), mz(p.z), 10, 0, Math.PI * 2); ctx.fillStyle = '#c26d40'; ctx.fill(); ctx.strokeStyle = '#fff9de'; ctx.lineWidth = 4; ctx.stroke();
  ctx.save(); ctx.translate(mx(p.x), mz(p.z)); ctx.rotate(-p.yaw); ctx.beginPath(); ctx.moveTo(0, 5); ctx.lineTo(-3, -3); ctx.lineTo(3, -3); ctx.closePath(); ctx.fillStyle = '#fff5df'; ctx.fill(); ctx.restore();
  drawElevationProfile();
}
function drawElevationProfile() {
  const ctx = profileContext, w = profileCanvas.width, h = profileCanvas.height, route = world.route;
  ctx.clearRect(0, 0, w, h);
  const range = Math.max(1, route.elevation.range), x = s => 8 + s / route.length * (w - 16);
  const y = altitude => h - 10 - (altitude - route.elevation.min) / range * (h - 24);
  ctx.beginPath(); ctx.moveTo(8, h - 3);
  for (let i = 0; i <= 200; i++) { const p = route.sample(i / 200 * route.length); ctx.lineTo(x(i / 200 * route.length), y(p.y)); }
  ctx.lineTo(w - 8, h - 3); ctx.closePath(); ctx.fillStyle = '#d7dfc8'; ctx.fill();
  ctx.beginPath();
  for (let i = 0; i <= 200; i++) { const p = route.sample(i / 200 * route.length); if (!i) ctx.moveTo(x(0), y(p.y)); else ctx.lineTo(x(i / 200 * route.length), y(p.y)); }
  ctx.strokeStyle = '#7f956e'; ctx.lineWidth = 2; ctx.stroke();
  const current = wrap(physics.distance, route.length), altitude = route.sample(current).y;
  ctx.beginPath(); ctx.arc(x(current), y(altitude), 5, 0, Math.PI * 2); ctx.fillStyle = '#c16d42'; ctx.fill();
}
function recordMetrics(dt, now) {
  if (!(dt > 0) || mode !== 'running') return;
  metricTime += dt; metricFrames++;
  frameSamples.push(dt * 1000); if (frameSamples.length > 600) frameSamples.shift();
  if (dt > 0.05) longFrameCount++;
  if (metricTime >= 1) {
    const fps = metricFrames / metricTime;
    const ordered = [...frameSamples].sort((a, b) => b - a);
    const worstCount = Math.max(1, Math.ceil(ordered.length * 0.01));
    const low = 1000 / (ordered.slice(0, worstCount).reduce((a, b) => a + b, 0) / worstCount);
    $('fps').textContent = fps.toFixed(0); $('frame-time').textContent = `${(1000 / fps).toFixed(1)} ms / frame`;
    $('low-fps').textContent = low.toFixed(1);
    const info = renderer.info;
    $('draw-calls').textContent = info.render.calls.toLocaleString();
    $('triangles').textContent = info.render.triangles >= 1e6 ? `${(info.render.triangles / 1e6).toFixed(2)}M` : `${(info.render.triangles / 1e3).toFixed(0)}K`;
    fpsHistory.push({ elapsedSeconds: Number(physics.elapsed.toFixed(3)), fps: Number(fps.toFixed(2)), frameTimeMs: Number((1000 / fps).toFixed(3)),
      onePercentLowFps: Number(low.toFixed(2)), drawCalls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries,
      textures: info.memory.textures, speedKmh: Number((physics.speed * 3.6).toFixed(2)), flatReferenceKmh: Number(leverReference(physics.throttle).kmh.toFixed(2)),
      powerPercent: Number(leverReference(physics.throttle).powerPercent.toFixed(3)), gradePermille: Number((world.cartSample.grade * 1000).toFixed(3)), altitudeMetres: Number(world.cartSample.y.toFixed(3)), camera: cameraMode });
    // Bounded memory for genuinely unlimited runs: retain at most 4 hours of 1s samples.
    if (fpsHistory.length > 14400) fpsHistory.shift(); metricTime = 0; metricFrames = 0;
  }
}
function exportReport() {
  const samples = fpsHistory;
  const report = { application: 'LOOP · 軌道試驗場', version: '5.0.0', threeVersion: THREE.REVISION, generatedAt: new Date().toISOString(),
    settings: sessionConfig, actualTrackLengthMetres: world.route.length, worldUnit: 'metre', elapsedSecondsIncludingCountdown: physics.elapsed,
    odometerMetres: physics.odometer, actualSceneryInstances: world.sceneryCount, trackSegments: world.trackInstances,
    sceneryComposition: { version: SCENERY_VERSION, ...world.sceneryStats,
      landmarks: world.sceneryPlan.landmarks.map(({ id, x, z, along }) => ({ id, x, z, along })),
      lod: 'Chunked main / LOD1 with distance hysteresis; overview uses LOD1.' },
    elevation: world.route.elevation, physicsModel: { massKg: CART_MASS, ratedPowerWatts: RATED_POWER, ratedHorsepower: RATED_POWER / 745.699872, maximumGrade: MAX_GRADE, minimumVerticalRadiusMetres: MIN_VERTICAL_RADIUS },
    landmarks: world.features, sleepers: { averagePitchMetres: world.sleeperPitch, instances: world.sleeperInstances, filterEnabled: world.config.sleeperFilter, exposureMetres: world.sleeperUniforms.exposure.value },
    presentation: { fixedPhysicsStepSeconds: FIXED_STEP, interpolatedMotion: true, chaseAnchoredToCart: true, camera: cameraMode, chaseDistanceMetres: orbitDistance, cabYawRadians: cabYaw, cabPitchRadians: cabPitch },
    viewport: { width: innerWidth, height: innerHeight, pixelRatio: renderer.getPixelRatio() },
    summary: { samples: samples.length, averageFps: samples.length ? Number((samples.reduce((sum, s) => sum + s.fps, 0) / samples.length).toFixed(2)) : null,
      minimumFps: samples.length ? Math.min(...samples.map(s => s.fps)) : null, longFramesOver50ms: longFrameCount },
    notes: ['以 requestAnimationFrame 實際呈現間隔計算 FPS，可能受螢幕更新率與瀏覽器垂直同步限制。', '暫停、載入與背景分頁不納入量測。', '1% low 為最近至多 600 幀中最慢 1% 幀時間的平均值換算。', '全景視角使用軌道線段 LOD；追車／駕駛使用原始 GLB 軌道。', '最多保留最近 14400 筆每秒量測。'], samples };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url;
  link.download = `LOOP-${sessionConfig.seed}-${Date.now()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(`已匯出 ${samples.length} 筆實際效能量測。`);
}

function frame(time) {
  requestAnimationFrame(frame);
  if (!renderer || !world || document.hidden) { lastTime = 0; return; }
  const realDt = lastTime ? (time - lastTime) / 1000 : 0; lastTime = time;
  const dt = Math.min(realDt, 0.1);
  if (mode === 'running') {
    // Fixed physical timestep. Keep every foreground second, including slow
    // stress-test frames; background tabs are explicitly paused separately.
    accumulator += realDt;
    while (accumulator >= FIXED_STEP) {
      copyMotion(physics, previousMotion);
      world.route.sample(physics.distance + physics.speed * FIXED_STEP * 0.5, slopeSample);
      stepPhysics(physics, FIXED_STEP, physics.throttle, slopeSample.grade); accumulator -= FIXED_STEP;
    }
    interpolateMotion(previousMotion, physics, accumulator / FIXED_STEP, renderMotion);
    world.updateCart(renderMotion.distance, renderMotion.odometer, physics.throttle);
    hudElapsed += realDt;
    if (hudElapsed > 0.09) { updateHUD(); drawMinimap(); hudElapsed = 0; }
  } else if (mode === 'title') {
    titleTime += dt;
    // Slow cinematic shunt remains close to the departure station.
    renderMotion.distance = Math.sin(titleTime * 0.022) * 14; renderMotion.speed = 0;
    world.updateCart(renderMotion.distance, titleTime * 1.0, 0);
  }
  if (mode !== 'paused') updateCamera(dt);
  if (mode !== 'paused') {
    filteredFrameTime = lerp(filteredFrameTime, clamp(realDt, 1 / 144, 1 / 20), 0.10);
    world.updateEnvironment(dt, mode === 'running' ? renderMotion.speed : 0, filteredFrameTime);
  }
  visibilityElapsed += dt;
  if (visibilityElapsed > 0.18) { world.setVisibility(camera, world.config.viewDistance, cameraMode === 'overview'); visibilityElapsed = 0; }
  renderer.render(scene, camera);
  recordMetrics(realDt, time);
}

async function boot() {
  if (location.protocol === 'file:') throw new Error('請透過 HTTP 開啟此專案：執行 START_LOCAL.cmd 後前往 http://127.0.0.1:4173，或使用 GitHub Pages 網址。');
  const response = await fetch('./asset-manifest.json?v=5.0.0'); if (!response.ok) throw new Error(`找不到資產清單（HTTP ${response.status}）。請完整解壓縮 ZIP。`);
  manifest = await response.json(); populateForm(); installControls();
  renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true, powerPreference: 'high-performance', alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor('#b9cebd');
  scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(57, innerWidth / innerHeight, 0.12, 18000);
  atmosphere = createAtmosphere(scene, renderer); store = new AssetStore(manifest);
  requestAnimationFrame(frame);
  const config = previewConfig(); await loadWorld(config, true);
  mode = 'title'; menu.hidden = false; loading.hidden = true; updatePreviewCaption(config); resize();
  document.body.dataset.ready = 'true'; document.body.dataset.state = 'title';
}

boot().catch(showError);
