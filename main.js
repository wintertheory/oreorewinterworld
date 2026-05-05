// ============================================================
// 오래오래 겨울세상 - main.js
// MediaPipe segmentation / outline restored
// ============================================================

const CONFIG = {
  VIDEO_WIDTH: 960,
  VIDEO_HEIGHT: 540,

  PARTICLE_COUNT: 120,
  PARTICLE_SIZE: 17,

  PARTICLE_SPEED_MIN: 1.0,
  PARTICLE_SPEED_MAX: 3.0,

  DRIFT_MIN: -0.45,
  DRIFT_MAX: 0.45,

  SEGMENTATION_INTERVAL: 2,

  MASK_SAMPLE_STEP: 4,
  MASK_THRESHOLD: 120,

  OUTLINE_ALPHA: 0.95,
  OUTLINE_WIDTH: 2,

  FALLING_ALPHA_MIN: 0.38,
  FALLING_ALPHA_MAX: 0.72,
  SETTLED_ALPHA_MIN: 0.25,
  SETTLED_ALPHA_MAX: 0.48,

  SETTLED_LIFE_MIN: 180,
  SETTLED_LIFE_MAX: 360,

  SETTLE_RADIUS_X: 18,
  STACK_CELL_SIZE: 24,
  STACK_LIMIT_PER_CELL: 3,

  MOVEMENT_RELEASE_THRESHOLD: 0.055,
  RELEASE_RATIO_ON_MOVE: 0.24,

  // 움직임이 생겼을 때 쌓인 눈이 다시 떨어지는 느낌을 위한 값
  RELEASE_COOLDOWN_FRAMES: 3,
  RELEASE_GRAVITY: 0.12,
  RELEASE_NO_SETTLE_FRAMES: 14,

  // 손이나 피사체 일부가 지나간 곳 주변의 눈을 털어내는 값
  SWEEP_DIFF_THRESHOLD: 80,
  SWEEP_SAMPLE_STEP: 12,
  SWEEP_RADIUS: 72,
  SWEEP_RELEASE_RATIO: 0.58,
  SWEEP_MAX_RELEASE_PER_FRAME: 42,
  SWEEP_SIDE_FORCE_MIN: 1.4,
  SWEEP_SIDE_FORCE_MAX: 3.8,
  SWEEP_UP_FORCE_MIN: -3.2,
  SWEEP_UP_FORCE_MAX: -1.1,

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
let releaseCooldown = 0;

let offscreenMaskCanvas = document.createElement("canvas");
let offscreenMaskCtx = offscreenMaskCanvas.getContext("2d", { willReadFrequently: true });
let stackMap = new Map();

// iPhone Safari 대응 구조:
// video는 DOM 레이어에서 object-fit: contain으로 직접 표시하고,
// canvas는 그 위에 눈/외곽선만 그리는 투명 overlay로 사용합니다.
// 모바일에서는 실제 카메라 비율을 stage aspect-ratio에 반영해
// 전면 카메라 화면이 위아래로 잘리지 않게 합니다.
const stageWrap = document.querySelector(".stage-wrap");
let STAGE_WIDTH = CONFIG.VIDEO_WIDTH;
let STAGE_HEIGHT = CONFIG.VIDEO_HEIGHT;

function setStageSize(preserveParticles = false) {
  const rect = stageWrap?.getBoundingClientRect();
  const nextWidth = Math.max(1, Math.round(rect?.width || CONFIG.VIDEO_WIDTH));
  const nextHeight = Math.max(1, Math.round(rect?.height || CONFIG.VIDEO_HEIGHT));

  const prevWidth = STAGE_WIDTH || nextWidth;
  const prevHeight = STAGE_HEIGHT || nextHeight;

  STAGE_WIDTH = nextWidth;
  STAGE_HEIGHT = nextHeight;

  canvas.width = STAGE_WIDTH;
  canvas.height = STAGE_HEIGHT;
  canvas.style.width = "100%";
  canvas.style.height = "100%";

  offscreenMaskCanvas.width = STAGE_WIDTH;
  offscreenMaskCanvas.height = STAGE_HEIGHT;

  if (preserveParticles && (prevWidth !== STAGE_WIDTH || prevHeight !== STAGE_HEIGHT)) {
    const sx = STAGE_WIDTH / prevWidth;
    const sy = STAGE_HEIGHT / prevHeight;
    for (const p of [...fallingParticles, ...settledParticles]) {
      p.x *= sx;
      p.y *= sy;
    }
    rebuildStackMap();
  }
}

function isMobileSafariLike() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function syncStageAspectToVideo() {
  if (!stageWrap || !video.videoWidth || !video.videoHeight) return;

  // iPhone Safari에서는 16:9 박스에 cover로 채우면 전면 카메라 상하가 잘릴 수 있습니다.
  // 실제 카메라 입력 비율을 stage 자체에 반영해서 전체 화면이 보이게 합니다.
  stageWrap.style.setProperty("--stage-aspect", `${video.videoWidth} / ${video.videoHeight}`);
}

function getContainDestRect(sourceWidth, sourceHeight, destWidth = STAGE_WIDTH, destHeight = STAGE_HEIGHT) {
  const sw0 = Math.max(1, sourceWidth || destWidth);
  const sh0 = Math.max(1, sourceHeight || destHeight);
  const sourceRatio = sw0 / sh0;
  const destRatio = destWidth / destHeight;

  let dx = 0;
  let dy = 0;
  let dw = destWidth;
  let dh = destHeight;

  if (sourceRatio > destRatio) {
    dh = destWidth / sourceRatio;
    dy = (destHeight - dh) / 2;
  } else if (sourceRatio < destRatio) {
    dw = destHeight * sourceRatio;
    dx = (destWidth - dw) / 2;
  }

  return { dx, dy, dw, dh };
}

function drawImageContain(image, destCtx = ctx, destWidth = STAGE_WIDTH, destHeight = STAGE_HEIGHT) {
  const sourceWidth = image.videoWidth || image.width || destWidth;
  const sourceHeight = image.videoHeight || image.height || destHeight;
  const { dx, dy, dw, dh } = getContainDestRect(sourceWidth, sourceHeight, destWidth, destHeight);
  destCtx.drawImage(image, 0, 0, sourceWidth, sourceHeight, dx, dy, dw, dh);
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
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

  const videoConstraints = isMobileSafariLike()
    ? { facingMode: "user" }
    : {
        width: { ideal: CONFIG.VIDEO_WIDTH },
        height: { ideal: CONFIG.VIDEO_HEIGHT },
        facingMode: "user",
      };

  const stream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: false,
  });

  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;

  await video.play();

  syncStageAspectToVideo();
  setStageSize();

  // aspect-ratio 변경 후 브라우저 레이아웃이 한 프레임 늦게 반영되는 경우 보정합니다.
  requestAnimationFrame(() => setStageSize(true));
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
  latestMaskCanvas = results.segmentationMask;

  offscreenMaskCtx.clearRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
  // 비디오와 같은 contain 방식으로 mask를 canvas 좌표계에 맞춥니다.
  // 이렇게 해야 iPhone 전면 카메라 전체 화면이 잘리지 않고, 외곽선/쌓임도 어긋나지 않습니다.
  drawImageContain(latestMaskCanvas, offscreenMaskCtx, STAGE_WIDTH, STAGE_HEIGHT);

  const imageData = offscreenMaskCtx.getImageData(0, 0, STAGE_WIDTH, STAGE_HEIGHT);

  previousMaskData = latestMaskData;
  latestMaskData = imageData.data;

  subjectSurface = getSubjectSurface();
  movementAmount = detectMovement();

  if (releaseCooldown > 0) {
    releaseCooldown -= 1;
  }

  if (movementAmount > CONFIG.MOVEMENT_RELEASE_THRESHOLD && releaseCooldown <= 0) {
    releaseTouchedSnow();
    sweepSnowByMotion();
    releaseCooldown = CONFIG.RELEASE_COOLDOWN_FRAMES;
  }
}

