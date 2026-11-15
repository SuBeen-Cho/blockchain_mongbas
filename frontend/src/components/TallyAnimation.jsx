import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { shortHex } from '../utils/tallyStory.js';

/**
 * 개표 과정 3D 연출. 모든 숫자/해시는 공개 게시판에서 다시 계산한 실제 값.
 * 타임라인은 t(초)의 순수 함수라서 다시 보기·단계 이동이 정확히 재현된다.
 */
const BLUE = 0x2440f2;
const SKY = 0x5b8cff;
const GOLD = 0xffc24b;
const INK = 0x070b1f;
const ORG_LABELS = { ElectionCommissionMSP: '선거관리위원회', PartyObserverMSP: '참관 정당', CivilSocietyMSP: '시민단체' };
const ORGS = ['ElectionCommissionMSP', 'PartyObserverMSP', 'CivilSocietyMSP'];

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const easeBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

function buildScenes(deniable) {
  // [start, end, title, caption]
  const s = [];
  let t = 0;
  const push = (len, title, caption) => { s.push({ start: t, end: t + len, title, caption }); t += len; };
  push(3.2, '표 불러오기', '원장에 올라간 봉인된 표 불러오는 중');
  if (deniable) push(3.4, '집계 칸 꺼내기', '공개된 표 뒤의 집계 칸만 사용 · 패닉 여부는 아무도 모름');
  push(4.2, '암호문째로 합산', '후보별로 암호문끼리 곱해서 합산 진행 · 표 하나하나는 열지 않음');
  push(4.4, '두 기관이 함께 열기', '3개 기관 중 2곳이 각자 열쇠 조각으로 부분 복호화 진행');
  push(3.8, '결과 확인', '복호화 완료 · 후보별 득표 확인');
  return { scenes: s, duration: t + 1.2 };
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(160,190,255,0.85)');
  grd.addColorStop(0.6, 'rgba(60,90,255,0.25)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export default function TallyAnimation({ story }) {
  const mountRef = useRef(null);
  const overlayRef = useRef(null);
  const ctlRef = useRef(null);
  const [sceneIdx, setSceneIdx] = useState(0);
  const [done, setDone] = useState(false);
  const [webgl, setWebgl] = useState(true);

  const timeline = buildScenes(story?.deniable);

  useEffect(() => {
    if (!story || !mountRef.current) return undefined;
    const mount = mountRef.current;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      setWebgl(false);
      return undefined;
    }
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(INK);
    scene.fog = new THREE.FogExp2(INK, 0.045);
    const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 200);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1024, 576), 0.85, 0.55, 0.18);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const disposables = [];
    const track = (o) => { disposables.push(o); return o; };

    // ── lights & stage ──
    scene.add(new THREE.AmbientLight(0x8fa6ff, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(4, 8, 6);
    scene.add(key);
    const rim = new THREE.PointLight(SKY, 30, 30);
    rim.position.set(-6, 4, -4);
    scene.add(rim);
    const grid = new THREE.GridHelper(40, 40, 0x1d2a6b, 0x111a45);
    grid.position.y = -1.6;
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    scene.add(grid);
    const sprite = track(glowTexture());
    const floorGlow = new THREE.Mesh(track(new THREE.PlaneGeometry(16, 16)), track(new THREE.MeshBasicMaterial({ map: sprite, color: 0x3550ff, transparent: true, opacity: 0.28, depthWrite: false, blending: THREE.AdditiveBlending })));
    floorGlow.rotation.x = -Math.PI / 2;
    floorGlow.position.y = -1.59;
    scene.add(floorGlow);
    const candN = story.candidates.length;
    const orbX = (k) => (k - (candN - 1) / 2) * 3.2;

    // ── ballots ──
    const MAX_VIS = 48;
    const shown = story.ballots.slice(0, MAX_VIS);
    const n = shown.length;
    const cols = Math.min(12, Math.max(4, Math.ceil(Math.sqrt(n * 2.2))));
    const rows = Math.ceil(n / cols);
    const spacing = Math.min(1.0, 7.2 / cols);
    const ballotScale = spacing / 0.62;
    const slotPos = (i) => new THREE.Vector3(((i % cols) - (cols - 1) / 2) * spacing, 2.3 - Math.floor(i / cols) * spacing + (rows - 1) * spacing * 0.35, -0.8 - Math.floor(i / cols) * 0.12);
    const cubeGeo = track(new THREE.BoxGeometry(0.42, 0.42, 0.42));
    const edgeGeo = track(new THREE.EdgesGeometry(cubeGeo));
    const cardGeo = track(new THREE.BoxGeometry(0.46, 0.58, 0.04));
    const coreGeo = track(new THREE.IcosahedronGeometry(0.13, 2));
    const ballots = shown.map((b, i) => {
      const group = new THREE.Group();
      group.scale.setScalar(ballotScale);
      const mat = new THREE.MeshStandardMaterial({ color: 0x1a2a7a, emissive: BLUE, emissiveIntensity: 0.35, metalness: 0.6, roughness: 0.3, transparent: true, opacity: 1 });
      const cube = new THREE.Mesh(cubeGeo, mat);
      const edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: SKY, transparent: true, opacity: 0.9 }));
      cube.add(edges);
      const cardMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ff, emissive: 0x5b6fd6, emissiveIntensity: 0.15, transparent: true, opacity: 0, roughness: 0.6 });
      const card = new THREE.Mesh(cardGeo, cardMat);
      const coreMat = new THREE.MeshBasicMaterial({ color: 0xbfd0ff, transparent: true, opacity: 0 });
      const core = new THREE.Mesh(coreGeo, coreMat);
      group.add(cube, card, core);
      scene.add(group);
      disposables.push(mat, edges.material, cardMat, coreMat);
      const seed = (parseInt(String(b.nullifierHash || '').slice(0, 6), 16) || i * 7919) % 1000 / 1000;
      return { group, cube, card, core, mat, cardMat, coreMat, edges, home: slotPos(i), seed };
    });

    // ── candidate orbs + lock rings ──
    const orbGeo = track(new THREE.SphereGeometry(0.62, 48, 48));
    const ringGeo = track(new THREE.TorusGeometry(0.95, 0.035, 12, 96));
    const orbs = story.candidates.map((_, k) => {
      const mat = new THREE.MeshStandardMaterial({ color: 0x0f1a55, emissive: BLUE, emissiveIntensity: 0.2, metalness: 0.85, roughness: 0.18, transparent: true, opacity: 0 });
      const orb = new THREE.Mesh(orbGeo, mat);
      orb.position.set(orbX(k), 0.2, 0);
      const rings = [0, 1].map((r) => {
        const rm = new THREE.MeshBasicMaterial({ color: r ? SKY : GOLD, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
        const ring = new THREE.Mesh(ringGeo, rm);
        ring.rotation.x = Math.PI / 2 + r * 0.9;
        orb.add(ring);
        disposables.push(rm);
        return ring;
      });
      scene.add(orb);
      disposables.push(mat);
      return { orb, mat, rings };
    });

    // ── particle streams (ballot core -> candidate orb) ──
    const streamCount = n * candN;
    const streamGeo = track(new THREE.BufferGeometry());
    const streamPos = new Float32Array(streamCount * 3);
    streamGeo.setAttribute('position', new THREE.BufferAttribute(streamPos, 3));
    const streamMat = track(new THREE.PointsMaterial({ size: 0.22, map: sprite, color: 0xa9c0ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    const stream = new THREE.Points(streamGeo, streamMat);
    scene.add(stream);

    // ── trustee keys ──
    const keyGeo = track(new THREE.OctahedronGeometry(0.26, 0));
    const usedOrgs = new Set(story.partials.map((pd) => pd.mspID));
    const keys = ORGS.map((org, j) => {
      const active = usedOrgs.has(org) || (usedOrgs.size === 0 && j < 2);
      const mat = new THREE.MeshStandardMaterial({ color: active ? GOLD : 0x3a4370, emissive: active ? GOLD : 0x1c2245, emissiveIntensity: active ? 1.2 : 0.2, metalness: 0.7, roughness: 0.25, transparent: true, opacity: 0 });
      const mesh = new THREE.Mesh(keyGeo, mat);
      scene.add(mesh);
      disposables.push(mat);
      return { org, active, mesh, mat, home: new THREE.Vector3((j - 1) * 3.9, 2.35, 1.2) };
    });

    // beams: every active key partially decrypts EVERY candidate aggregate
    const activeKeys = keys.filter((kk) => kk.active);
    const beamGeo = track(new THREE.BufferGeometry());
    const beamPos = new Float32Array(activeKeys.length * candN * 6);
    beamGeo.setAttribute('position', new THREE.BufferAttribute(beamPos, 3));
    const beamMat = track(new THREE.LineBasicMaterial({ color: GOLD, transparent: true, opacity: 0, blending: THREE.AdditiveBlending }));
    scene.add(new THREE.LineSegments(beamGeo, beamMat));

    // ── result bars ──
    const maxCount = Math.max(1, ...story.counts);
    const barGeo = track(new THREE.BoxGeometry(1.1, 1, 1.1));
    barGeo.translate(0, 0.5, 0);
    const bars = story.candidates.map((_, k) => {
      const lead = story.counts[k] === maxCount && maxCount > 0;
      const mat = new THREE.MeshStandardMaterial({ color: lead ? 0x2f4bff : 0x5b7cff, emissive: lead ? BLUE : 0x3a55e0, emissiveIntensity: lead ? 0.95 : 0.55, metalness: 0.35, roughness: 0.35, transparent: true, opacity: 0 });
      const bar = new THREE.Mesh(barGeo, mat);
      bar.position.set(orbX(k), -1.58, 0);
      bar.scale.set(1, 0.001, 1);
      scene.add(bar);
      disposables.push(mat);
      return { bar, mat, h: 0.25 + (story.counts[k] / maxCount) * 3.2 };
    });

    // burst particles at the end
    const burstN = 320;
    const burstGeo = track(new THREE.BufferGeometry());
    const burstPos = new Float32Array(burstN * 3);
    const burstDir = Array.from({ length: burstN }, (_, i) => {
      const k = i % candN, u = Math.random() * Math.PI * 2, v = Math.acos(2 * Math.random() - 1);
      return { k, d: new THREE.Vector3(Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u)), s: 0.6 + Math.random() * 1.6 };
    });
    burstGeo.setAttribute('position', new THREE.BufferAttribute(burstPos, 3));
    const burstMat = track(new THREE.PointsMaterial({ size: 0.16, map: sprite, color: 0xffe2a0, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    scene.add(new THREE.Points(burstGeo, burstMat));

    // ── overlay labels (projected HTML for crisp Korean text) ──
    const overlay = overlayRef.current;
    overlay.innerHTML = '';
    const mkLabel = (cls) => { const el = document.createElement('div'); el.className = cls; overlay.appendChild(el); return el; };
    const orbLabels = story.candidates.map((c, k) => { const el = mkLabel('ta-label'); el.innerHTML = `<b>${c}</b><span>${shortHex(story.aggregate[k]?.c1, 8, 4)}</span>`; return el; });
    const keyLabels = keys.map((kk) => { const el = mkLabel('ta-key'); el.textContent = `${ORG_LABELS[kk.org]}${kk.active ? '' : ' · 이번엔 쉼'}`; return el; });
    const barLabels = story.candidates.map((c, k) => { const el = mkLabel('ta-count'); el.innerHTML = `<em>${c}</em><b>${story.counts[k]}</b><span>표</span>`; return el; });
    const ledgerLabel = mkLabel('ta-ledger');
    ledgerLabel.textContent = `봉인된 표 ${story.voters}개${story.ballots.length > MAX_VIS ? ` (화면엔 ${MAX_VIS}개)` : ''}`;

    const v3 = new THREE.Vector3();
    const place = (el, pos, opacity, w, h) => {
      v3.copy(pos).project(camera);
      el.style.transform = `translate(-50%,-50%) translate(${(v3.x * 0.5 + 0.5) * w}px, ${(-v3.y * 0.5 + 0.5) * h}px)`;
      el.style.opacity = String(opacity);
    };

    const { scenes, duration } = buildScenes(story.deniable);
    const at = (name) => scenes.find((s) => s.title === name) || { start: -1, end: -1 };
    const S_LOAD = at('표 불러오기'), S_SLOT = at('집계 칸 꺼내기'), S_SUM = at('암호문째로 합산'), S_KEY = at('두 기관이 함께 열기'), S_RES = at('결과 확인');
    const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

    let width = 0, height = 0;
    const resize = () => {
      width = mount.clientWidth; height = mount.clientHeight;
      renderer.setSize(width, height, false);
      composer.setSize(width, height);
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    function frame(t) {
      // camera: slow dolly that follows the action
      const camZ = 11.5 - 2.2 * easeInOut(seg(t, 0, duration));
      const camY = 3.2 - 1.1 * easeInOut(seg(t, S_SUM.start, S_RES.end));
      camera.position.set(Math.sin(t * 0.12) * 1.4, camY, camZ);
      camera.lookAt(0, 0.4 + 0.4 * (1 - seg(t, S_SUM.start, S_SUM.end)), 0);

      // 1) ballots fall into the ledger rack
      const loadP = seg(t, S_LOAD.start, S_LOAD.end - 0.4);
      ballots.forEach((b, i) => {
        const delay = (i / Math.max(1, n)) * 0.55;
        const p = easeBack(seg(loadP, delay, delay + 0.45));
        b.group.position.set(b.home.x, b.home.y + (1 - p) * 6, b.home.z);
        b.group.rotation.set((1 - p) * 2.2 + t * 0.15 * b.seed, (1 - p) * 1.5 + t * 0.2, 0);
        let cubeOpacity = p;
        // 2) deniable: split visible card vs counted core
        if (story.deniable) {
          const sp = easeInOut(seg(t, S_SLOT.start + b.seed * 0.6, S_SLOT.start + 1.6 + b.seed * 0.6));
          b.card.position.set(0, 0, -0.35 * sp);
          b.card.rotation.set(0, sp * 0.4, 0);
          b.cardMat.opacity = sp * (1 - seg(t, S_SLOT.end - 1.0, S_SLOT.end)) * 0.75;
          b.core.position.set(0, 0, 0.45 * sp);
          b.coreMat.opacity = sp;
          cubeOpacity = p * (1 - 0.75 * sp);
        } else {
          b.coreMat.opacity = seg(t, S_SUM.start - 0.6, S_SUM.start);
          b.core.position.set(0, 0, 0.3);
        }
        // fade out once streams leave
        const leave = seg(t, S_SUM.start + 0.4, S_SUM.end - 0.8);
        b.mat.opacity = cubeOpacity * (1 - leave);
        b.edges.material.opacity = 0.9 * cubeOpacity * (1 - leave);
        b.coreMat.opacity *= 1 - leave;
        b.mat.emissiveIntensity = 0.35 + 0.6 * Math.max(0, Math.sin(t * 2 + i));
        b.group.visible = t < S_SUM.end && (b.mat.opacity > 0.01 || b.coreMat.opacity > 0.01 || b.cardMat.opacity > 0.01);
        b.card.visible = b.cardMat.opacity > 0.01;
      });

      // 3) homomorphic sum: particles stream from every counted core into each candidate orb
      const orbIn = easeOut(seg(t, S_SUM.start, S_SUM.start + 0.8));
      const sumP = seg(t, S_SUM.start + 0.3, S_SUM.end - 0.4);
      streamMat.opacity = sumP > 0 && sumP < 1 ? 0.95 : 0;
      let pi = 0;
      ballots.forEach((b, i) => {
        b.group.updateMatrixWorld();
        b.core.getWorldPosition(tmp);
        for (let k = 0; k < candN; k++) {
          const d = (i / Math.max(1, n)) * 0.5 + k * 0.04;
          const q = easeInOut(seg(sumP, d, d + 0.45));
          tmp2.set(orbX(k), 0.2, 0);
          const mid = new THREE.Vector3((tmp.x + tmp2.x) / 2, Math.max(tmp.y, tmp2.y) + 1.6, (tmp.z + tmp2.z) / 2 + 0.6);
          const x = (1 - q) * (1 - q) * tmp.x + 2 * (1 - q) * q * mid.x + q * q * tmp2.x;
          const y = (1 - q) * (1 - q) * tmp.y + 2 * (1 - q) * q * mid.y + q * q * tmp2.y;
          const z = (1 - q) * (1 - q) * tmp.z + 2 * (1 - q) * q * mid.z + q * q * tmp2.z;
          streamPos[pi++] = q >= 1 || q <= 0 ? 999 : x;
          streamPos[pi++] = y;
          streamPos[pi++] = z;
        }
      });
      streamGeo.attributes.position.needsUpdate = true;

      orbs.forEach((o, k) => {
        const filled = seg(sumP, 0.15, 1);
        const breathe = 1 + 0.03 * Math.sin(t * 3 + k);
        o.orb.scale.setScalar((0.6 + 0.4 * orbIn + 0.25 * filled) * breathe);
        o.mat.opacity = orbIn * (1 - seg(t, S_RES.start, S_RES.start + 0.5));
        o.mat.emissiveIntensity = 0.2 + 1.1 * filled;
        o.orb.rotation.y = t * 0.6;
        // lock rings dissolve as two keys arrive
        const unlock = easeInOut(seg(t, S_KEY.start + 2.2, S_KEY.end - 0.3));
        o.rings.forEach((r, j) => {
          r.material.opacity = orbIn * (1 - unlock) * (0.9 - 0.3 * j);
          r.rotation.z = t * (j ? -1.1 : 0.8);
          r.scale.setScalar(1 + unlock * 0.6);
        });
        o.orb.visible = o.mat.opacity > 0.01;
      });

      // 4) trustee keys: two active keys travel into the orbs, the third stays home
      const keyIn = easeOut(seg(t, S_KEY.start, S_KEY.start + 0.8));
      keys.forEach((kk, j) => {
        kk.mat.opacity = keyIn * (1 - seg(t, S_RES.start, S_RES.start + 0.4));
        kk.mesh.visible = kk.mat.opacity > 0.01;
        kk.mesh.rotation.set(t * 1.4, t * 1.1, 0);
        if (kk.active) {
          // fly to a station above the orb row (left/right of centre)
          const travel = easeInOut(seg(t, S_KEY.start + 0.7, S_KEY.start + 2.0));
          const slot = activeKeys.indexOf(kk);
          tmp.set((slot - (activeKeys.length - 1) / 2) * 1.6, 2.1 + 0.08 * Math.sin(t * 2 + slot), 0.9);
          kk.mesh.position.lerpVectors(kk.home, tmp, travel);
          kk.mat.emissiveIntensity = 1.2 + 1.5 * travel;
        } else {
          kk.mesh.position.copy(kk.home);
        }
      });

      const beamP = seg(t, S_KEY.start + 1.9, S_KEY.start + 2.4) * (1 - seg(t, S_KEY.end - 0.5, S_KEY.end));
      beamMat.opacity = beamP * (0.55 + 0.35 * Math.sin(t * 9));
      let bi = 0;
      activeKeys.forEach((kk) => {
        for (let k = 0; k < candN; k++) {
          beamPos[bi++] = kk.mesh.position.x; beamPos[bi++] = kk.mesh.position.y; beamPos[bi++] = kk.mesh.position.z;
          beamPos[bi++] = orbX(k); beamPos[bi++] = 0.2; beamPos[bi++] = 0;
        }
      });
      beamGeo.attributes.position.needsUpdate = true;

      // 5) results: burst + bars
      const resP = seg(t, S_RES.start, S_RES.start + 1.6);
      burstMat.opacity = resP > 0 && resP < 1 ? 1 - resP : 0;
      burstDir.forEach((bd, i) => {
        const r = easeOut(resP) * bd.s * 1.8;
        burstPos[i * 3] = orbX(bd.k) + bd.d.x * r;
        burstPos[i * 3 + 1] = 0.2 + bd.d.y * r - resP * resP * 1.2;
        burstPos[i * 3 + 2] = bd.d.z * r;
      });
      burstGeo.attributes.position.needsUpdate = true;
      bars.forEach((b, k) => {
        const g = easeBack(seg(t, S_RES.start + 0.5 + k * 0.18, S_RES.start + 2.0 + k * 0.18));
        b.bar.scale.y = Math.max(0.001, b.h * g);
        b.mat.opacity = Math.min(1, g * 1.4);
        b.bar.visible = b.mat.opacity > 0.01;
      });

      // overlay labels
      const w = width, h = height;
      ledgerLabel.style.opacity = String(seg(t, 0.4, 1.0) * (1 - seg(t, S_SUM.start, S_SUM.start + 0.5)));
      ledgerLabel.style.transform = `translate(-50%,0) translate(${w / 2}px, ${h * 0.06}px)`;
      orbs.forEach((o, k) => place(orbLabels[k], tmp.set(orbX(k), -0.85, 0), orbIn * (1 - seg(t, S_RES.start, S_RES.start + 0.4)), w, h));
      keys.forEach((kk, j) => place(keyLabels[j], tmp.copy(kk.mesh.position).add(tmp2.set(0, 0.55, 0)), kk.mat.opacity * (kk.active ? 1 - seg(t, S_KEY.start + 1.6, S_KEY.start + 2.2) : 0.8), w, h));
      bars.forEach((b, k) => place(barLabels[k], tmp.set(orbX(k), -1.58 + b.bar.scale.y + 0.45, 0.6), seg(t, S_RES.start + 1.2 + k * 0.18, S_RES.start + 1.8 + k * 0.18), w, h));

      composer.render();
    }

    let raf = 0, t0 = performance.now(), offset = 0, lastScene = -1, finished = false;
    const tick = () => {
      const t = reduceMotion ? duration : Math.min(duration, offset + (performance.now() - t0) / 1000);
      frame(t);
      const idx = Math.max(0, scenes.findIndex((s) => t >= s.start && t < s.end));
      const si = t >= scenes[scenes.length - 1].start ? scenes.length - 1 : idx;
      if (si !== lastScene) { lastScene = si; setSceneIdx(si); }
      const isDone = t >= duration;
      if (isDone !== finished) { finished = isDone; setDone(isDone); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    ctlRef.current = {
      replay: () => { offset = 0; t0 = performance.now(); },
      jump: (i) => { offset = scenes[i].start; t0 = performance.now(); },
    };

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      ctlRef.current = null;
      disposables.forEach((d) => d.dispose?.());
      composer.dispose?.();
      renderer.dispose();
      renderer.domElement.remove();
      if (overlay) overlay.innerHTML = '';
    };
  }, [story]);

  const replay = useCallback(() => ctlRef.current?.replay(), []);
  const jump = useCallback((i) => ctlRef.current?.jump(i), []);

  if (!story) return null;
  const current = timeline.scenes[sceneIdx] || timeline.scenes[0];
  return (
    <section className="ta-root">
      <div className="ta-stage" ref={mountRef}>
        {!webgl && <div className="ta-fallback">이 기기에서는 3D 화면을 띄울 수 없어 아래 단계별 값으로 확인</div>}
        <div className="ta-overlay" ref={overlayRef} />
        <div className="ta-caption">
          <div className="ta-step">{sceneIdx + 1} / {timeline.scenes.length}</div>
          <div className="ta-title">{current.title}</div>
          <div className="ta-sub">{current.caption}</div>
        </div>
      </div>
      <div className="ta-bar">
        {timeline.scenes.map((s, i) => (
          <button key={s.title} type="button" onClick={() => jump(i)} className={`ta-chip${i === sceneIdx ? ' on' : ''}${i < sceneIdx || done ? ' past' : ''}`}>
            <span>{i + 1}</span>{s.title}
          </button>
        ))}
        <button type="button" onClick={replay} className="ta-replay">{done ? '다시 보기' : '처음부터'}</button>
      </div>
    </section>
  );
}

if (typeof document !== 'undefined' && !document.getElementById('ta-style')) {
  const s = document.createElement('style');
  s.id = 'ta-style';
  s.textContent = `
.ta-root{display:flex;flex-direction:column;gap:0;border:1.5px solid #1d2a6b;background:#070b1f;overflow:hidden}
.ta-stage{position:relative;width:100%;aspect-ratio:16/8.2;min-height:300px}
.ta-stage canvas{display:block;width:100%!important;height:100%!important}
.ta-overlay{position:absolute;inset:0;pointer-events:none;font-family:inherit}
.ta-label,.ta-key,.ta-count,.ta-ledger{position:absolute;left:0;top:0;white-space:nowrap;transition:opacity .2s;will-change:transform}
.ta-label{display:flex;flex-direction:column;align-items:center;gap:2px;color:#fff}
.ta-label b{font-size:15px;font-weight:900;letter-spacing:-.03em}
.ta-label span{font:700 10.5px/1 ui-monospace,monospace;color:#9fb3ff;background:rgba(12,20,60,.75);padding:3px 6px}
.ta-key{font-size:12px;font-weight:900;color:#ffd98a;background:rgba(40,28,0,.55);padding:4px 8px;border:1px solid rgba(255,194,75,.5)}
.ta-count{display:flex;align-items:baseline;gap:3px;color:#fff;text-shadow:0 0 18px rgba(80,120,255,.9)}
.ta-count b{font-size:34px;font-weight:900;letter-spacing:-.05em}
.ta-count span{font-size:14px;font-weight:900;color:#9fb3ff}
.ta-count em{font-style:normal;font-size:14px;font-weight:900;color:#dfe6ff;margin-right:6px}
.ta-ledger{font-size:13px;font-weight:900;color:#c9d5ff;letter-spacing:-.02em}
.ta-caption{position:absolute;left:18px;bottom:16px;right:18px;color:#fff;pointer-events:none}
.ta-step{display:inline-block;font:900 11px/1 inherit;letter-spacing:.12em;color:#9fb3ff;margin-bottom:6px}
.ta-title{font-size:clamp(18px,2vw,24px);font-weight:900;letter-spacing:-.04em}
.ta-sub{margin-top:4px;font-size:clamp(12.5px,1.2vw,14px);font-weight:700;color:#c3cdf5}
.ta-fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#c3cdf5;font-weight:800;font-size:14px}
.ta-bar{display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px;background:#0b1130;border-top:1px solid #1d2a6b}
.ta-chip{display:flex;align-items:center;gap:6px;height:32px;padding:0 11px;border:1px solid #2a3880;background:transparent;color:#8e9cd6;font:800 12.5px/1 inherit;cursor:pointer}
.ta-chip span{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;background:#1b2560;color:#c3cdf5;font-size:11px}
.ta-chip.past{color:#c3cdf5}
.ta-chip.on{background:#2440F2;border-color:#2440F2;color:#fff}
.ta-chip.on span{background:#fff;color:#2440F2}
.ta-replay{margin-left:auto;height:32px;padding:0 14px;border:1px solid #5b8cff;background:#fff;color:#2440F2;font:900 12.5px/1 inherit;cursor:pointer}
@media (prefers-reduced-motion: reduce){.ta-label,.ta-key,.ta-count{transition:none}}
`;
  document.head.appendChild(s);
}
