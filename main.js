// ============================================================
// 오래오래 겨울세상 - main.js
// Stable iPhone/Desktop structure
// - <video> is displayed directly in DOM
// - <canvas> is an overlay only
// - video uses object-fit: contain, so the full camera image is visible
// - segmentation mask is drawn into the same contain-rectangle as the video
// ============================================================

const CONFIG = {
  FALLBACK_WIDTH: 960,
  FALLBACK_HEIGHT: 540,

  PARTICLE_COUNT: 120,
  PARTICLE_SIZE: 15,
  PARTICLE_SPEED_MIN: 0.5,
  PARTICLE_SPEED_MAX: 1.0,
  DRIFT_MIN: -0.25,
  DRIFT_MAX: 0.25,

  SEGMENTATION_INTERVAL: 2,
  MASK_SAMPLE_STEP: 4,
  MASK_THRESHOLD: 120,

  OUTLINE_ALPHA: 0.95,
  OUTLINE_WIDTH: 2,

  FALLING_ALPHA_MIN: 0.38,
  FALLING_ALPHA_MAX: 0.72,
  SETTLED_ALPHA_MIN: 0.25,
  SETTLED_ALPHA_MAX: 0.48,

  SETTLE_RADIUS_X: 18,
  STACK_CELL_SIZE: 24,
  STACK_LIMIT_PER_CELL: 3,

  MOVEMENT_RELEASE_THRESHOLD: 0.055,
  RELEASE_RATIO_ON_MOVE: 0.22,
  LOCAL_RELEASE_RADIUS: 76,
  LOCAL_RELEASE_RATIO: 0.42,

  SETTLED_LIFE_MIN: 180,
  SETTLED_LIFE_MAX: 360,
  SETTLED_FADE_RATE: 0.995,

  MAX_SETTLED_PARTICLES: 250,
};

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d", { alpha: true });

const video = document.getElementById("video");
const startBtn = document.getElementById("startBtn");
const clearBtn = document.getElementById("clearBtn");
const outlineToggle = document.getElementById("outlineToggle");
const maskToggle = document.getElementById("maskToggle");

let segmentation = null;
let running = false;
let paused = false;
let frameCount = 0;

let fallingParticles = [];
let settledParticles = [];

let latestMaskCanvas = null;
let latestMaskData = null;
let previousMaskData = null;
let subjectSurface = [];
let movementAmount = 0;
let motionHotspots = [];

let offscreenMaskCanvas = document.createElement("canvas");
let offscreenMaskCtx = offscreenMaskCanvas.getContext("2d", { willReadFrequently: true });
let stackMap = new Map();

function stageWidth() {
  return canvas.width || CONFIG.FALLBACK_WIDTH;
}

function stageHeight() {
  return canvas.height || CONFIG.FALLBACK_HEIGHT;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function isMobileLike() {
  return window.matchMedia("(max-width: 768px), (pointer: coarse)").matches;
}

function getContainRect(containerW, containerH, mediaW, mediaH) {
  if (!mediaW || !mediaH || !containerW || !containerH) {
    return { x: 0, y: 0, w: containerW, h: containerH };
  }

  const scale = Math.min(containerW / mediaW, containerH / mediaH);
  const w = mediaW * scale;
  const h = mediaH * scale;
  const x = (containerW - w) / 2;
  const y = (containerH - h) / 2;

  return { x, y, w, h };
}

function syncCanvasToDisplaySize(resetParticles = false) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    offscreenMaskCanvas.width = width;
    offscreenMaskCanvas.height = height;
    subjectSurface = new Array(width).fill(null);
    latestMaskData = null;
    previousMaskData = null;
    stackMap.clear();

    if (resetParticles || running) {
      initParticles();
    }
  }
}

function getStackKey(x, y) {
  const cx = Math.floor(x / CONFIG.STACK_CELL_SIZE);
  const cy = Math.floor(y / CONFIG.STACK_CELL_SIZE);
  return `${cx},${cy}`;
}

function rebuildStackMap() {
  stackMap.clear();
  for (const p of settledParticles) {
    const key = getStackKey(p.x, p.y);
    stackMap.set(key, (stackMap.get(key) || 0) + 1);
  }
}