function isMaskSolid(x, y) {
  if (!latestMaskData) return false;

  const ix = Math.floor(clamp(x, 0, STAGE_WIDTH - 1));
  const iy = Math.floor(clamp(y, 0, STAGE_HEIGHT - 1));
  const idx = (iy * STAGE_WIDTH + ix) * 4;

  return latestMaskData[idx] > CONFIG.MASK_THRESHOLD;
}

function getSubjectSurface() {
  const surface = new Array(STAGE_WIDTH).fill(null);
  if (!latestMaskData) return surface;

  for (let x = 0; x < STAGE_WIDTH; x += CONFIG.MASK_SAMPLE_STEP) {
    let topY = null;

    for (let y = 0; y < STAGE_HEIGHT; y += CONFIG.MASK_SAMPLE_STEP) {
      if (isMaskSolid(x, y)) {
        topY = y;
        break;
      }
    }

    for (let fillX = x; fillX < x + CONFIG.MASK_SAMPLE_STEP && fillX < STAGE_WIDTH; fillX++) {
      surface[fillX] = topY;
    }
  }

  return surface;
}

function detectMovement() {
  motionHotspots = [];

  if (!latestMaskData || !previousMaskData) return 0;

  let diff = 0;
  let count = 0;
  const step = CONFIG.MASK_SAMPLE_STEP * 2;

  for (let y = 0; y < STAGE_HEIGHT; y += step) {
    for (let x = 0; x < STAGE_WIDTH; x += step) {
      const idx = (y * STAGE_WIDTH + x) * 4;
      diff += Math.abs(latestMaskData[idx] - previousMaskData[idx]) / 255;
      count++;
    }
  }

  // 손/팔처럼 국소적으로 크게 움직인 부분을 따로 저장한다.
  // 이 좌표 주변에 쌓인 눈을 더 강하게 흩뿌려서 "털어내는" 느낌을 만든다.
  for (let y = 0; y < STAGE_HEIGHT; y += CONFIG.SWEEP_SAMPLE_STEP) {
    for (let x = 0; x < STAGE_WIDTH; x += CONFIG.SWEEP_SAMPLE_STEP) {
      const idx = (y * STAGE_WIDTH + x) * 4;
      const localDiff = Math.abs(latestMaskData[idx] - previousMaskData[idx]);

      if (localDiff > CONFIG.SWEEP_DIFF_THRESHOLD) {
        const wasSubject = previousMaskData[idx] > CONFIG.MASK_THRESHOLD;
        const isSubject = latestMaskData[idx] > CONFIG.MASK_THRESHOLD;

        if (wasSubject || isSubject) {
          motionHotspots.push({ x, y });
        }
      }
    }
  }

  return count ? diff / count : 0;
}