async function initCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("이 브라우저는 웹캠 실행을 지원하지 않습니다.");
  }

  const mobile = isMobileLike();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: mobile
      ? { facingMode: "user" }
      : {
          width: { ideal: CONFIG.FALLBACK_WIDTH },
          height: { ideal: CONFIG.FALLBACK_HEIGHT },
          facingMode: "user",
        },
    audio: false,
  });

  video.srcObject = stream;
  await video.play();

  await new Promise((resolve) => {
    if (video.videoWidth && video.videoHeight) resolve();
    else video.addEventListener("loadedmetadata", resolve, { once: true });
  });

  syncCanvasToDisplaySize(true);
}

function initSegmentation() {
  segmentation = new SelfieSegmentation({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1/${file}`,
  });

  segmentation.setOptions({
    modelSelection: 1,
  });

  segmentation.onResults(processSegmentation);
}

async function processSegmentationFrame() {
  if (!segmentation || !video || video.readyState < 2) return;
  await segmentation.send({ image: video });
}

function processSegmentation(results) {
  syncCanvasToDisplaySize(false);
  latestMaskCanvas = results.segmentationMask;

  const w = stageWidth();
  const h = stageHeight();
  const vw = video.videoWidth || CONFIG.FALLBACK_WIDTH;
  const vh = video.videoHeight || CONFIG.FALLBACK_HEIGHT;
  const fit = getContainRect(w, h, vw, vh);

  offscreenMaskCtx.clearRect(0, 0, w, h);
  offscreenMaskCtx.drawImage(latestMaskCanvas, fit.x, fit.y, fit.w, fit.h);

  const imageData = offscreenMaskCtx.getImageData(0, 0, w, h);

  previousMaskData = latestMaskData;
  latestMaskData = imageData.data;

  subjectSurface = getSubjectSurface();
  const movement = detectMovement();
  movementAmount = movement.amount;
  motionHotspots = movement.hotspots;

  if (movementAmount > CONFIG.MOVEMENT_RELEASE_THRESHOLD) {
    releaseTouchedSnow();
  }

  if (motionHotspots.length) {
    releaseLocalSnow(motionHotspots);
  }
}

function isMaskSolid(x, y) {
  if (!latestMaskData) return false;

  const w = stageWidth();
  const h = stageHeight();
  const ix = Math.floor(clamp(x, 0, w - 1));
  const iy = Math.floor(clamp(y, 0, h - 1));
  const idx = (iy * w + ix) * 4;

  return latestMaskData[idx] > CONFIG.MASK_THRESHOLD;
}

function getSubjectSurface() {
  const w = stageWidth();
  const h = stageHeight();
  const surface = new Array(w).fill(null);
  if (!latestMaskData) return surface;

  for (let x = 0; x < w; x += CONFIG.MASK_SAMPLE_STEP) {
    let topY = null;

    for (let y = 0; y < h; y += CONFIG.MASK_SAMPLE_STEP) {
      if (isMaskSolid(x, y)) {
        topY = y;
        break;
      }
    }

    for (let fillX = x; fillX < x + CONFIG.MASK_SAMPLE_STEP && fillX < w; fillX++) {
      surface[fillX] = topY;
    }
  }

  return surface;
}

function detectMovement() {
  if (!latestMaskData || !previousMaskData) return { amount: 0, hotspots: [] };

  const w = stageWidth();
  const h = stageHeight();
  let diff = 0;
  let count = 0;
  const step = CONFIG.MASK_SAMPLE_STEP * 4;
  const hotspots = [];

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const idx = (y * w + x) * 4;
      const d = Math.abs(latestMaskData[idx] - previousMaskData[idx]) / 255;
      diff += d;
      count++;

      if (d > 0.62) {
        hotspots.push({ x, y, power: d });
      }
    }
  }

  return { amount: count ? diff / count : 0, hotspots };
}

function createParticle(yOverride = null) {
  const w = stageWidth();
  const h = stageHeight();

  return {
    x: rand(0, w),
    y: yOverride ?? rand(-h, 0),
    speed: rand(CONFIG.PARTICLE_SPEED_MIN, CONFIG.PARTICLE_SPEED_MAX),
    drift: rand(CONFIG.DRIFT_MIN, CONFIG.DRIFT_MAX),
    alpha: rand(CONFIG.FALLING_ALPHA_MIN, CONFIG.FALLING_ALPHA_MAX),
    state: "falling",
    wobble: rand(0, Math.PI * 2),
  };
}

function initParticles() {
  fallingParticles = [];
  settledParticles = [];
  stackMap.clear();

  for (let i = 0; i < CONFIG.PARTICLE_COUNT; i++) {
    fallingParticles.push(createParticle());
  }
}

function shouldSettle(p) {
  if (!subjectSurface || !subjectSurface.length) return false;

  const w = stageWidth();
  const bottomY = p.y + CONFIG.PARTICLE_SIZE * 0.45;
  const sx = Math.floor(clamp(p.x, 0, w - 1));
  const surfaceY = subjectSurface[sx];

  let targetY = null;

  if (surfaceY !== null && bottomY >= surfaceY - 2 && bottomY <= surfaceY + p.speed + 10) {
    targetY = surfaceY - rand(2, 10);
  }

  for (const s of settledParticles) {
    if (Math.abs(p.x - s.x) < CONFIG.SETTLE_RADIUS_X) {
      const stackedTop = s.y - CONFIG.PARTICLE_SIZE * 0.65;
      if (bottomY >= stackedTop - 2 && bottomY <= stackedTop + p.speed + 10) {
        if (targetY === null || stackedTop < targetY) targetY = stackedTop;
      }
    }
  }

  if (targetY === null) return false;

  const key = getStackKey(p.x, targetY);
  const count = stackMap.get(key) || 0;

  if (count >= CONFIG.STACK_LIMIT_PER_CELL) {
    p.drift += rand(-1.5, 1.5);
    p.speed += rand(0.4, 1.2);
    return false;
  }

  p.y = targetY;
  p.state = "settled";
  p.alpha = rand(CONFIG.SETTLED_ALPHA_MIN, CONFIG.SETTLED_ALPHA_MAX);
  p.life = rand(CONFIG.SETTLED_LIFE_MIN, CONFIG.SETTLED_LIFE_MAX);

  stackMap.set(key, count + 1);
  return true;
}

function updateSettledParticles() {
  if (!settledParticles.length) return;

  const alive = [];
  let changed = false;

  for (const p of settledParticles) {
    p.life = (p.life ?? CONFIG.SETTLED_LIFE_MAX) - 1;
    p.alpha *= CONFIG.SETTLED_FADE_RATE;

    if (p.life > 0 && p.alpha > 0.03) {
      alive.push(p);
    } else {
      changed = true;
    }
  }

  if (changed) {
    settledParticles = alive;
    rebuildStackMap();
  }
}

function updateParticles() {
  const w = stageWidth();
  const h = stageHeight();
  const stillFalling = [];

  for (const p of fallingParticles) {
    p.wobble += 0.025;
    p.y += p.speed;
    p.x += p.drift + Math.sin(p.wobble) * 0.15;

    if (p.x < -40) p.x = w + 40;
    if (p.x > w + 40) p.x = -40;

    if (shouldSettle(p)) {
      settledParticles.push(p);
      continue;
    }

    if (p.y > h + 40) {
      stillFalling.push(createParticle(-40));
    } else {
      stillFalling.push(p);
    }
  }

  fallingParticles = stillFalling;
  updateSettledParticles();

  if (settledParticles.length > CONFIG.MAX_SETTLED_PARTICLES) {
    settledParticles.splice(0, settledParticles.length - CONFIG.MAX_SETTLED_PARTICLES);
    rebuildStackMap();
  }

  while (fallingParticles.length < CONFIG.PARTICLE_COUNT) {
    fallingParticles.push(createParticle(-40));
  }
}

function releaseParticleAsFalling(p, force = 1) {
  p.state = "falling";
  p.speed = rand(CONFIG.PARTICLE_SPEED_MIN, CONFIG.PARTICLE_SPEED_MAX) + rand(0.8, 2.4) * force;
  p.drift = rand(-2.2, 2.2) * force;
  p.alpha = rand(CONFIG.FALLING_ALPHA_MIN, CONFIG.FALLING_ALPHA_MAX);
  p.life = undefined;
  return p;
}

function releaseTouchedSnow() {
  if (!settledParticles.length) return;

  const releaseCount = Math.ceil(settledParticles.length * CONFIG.RELEASE_RATIO_ON_MOVE);
  const released = [];

  for (let i = 0; i < releaseCount; i++) {
    if (!settledParticles.length) break;

    const idx = Math.floor(Math.random() * settledParticles.length);
    const p = settledParticles.splice(idx, 1)[0];
    released.push(releaseParticleAsFalling(p, 1));
  }

  fallingParticles.push(...released);
  rebuildStackMap();
}

function releaseLocalSnow(hotspots) {
  if (!settledParticles.length || !hotspots.length) return;

  const released = [];
  const survivors = [];
  const radius = CONFIG.LOCAL_RELEASE_RADIUS;
  const radiusSq = radius * radius;

  for (const p of settledParticles) {
    let hit = false;
    for (const spot of hotspots) {
      const dx = p.x - spot.x;
      const dy = p.y - spot.y;
      if (dx * dx + dy * dy <= radiusSq && Math.random() < CONFIG.LOCAL_RELEASE_RATIO) {
        hit = true;
        p.drift += dx >= 0 ? rand(0.6, 2.4) : rand(-2.4, -0.6);
        break;
      }
    }

    if (hit) released.push(releaseParticleAsFalling(p, 1.25));
    else survivors.push(p);
  }

  if (released.length) {
    settledParticles = survivors;
    fallingParticles.push(...released);
    rebuildStackMap();
  }
}

function clearSnow() {
  initParticles();
  drawScene();
}

function togglePause() {
  if (!running) return;

  paused = !paused;

  if (!paused) {
    requestAnimationFrame(animationLoop);
  }
}

function drawMaskDebug() {
  if (!latestMaskData || !maskToggle?.checked) return;

  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.drawImage(offscreenMaskCanvas, 0, 0, stageWidth(), stageHeight());
  ctx.restore();
}

function drawOutline() {
  if (!outlineToggle?.checked || !latestMaskData) return;

  ctx.save();
  ctx.globalAlpha = CONFIG.OUTLINE_ALPHA;
  ctx.strokeStyle = "rgba(255, 220, 80, 0.95)";
  ctx.lineWidth = CONFIG.OUTLINE_WIDTH;
  ctx.shadowColor = "rgba(255, 230, 120, 0.75)";
  ctx.shadowBlur = 8;

  ctx.beginPath();

  let drawing = false;

  for (let x = 0; x < subjectSurface.length; x += 6) {
    const y = subjectSurface[x];

    if (y === null) {
      drawing = false;
      continue;
    }

    if (!drawing) {
      ctx.moveTo(x, y);
      drawing = true;
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();
  ctx.restore();
}

function drawSnowParticle(p, settled = false) {
  ctx.save();

  const alpha = clamp(p.alpha, 0, 1);
  const fontSize = Math.max(10, CONFIG.PARTICLE_SIZE);

  ctx.font = `${fontSize}px Dotum, 돋움, Apple SD Gothic Neo, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  ctx.shadowColor = `rgba(255,255,255,${alpha * 0.7})`;
  ctx.shadowBlur = settled ? 4 : 7;
  ctx.fillText("눈", p.x, p.y);

  ctx.restore();
}

function drawScene() {
  syncCanvasToDisplaySize(false);
  ctx.clearRect(0, 0, stageWidth(), stageHeight());

  drawMaskDebug();
  drawOutline();

  for (const p of settledParticles) drawSnowParticle(p, true);
  for (const p of fallingParticles) drawSnowParticle(p, false);
}

async function animationLoop() {
  if (!running || paused) return;

  frameCount++;

  if (frameCount % CONFIG.SEGMENTATION_INTERVAL === 0) {
    try {
      await processSegmentationFrame();
    } catch (err) {
      console.warn("Segmentation frame skipped:", err);
    }
  }

  updateParticles();
  drawScene();

  requestAnimationFrame(animationLoop);
}

async function startExperience() {
  if (running) return;

  try {
    startBtn.disabled = true;

    await initCamera();
    initSegmentation();
    initParticles();

    running = true;
    paused = false;

    requestAnimationFrame(animationLoop);
  } catch (err) {
    console.error(err);
    startBtn.disabled = false;
    alert(
      "웹캠을 시작하지 못했습니다.\n\n" +
      "1) http://localhost:8000 또는 https 주소로 접속했는지 확인\n" +
      "2) 카메라 권한을 허용했는지 확인\n" +
      "3) 다른 앱이 카메라를 사용 중인지 확인\n\n" +
      err.message
    );
  }
}

function bindEvents() {
  syncCanvasToDisplaySize(false);

  if (startBtn) startBtn.addEventListener("click", startExperience);
  if (clearBtn) clearBtn.addEventListener("click", clearSnow);

  if (canvas) {
    canvas.addEventListener("click", togglePause);
    canvas.style.cursor = "pointer";
    canvas.title = "클릭하면 정지 또는 재생됩니다.";
  }

  window.addEventListener("resize", () => syncCanvasToDisplaySize(true));
  window.addEventListener("orientationchange", () => {
    setTimeout(() => syncCanvasToDisplaySize(true), 350);
  });

  drawScene();
}

document.addEventListener("DOMContentLoaded", bindEvents);