function createParticle(yOverride = null) {
  return {
    x: rand(0, STAGE_WIDTH),
    y: yOverride ?? rand(-STAGE_HEIGHT, 0),
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
  if (p.noSettleFrames && p.noSettleFrames > 0) return false;
  if (!subjectSurface || !subjectSurface.length) return false;

  const bottomY = p.y + CONFIG.PARTICLE_SIZE * 0.45;
  const sx = Math.floor(clamp(p.x, 0, STAGE_WIDTH - 1));
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

function updateParticles() {
  const stillFalling = [];

  for (const p of fallingParticles) {
    p.wobble += 0.025;

    if (p.noSettleFrames && p.noSettleFrames > 0) {
      p.noSettleFrames -= 1;
    }

    if (typeof p.vy === "number") {
      p.vy += CONFIG.RELEASE_GRAVITY;
      p.y += p.vy;
      p.x += (p.vx || 0) + Math.sin(p.wobble) * 0.2;

      // 충분히 아래로 떨어지기 시작하면 일반 낙하 파티클로 자연스럽게 전환한다.
      if (p.vy > CONFIG.PARTICLE_SPEED_MAX + 1.2) {
        p.speed = clamp(p.vy, CONFIG.PARTICLE_SPEED_MIN, CONFIG.PARTICLE_SPEED_MAX + 1.5);
        p.drift = clamp(p.vx || p.drift, -2.5, 2.5);
        delete p.vx;
        delete p.vy;
      }
    } else {
      p.y += p.speed;
      p.x += p.drift + Math.sin(p.wobble) * 0.15;
    }

    if (p.x < -40) p.x = STAGE_WIDTH + 40;
    if (p.x > STAGE_WIDTH + 40) p.x = -40;

    if (shouldSettle(p)) {
      settledParticles.push(p);
      continue;
    }

    if (p.y > STAGE_HEIGHT + 40) {
      stillFalling.push(createParticle(-40));
    } else {
      stillFalling.push(p);
    }
  }

  fallingParticles = stillFalling;

  let settledChanged = false;
  const aliveSettled = [];

  for (const p of settledParticles) {
    p.life -= 1;
    p.alpha *= 0.995;

    if (p.life > 0 && p.alpha > 0.02) {
      aliveSettled.push(p);
    } else {
      settledChanged = true;
    }
  }

  settledParticles = aliveSettled;

  if (settledParticles.length > CONFIG.MAX_SETTLED_PARTICLES) {
    settledParticles.splice(0, settledParticles.length - CONFIG.MAX_SETTLED_PARTICLES);
    settledChanged = true;
  }

  if (settledChanged) {
    rebuildStackMap();
  }

  while (fallingParticles.length < CONFIG.PARTICLE_COUNT) {
    fallingParticles.push(createParticle(-40));
  }
}

function makeParticleFallAgain(p, options = {}) {
  p.state = "falling";
  p.alpha = rand(CONFIG.FALLING_ALPHA_MIN, CONFIG.FALLING_ALPHA_MAX);
  p.noSettleFrames = CONFIG.RELEASE_NO_SETTLE_FRAMES;
  delete p.life;

  if (options.swept) {
    // 손으로 털어낸 눈은 한 번 위/옆으로 튀었다가 중력으로 다시 내려온다.
    p.vx = options.vx ?? rand(-CONFIG.SWEEP_SIDE_FORCE_MAX, CONFIG.SWEEP_SIDE_FORCE_MAX);
    p.vy = rand(CONFIG.SWEEP_UP_FORCE_MIN, CONFIG.SWEEP_UP_FORCE_MAX);
    p.drift = clamp(p.vx * 0.35, -2.5, 2.5);
    p.speed = rand(CONFIG.PARTICLE_SPEED_MIN, CONFIG.PARTICLE_SPEED_MAX);
  } else {
    // 피사체 전체 움직임으로 떨어지는 눈은 강한 튐보다 "다시 낙하" 느낌을 우선한다.
    p.vx = rand(-1.4, 1.4);
    p.vy = rand(0.7, 2.2);
    p.drift = rand(-1.2, 1.2);
    p.speed = rand(CONFIG.PARTICLE_SPEED_MIN, CONFIG.PARTICLE_SPEED_MAX) + rand(0.4, 1.4);
  }

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
    released.push(makeParticleFallAgain(p));
  }

  fallingParticles.push(...released);
  rebuildStackMap();
}

function sweepSnowByMotion() {
  if (!settledParticles.length || !motionHotspots.length) return;

  const released = [];
  const radiusSq = CONFIG.SWEEP_RADIUS * CONFIG.SWEEP_RADIUS;

  for (let i = settledParticles.length - 1; i >= 0; i--) {
    if (released.length >= CONFIG.SWEEP_MAX_RELEASE_PER_FRAME) break;

    const p = settledParticles[i];
    let nearest = null;
    let nearestDistSq = Infinity;

    for (const h of motionHotspots) {
      const dx = p.x - h.x;
      const dy = p.y - h.y;
      const distSq = dx * dx + dy * dy;

      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearest = h;
      }
    }

    if (!nearest || nearestDistSq > radiusSq) continue;
    if (Math.random() > CONFIG.SWEEP_RELEASE_RATIO) continue;

    const dx = p.x - nearest.x;
    const side = dx === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(dx);
    const vx = side * rand(CONFIG.SWEEP_SIDE_FORCE_MIN, CONFIG.SWEEP_SIDE_FORCE_MAX);

    settledParticles.splice(i, 1);
    released.push(makeParticleFallAgain(p, { swept: true, vx }));
  }

  if (released.length) {
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

function drawVideo() {
  // video는 DOM 레이어에서 직접 표시합니다.
  // canvas에 다시 그리면 iPhone Safari에서 가로/세로 stretch가 생길 수 있습니다.
}

function drawMaskDebug() {
  if (!latestMaskCanvas || !maskToggle?.checked) return;

  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.drawImage(offscreenMaskCanvas, 0, 0, STAGE_WIDTH, STAGE_HEIGHT);
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

  // iOS Safari에서는 canvas text + shadowBlur + globalAlpha 조합이 불안정할 수 있어
  // fillStyle / shadowColor의 rgba alpha에 직접 반영합니다.
  const alpha = clamp(p.alpha, 0, 1);

  ctx.font = `${CONFIG.PARTICLE_SIZE}px Dotum, 돋움, Apple SD Gothic Neo, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  ctx.shadowColor = `rgba(255,255,255,${alpha * 0.7})`;
  ctx.shadowBlur = settled ? 4 : 7;
  ctx.fillText("눈", p.x, p.y);

  ctx.restore();
}

function drawScene() {
  ctx.clearRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);

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
      "1) http://localhost:8000 으로 접속했는지 확인\n" +
      "2) 카메라 권한을 허용했는지 확인\n" +
      "3) 다른 앱이 카메라를 사용 중인지 확인\n\n" +
      err.message
    );
  }
}

function bindEvents() {
  setStageSize();

  if (startBtn) startBtn.addEventListener("click", startExperience);
  if (clearBtn) clearBtn.addEventListener("click", clearSnow);

  if (canvas) {
    canvas.addEventListener("click", togglePause);
    canvas.style.cursor = "pointer";
    canvas.title = "클릭하면 정지 또는 재생됩니다.";
  }

  window.addEventListener("resize", () => {
    syncStageAspectToVideo();
    setStageSize(true);
  });

  window.addEventListener("orientationchange", () => {
    setTimeout(() => {
      syncStageAspectToVideo();
      setStageSize(true);
    }, 250);
  });

  video?.addEventListener("loadedmetadata", () => {
    syncStageAspectToVideo();
    setStageSize(true);
  });

  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

document.addEventListener("DOMContentLoaded", bindEvents);
