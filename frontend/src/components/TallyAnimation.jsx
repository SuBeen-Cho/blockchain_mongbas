import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { shortHex } from '../utils/tallyStory.js';
import { createCharacters } from './tally3d/characters.js';
import { createWorld } from './tally3d/world.js';
import { createPipeline } from './tally3d/post.js';
import { rng, fbm3 } from './tally3d/sculpt.js';

/**
 * 개표 과정 3D 연출 — "빙하기가 오기 전에".
 * 화면에 나오는 숫자·해시·참여 기관은 모두 공개 게시판에서 다시 계산한 실제 값이고,
 * 연출(공룡·호박·알·돌기둥)은 그 값을 보여 주는 옷일 뿐이다.
 * 타임라인은 t(초)의 순수 함수라서 다시 보기·단계 이동이 정확히 재현된다.
 */
const GOLD = 0xffc24b;
const G = -1.6; // 땅 높이
const ORG_LABELS = { ElectionCommissionMSP: '선거관리위원회', PartyObserverMSP: '참관 정당', CivilSocietyMSP: '시민단체' };
const ORGS = ['ElectionCommissionMSP', 'PartyObserverMSP', 'CivilSocietyMSP'];
const ORG_KIND = { ElectionCommissionMSP: 'tri', PartyObserverMSP: 'stego', CivilSocietyMSP: 'brachio' };

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const easeBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const lerp = THREE.MathUtils.lerp;

function buildScenes(deniable) {
  const s = [];
  let t = 0;
  const push = (len, title, caption) => { s.push({ start: t, end: t + len, title, caption }); t += len; };
  push(4.8, '표 불러오기', '원장에 올라간 봉인된 표 불러오는 중');
  if (deniable) push(3.6, '집계 칸 꺼내기', '공개된 표 뒤의 집계 칸만 사용 · 패닉 여부는 아무도 모름');
  push(7.0, '암호문째로 합산', '후보별로 암호문끼리 곱해서 합산 진행 · 표 하나하나는 열지 않음');
  push(5.2, '두 기관이 함께 열기', '3개 기관 중 2곳이 각자 열쇠 조각으로 부분 복호화 진행');
  push(5.0, '결과 확인', '복호화 완료 · 후보별 득표 확인');
  return { scenes: s, duration: t + 1.5 };
}

function eggTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const base = g.createLinearGradient(0, 0, 0, 256);
  base.addColorStop(0, '#fffaf0');
  base.addColorStop(1, '#f3e2c4');
  g.fillStyle = base;
  g.fillRect(0, 0, 512, 256);
  const r = rng(11);
  for (let i = 0; i < 90; i++) {
    g.fillStyle = r() < 0.55 ? 'rgba(150,96,56,0.5)' : 'rgba(96,170,140,0.42)';
    g.beginPath();
    g.ellipse(r() * 512, 16 + r() * 224, 3 + r() * 13, 3 + r() * 9, r() * 3, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export default function TallyAnimation({ story }) {
  const mountRef = useRef(null);
  const progressRef = useRef(null);
  const overlayRef = useRef(null);
  const ctlRef = useRef(null);
  const [sceneIdx, setSceneIdx] = useState(0);
  const [done, setDone] = useState(false);
  const [webgl, setWebgl] = useState(true);
  const [ready, setReady] = useState(false);

  const timeline = buildScenes(story?.deniable);

  useEffect(() => {
    if (!story || !mountRef.current) return undefined;
    const mount = mountRef.current;
    const overlay = overlayRef.current;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    } catch {
      setWebgl(false);
      return undefined;
    }
    setReady(false);
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const disposables = [];
    const track = (o) => { disposables.push(o); return o; };
    let raf = 0;
    let ro = null;
    let pipeline = null;
    let cancelled = false;

    // 모델 조각에 1~2초 걸리므로 "불러오는 중" 글자를 먼저 그린 뒤 시작
    const bootTimer = setTimeout(() => {
      if (cancelled) return;
      const scene = new THREE.Scene();
      const pmrem = track(new THREE.PMREMGenerator(renderer));
      scene.environment = track(pmrem.fromScene(new RoomEnvironment(), 0.04).texture);
      scene.environmentIntensity = 0.42;
      const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.3, 600);
      pipeline = createPipeline(renderer, scene, camera);
      const world = createWorld({ scene, track, ground: G });
      const kit = createCharacters(track);

      const { scenes, duration } = buildScenes(story.deniable);
      const at = (name) => scenes.find((s) => s.title === name) || { start: -1, end: -1 };
      const S_LOAD = at('표 불러오기'), S_SLOT = at('집계 칸 꺼내기'), S_SUM = at('암호문째로 합산'), S_KEY = at('두 기관이 함께 열기'), S_RES = at('결과 확인');
      const L = S_LOAD.start, K = S_KEY.start, RS = S_RES.start;
      const ROAR = S_SUM.start; // 포효 시작
      const candN = story.candidates.length;
      const orbX = (k) => (k - (candN - 1) / 2) * 3.2;
      const home = new THREE.Vector3(orbX(candN - 1) + (candN < 3 ? 2.9 : 1.6), G, 1.6);
      const leftEdge = orbX(0) - 1.3, rightEdge = home.x + 1.0;
      const cx = (leftEdge + rightEdge) / 2;
      const D = Math.max(11.2, 1.6 + ((rightEdge - leftEdge) / 2 + 0.7) / 0.654);
      const R = rng(77);

      // ── 표: 호박 속에 봉인 ──
      const MAX_VIS = 48;
      const shown = story.ballots.slice(0, MAX_VIS);
      const n = shown.length;
      const cols = Math.min(12, Math.max(4, Math.ceil(Math.sqrt(n * 2.2))));
      const rows = Math.ceil(n / cols);
      const spacing = Math.min(1.0, 7.2 / cols);
      const ballotScale = spacing / 0.62;
      const slotPos = (i) => new THREE.Vector3(((i % cols) - (cols - 1) / 2) * spacing, 2.5 - Math.floor(i / cols) * spacing + (rows - 1) * spacing * 0.35, -0.9 - Math.floor(i / cols) * 0.12);
      const cubeGeo = track(new RoundedBoxGeometry(0.42, 0.42, 0.42, 5, 0.15));
      const cardGeo = track(new RoundedBoxGeometry(0.4, 0.5, 0.05, 2, 0.02));
      const coreGeo = track(new THREE.OctahedronGeometry(0.1, 0));
      coreGeo.scale(0.75, 1.25, 0.75);
      const ballots = shown.map((b, i) => {
        const group = new THREE.Group();
        group.scale.setScalar(ballotScale);
        const mat = new THREE.MeshPhysicalMaterial({ color: 0xf0992a, emissive: 0xff6a00, emissiveIntensity: 0.3, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.04, transparent: true, opacity: 0.86 });
        const cube = new THREE.Mesh(cubeGeo, mat);
        cube.castShadow = true;
        const cardMat = new THREE.MeshStandardMaterial({ color: 0xcdb892, transparent: true, opacity: 0, roughness: 0.95 });
        const card = new THREE.Mesh(cardGeo, cardMat);
        const coreMat = new THREE.MeshPhysicalMaterial({ color: 0xfff0c0, emissive: 0xffa020, emissiveIntensity: 0.9, roughness: 0.15, metalness: 0.4, clearcoat: 1, flatShading: true, transparent: true, opacity: 0 });
        const core = new THREE.Mesh(coreGeo, coreMat);
        core.renderOrder = -1;
        group.add(core, card, cube);
        scene.add(group);
        disposables.push(mat, cardMat, coreMat);
        const seed = (parseInt(String(b.nullifierHash || '').slice(0, 6), 16) || i * 7919) % 1000 / 1000;
        return { group, cube, card, core, mat, cardMat, coreMat, home: slotPos(i), seed };
      });

      // ── 후보별 알 (암호화된 합계) + 둥지 ──
      const NEST_TOP = -0.78, EGG_Y = 0.02;
      const eggGeo = track(new THREE.SphereGeometry(0.62, 48, 40));
      {
        const p = eggGeo.attributes.position;
        for (let i = 0; i < p.count; i++) { const y = p.getY(i) / 0.62; const f = 1 - 0.15 * y; p.setXYZ(i, p.getX(i) * f, y * 0.62 * 1.2, p.getZ(i) * f); }
        eggGeo.computeVertexNormals();
      }
      const eggTex = track(eggTexture());
      const ringGeo = track(new THREE.TorusGeometry(1.02, 0.03, 12, 96));
      const strawGeo = track(new THREE.TorusGeometry(0.62, 0.2, 8, 20));
      const strawMat = track(new THREE.MeshStandardMaterial({ color: 0x8f6d3c, roughness: 1, flatShading: true }));
      const orbs = story.candidates.map((_, k) => {
        const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: eggTex, emissive: 0xff9838, emissiveIntensity: 0, roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.25, sheen: 0.5, sheenColor: new THREE.Color(0xfff2d8) });
        const orb = new THREE.Mesh(eggGeo, mat);
        orb.castShadow = true;
        orb.position.set(orbX(k), EGG_Y, 0);
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: world.glowTex, color: new THREE.Color().setRGB(1.6, 1.0, 0.5), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
        halo.scale.setScalar(3.6);
        orb.add(halo);
        const rings = [0, 1].map((r) => {
          const rm = new THREE.MeshBasicMaterial({ color: r ? new THREE.Color().setRGB(0.6, 1.5, 2.6) : new THREE.Color().setRGB(2.6, 1.5, 0.4), transparent: true, opacity: 0, depthWrite: false });
          const ring = new THREE.Mesh(ringGeo, rm);
          ring.rotation.x = Math.PI / 2 + r * 0.9;
          orb.add(ring);
          disposables.push(rm);
          return ring;
        });
        const nest = new THREE.Group();
        const rock = world.makeRock(k * 5.1 + 2, 0.95, 1.25, 0.95, 1);
        rock.position.y = -0.82;
        const straw = new THREE.Mesh(strawGeo, strawMat);
        straw.rotation.x = Math.PI / 2;
        straw.scale.z = 0.7;
        straw.castShadow = true;
        nest.add(rock, straw);
        nest.position.set(orbX(k), NEST_TOP, 0);
        scene.add(nest, orb);
        disposables.push(mat, halo.material);
        return { orb, mat, rings, halo, nest };
      });

      // ── 합산 입자 (호박 속 집계 칸 → 알) ──
      const streamCount = n * candN;
      const streamGeo = track(new THREE.BufferGeometry());
      const streamPos = new Float32Array(streamCount * 3);
      streamGeo.setAttribute('position', new THREE.BufferAttribute(streamPos, 3));
      const streamMat = track(new THREE.PointsMaterial({ size: 0.17, map: world.glowTex, color: new THREE.Color().setRGB(1.9, 1.2, 0.45), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      const stream = new THREE.Points(streamGeo, streamMat);
      stream.frustumCulled = false;
      scene.add(stream);

      // ── 집계 기관 공룡 3마리 + 열쇠 수정 ──
      const keyGeo = track(new THREE.OctahedronGeometry(0.26, 0));
      keyGeo.scale(0.8, 1.4, 0.8);
      const usedOrgs = new Set(story.partials.map((pd) => pd.mspID));
      // 결과 숫자와 겹치지 않도록 알 기둥 사이사이에 세움
      const orgXs = candN >= 3 ? [orbX(0) - 2.0, orbX(0) + 1.6, orbX(1) + 1.6] : [orbX(0) - 2.0, (orbX(0) + orbX(candN - 1)) / 2 + (candN === 1 ? 2.0 : 0), orbX(candN - 1) + 2.0];
      const orgCx = (orgXs[0] + orgXs[2]) / 2;
      const keys = ORGS.map((org, j) => {
        const active = usedOrgs.has(org) || (usedOrgs.size === 0 && j < 2);
        const mat = new THREE.MeshPhysicalMaterial({ color: active ? GOLD : 0x8c8173, emissive: active ? GOLD : 0x3a3128, emissiveIntensity: active ? 1.4 : 0.15, metalness: 0.85, roughness: 0.12, clearcoat: 1, envMapIntensity: 1.8, transparent: true, opacity: 0 });
        const mesh = new THREE.Mesh(keyGeo, mat);
        mesh.castShadow = true;
        if (active) {
          const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: world.glowTex, color: new THREE.Color().setRGB(2.0, 1.3, 0.5), transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
          glow.scale.setScalar(2.0);
          mesh.add(glow);
          disposables.push(glow.material);
        }
        scene.add(mesh);
        disposables.push(mat);
        const x = orgXs[j];
        const ped = world.makeRock(j * 9.3 + 40, 1.35, 3.0, 1.15, 2);
        ped.position.set(x, -1.08, -3.7);
        ped.rotation.y = j * 1.3;
        scene.add(ped);
        const dino = kit.buildOrgDino(ORG_KIND[org]);
        dino.root.rotation.y = -(x - orgCx) * 0.08;
        dino.root.visible = false;
        scene.add(dino.root);
        return { org, active, mesh, mat, dino, base: new THREE.Vector3(x, -1.08 + 0.64 * 3.0 - 0.06, -3.6), home: new THREE.Vector3() };
      });
      const activeKeys = keys.filter((kk) => kk.active);
      const beamGeo = track(new THREE.BufferGeometry());
      const beamPos = new Float32Array(activeKeys.length * candN * 6);
      beamGeo.setAttribute('position', new THREE.BufferAttribute(beamPos, 3));
      const beamMat = track(new THREE.LineBasicMaterial({ color: new THREE.Color().setRGB(3.2, 2.0, 0.6), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      const beams = new THREE.LineSegments(beamGeo, beamMat);
      beams.frustumCulled = false;
      scene.add(beams);

      // ── 결과 돌기둥 ──
      const maxCount = Math.max(1, ...story.counts);
      const pillarGeo = track(new THREE.CylinderGeometry(0.58, 0.68, 1, 11, 7));
      {
        pillarGeo.translate(0, 0.5, 0);
        const p = pillarGeo.attributes.position;
        const colors = new Float32Array(p.count * 3);
        const cA = new THREE.Color(0xa9937a), cB = new THREE.Color(0xcdb89b), cC = new THREE.Color(0x8b7762), c = new THREE.Color();
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
          const nn = fbm3(x * 2.2 + 9, y * 5, z * 2.2, 3) - 0.5;
          const rr = Math.hypot(x, z) > 0.01 ? 1 + nn * 0.2 : 1;
          p.setXYZ(i, x * rr, y, z * rr);
          c.copy(cA).lerp(cB, clamp01(0.5 + Math.sin(y * 21 + nn * 6) * 0.6)).lerp(cC, clamp01(nn + 0.3) * 0.5);
          colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
        }
        pillarGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        pillarGeo.computeVertexNormals();
      }
      const mossGeo = track(new THREE.SphereGeometry(1, 16, 10));
      const bars = story.candidates.map((_, k) => {
        const lead = story.counts[k] === maxCount && maxCount > 0;
        const mat = new THREE.MeshStandardMaterial({ vertexColors: true, color: lead ? 0xffe2b0 : 0xffffff, roughness: 0.95, flatShading: true });
        const bar = new THREE.Mesh(pillarGeo, mat);
        bar.castShadow = true; bar.receiveShadow = true;
        bar.position.set(orbX(k), G - 0.02, 0);
        bar.rotation.y = k * 0.7;
        bar.scale.set(1, 0.001, 1);
        bar.visible = false;
        const cap = new THREE.Mesh(lead ? keyGeo : mossGeo, lead
          ? track(new THREE.MeshPhysicalMaterial({ color: GOLD, emissive: GOLD, emissiveIntensity: 1.3, metalness: 0.8, roughness: 0.15, clearcoat: 1 }))
          : track(new THREE.MeshStandardMaterial({ color: 0x6fae5a, roughness: 0.95 })));
        cap.castShadow = true;
        cap.visible = false;
        scene.add(bar, cap);
        disposables.push(mat);
        return { bar, mat, cap, lead, h: 0.3 + (story.counts[k] / maxCount) * 3.1 };
      });
      const leadIdx = Math.max(0, bars.findIndex((b) => b.lead));

      // ── 부화: 알 껍데기 조각 ──
      const SH = 22;
      const shardGeo = track(new THREE.DodecahedronGeometry(0.2, 0));
      shardGeo.scale(1, 0.28, 0.8);
      const shardMat = track(new THREE.MeshStandardMaterial({ color: 0xf7ead0, roughness: 0.55, flatShading: true }));
      const shards = new THREE.InstancedMesh(shardGeo, shardMat, candN * SH);
      shards.castShadow = true;
      shards.frustumCulled = false;
      shards.visible = false;
      scene.add(shards);
      const shardSeed = Array.from({ length: candN * SH }, (_, i) => {
        const u = R() * Math.PI * 2, v = Math.acos(2 * R() - 1);
        return { k: Math.floor(i / SH), d: new THREE.Vector3(Math.sin(v) * Math.cos(u), Math.abs(Math.cos(v)) * 0.9 + 0.25, Math.sin(v) * Math.sin(u)), s: 2.2 + R() * 3.2, ax: new THREE.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).normalize(), sp: 4 + R() * 9, sc: 0.5 + R() * 0.7 };
      });
      const burstN = 260;
      const burstGeo = track(new THREE.BufferGeometry());
      const burstPos = new Float32Array(burstN * 3);
      const burstDir = Array.from({ length: burstN }, (_, i) => {
        const u = R() * Math.PI * 2, v = Math.acos(2 * R() - 1);
        return { k: i % candN, d: new THREE.Vector3(Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u)), s: 0.6 + R() * 1.8 };
      });
      burstGeo.setAttribute('position', new THREE.BufferAttribute(burstPos, 3));
      const burstMat = track(new THREE.PointsMaterial({ size: 0.14, map: world.glowTex, color: new THREE.Color().setRGB(2.4, 1.6, 0.7), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      const burst = new THREE.Points(burstGeo, burstMat);
      burst.frustumCulled = false;
      scene.add(burst);

      // ── 주인공: 아기 티라노 + 머리 위 상상부기 ──
      const trex = kit.buildTrex();
      trex.root.scale.setScalar(0.9);
      scene.add(trex.root);
      const boogi = kit.buildBoogi();
      boogi.root.scale.setScalar(0.72);
      trex.seat.add(boogi.root);
      const FACE = -0.55; // 자리 잡은 뒤 바라보는 방향 (무대 안쪽)
      const RUN0 = L + 0.15, RUN1 = L + 3.4;
      const trexX = (t) => lerp(-13, home.x, 1 - Math.pow(1 - seg(t, RUN0, RUN1), 1.6));

      // 먼지: 발걸음 · 급정지 · 돌기둥
      const puffs = [];
      const addPuff = (t0, x, y, z, size, life, drift) => {
        const m = track(new THREE.SpriteMaterial({ map: world.smokeTex, color: 0xd9bf94, transparent: true, opacity: 0, depthWrite: false, rotation: R() * 6 }));
        const s = new THREE.Sprite(m);
        s.visible = false;
        scene.add(s);
        puffs.push({ s, m, t0, x, y, z, size, life, drift });
      };
      for (let k = 0; RUN0 + 0.15 + k * 0.19 < RUN1 - 0.35; k++) { const tk = RUN0 + 0.15 + k * 0.19; addPuff(tk, trexX(tk) - 0.2, G + 0.15, home.z + (k % 2 ? 0.3 : -0.3), 1.3, 0.9, -0.6); }
      for (let k = 0; k < 5; k++) addPuff(RUN1 - 0.4 + k * 0.07, home.x + 0.3 + k * 0.25, G + 0.2, home.z + (k % 2 ? 0.35 : -0.35), 2.0, 1.2, 0.9);
      story.candidates.forEach((_, k) => { for (let q = 0; q < 4; q++) addPuff(RS + 0.5 + k * 0.18 + q * 0.08, orbX(k) + Math.cos(q * 1.6) * 0.7, G + 0.15, Math.sin(q * 1.6) * 0.7, 1.9, 1.3, 0); });

      // 포효 충격파 고리
      const waveGeo = track(new THREE.RingGeometry(0.95, 1, 64));
      const waves = [0, 1, 2].map(() => {
        const m = track(new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(1.8, 1.7, 1.5), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
        const w = new THREE.Mesh(waveGeo, m);
        w.visible = false;
        scene.add(w);
        return w;
      });

      // ── 배경 공룡 무리 · 익룡 ──
      const herd = [[0.9, -21, 0, 0xffffff], [0.55, -19.5, 0.07, 0xeef5ea], [0.8, -24, 0.4, 0xe6efe8], [0.62, -22.5, 0.47, 0xffffff], [1.0, -27, 0.75, 0xdfe8e2]].map(([s, z, ph, tint]) => {
        const g = kit.buildSauropod(tint);
        g.scale.setScalar(s);
        g.rotation.y = Math.PI / 2;
        g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
        scene.add(g);
        return { g, s, z, ph };
      });
      const pteros = [[11, -30, 0], [13.5, -36, 0.13], [9.5, -24, 0.55]].map(([y, z, ph]) => {
        const p = kit.buildPtero();
        p.g.scale.setScalar(1.5);
        p.g.rotation.y = Math.PI / 2;
        scene.add(p.g);
        return { ...p, y, z, ph };
      });

      // ── 화면 위 글자 (한글이 또렷하도록 HTML로 겹침) ──
      overlay.innerHTML = '';
      const mkLabel = (cls) => { const el = document.createElement('div'); el.className = cls; el.style.opacity = '0'; overlay.appendChild(el); return el; };
      const orbLabels = story.candidates.map((c, k) => { const el = mkLabel('ta-label'); el.innerHTML = `<b></b><span>${shortHex(story.aggregate[k]?.c1, 8, 4)}</span>`; el.firstChild.textContent = c; return el; });
      const keyLabels = keys.map((kk) => { const el = mkLabel('ta-key'); el.textContent = `${ORG_LABELS[kk.org]}${kk.active ? '' : ' · 이번엔 쉼'}`; return el; });
      const zzzLabels = keys.map((kk) => { if (kk.active) return null; const el = mkLabel('ta-zzz'); el.textContent = 'Zzz'; return el; });
      const AGREE = ['동의!', '나도 동의!', '나도!'];
      const sayLabels = keys.map((kk) => { if (!kk.active) return null; const el = mkLabel('ta-bubble ta-say'); el.textContent = AGREE[Math.min(2, activeKeys.indexOf(kk))]; return el; });
      const barLabels = story.candidates.map(() => { const el = mkLabel('ta-count'); el.innerHTML = '<b>0</b><span>표</span>'; return el; });
      const barNames = story.candidates.map((c) => { const el = mkLabel('ta-name'); el.textContent = c; return el; });
      const shownCounts = story.candidates.map(() => -1);
      const ledgerLabel = mkLabel('ta-ledger');
      ledgerLabel.textContent = `호박 속에 봉인된 표 ${story.voters}개${story.ballots.length > MAX_VIS ? ` (화면엔 ${MAX_VIS}개)` : ''}`;
      const sumChip = mkLabel('ta-ledger ta-sumchip');
      sumChip.innerHTML = '집계 중<i>.</i><i>.</i><i>.</i>';
      const bubble = mkLabel('ta-bubble');
      let bubbleSay = '';
      const roarLabel = mkLabel('ta-roar');
      roarLabel.textContent = '크앙!';
      const bigTitle = mkLabel('ta-big');
      bigTitle.innerHTML = '<span>집계 중</span><i>.</i><i>.</i><i>.</i>';

      const v3 = new THREE.Vector3();
      const project = (pos) => { v3.copy(pos).project(camera); return v3; };
      const place = (el, pos, opacity, w, h) => {
        const p = project(pos);
        const ok = p.z < 1 && p.z > -1;
        el.style.transform = `translate(-50%,-50%) translate(${(p.x * 0.5 + 0.5) * w}px, ${(-p.y * 0.5 + 0.5) * h}px)`;
        el.style.opacity = String(ok ? opacity : 0);
      };

      // ── 카메라: 컷으로 이어지는 숏 ──
      const P = new THREE.Vector3(), LK = new THREE.Vector3(), FP = new THREE.Vector3();
      const mix3 = (out, a, b, u) => out.set(lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u));
      const headWorld = new THREE.Vector3(), mouthWorld = new THREE.Vector3();
      const shots = [
        { // 1. 빙하를 피해 달리는 티라노를 낮게 따라감
          a: L, b: L + 2.45, lab: { ledger: 0, orb: 0 },
          fn: (u, t, o) => { const x = trexX(t); P.set(x + 4.4, G + 0.7, home.z + 6.5); LK.set(x + 0.35, G + 1.95, home.z); FP.set(x, G + 1.5, home.z); o.fov = 34; o.range = 3.5; o.blur = 8; },
        },
        { // 2. 크레인 업: 호박 속 표가 내려앉는 전경
          a: L + 2.45, b: S_LOAD.end, lab: {},
          fn: (u, t, o) => { const e = easeInOut(u); mix3(P, [cx - 3.0, G + 1.7, D + 1.4], [cx, 2.5, D + 0.3], e); mix3(LK, [cx + 0.6, 1.1, 0], [cx, 0.85, -0.3], e); FP.set(0, 1, 0.3); o.fov = 38; o.range = 13; o.blur = 4; },
        },
        ...(story.deniable ? [{ // 3. 호박 가까이: 집계 칸 꺼내기
          a: S_SLOT.start, b: S_SLOT.end, lab: { orb: 0 },
          fn: (u, t, o) => { const e = easeInOut(u); mix3(P, [-2.0, 1.4, 7.8], [1.1, 1.9, 6.4], e); LK.set(0, 1.6, -0.9); FP.set(0, 1.6, -0.9); o.fov = 33; o.range = 2.6; o.blur = 9; },
        }] : []),
        { // 4. 포효 클로즈업: 입을 벌리면 "집계 중…"
          a: ROAR, b: ROAR + 2.6, lab: { ledger: 0, orb: 0, bubble: 0 },
          fn: (u, t, o) => {
            const e = easeOut(u);
            P.set(home.x + 2.8 - e * 0.3, G + 1.5 + e * 0.1, home.z + 5.3 - e * 0.5);
            LK.set(home.x - 0.6, G + 2.12, home.z + 0.35);
            FP.copy(headWorld);
            o.fov = lerp(31, 28, e); o.range = 2.2; o.blur = 10;
          },
        },
        { // 5. 합산: 표에서 알로 흘러드는 빛
          a: ROAR + 2.6, b: S_SUM.end, lab: {},
          fn: (u, t, o) => { const e = easeInOut(u); mix3(P, [cx - 3.0, 2.0, D + 0.3], [cx + 1.3, 2.7, D - 0.2], e); LK.set(cx - 0.1, 0.8, -0.2); FP.set(0, 0.6, 0.6); o.fov = 38; o.range = 13; o.blur = 4; },
        },
        { // 6. 바위 위 기관 공룡을 올려다봄 (앞의 알은 흐리게)
          a: K, b: K + 1.9, lab: { orb: 0, bubble: 0 },
          fn: (u, t, o) => { const e = easeInOut(u); mix3(P, [orgCx - 2.0, 2.5, 4.8], [orgCx + 1.8, 2.8, 4.4], e); LK.set(orgCx, 1.9, -3.6); FP.set(orgCx, 1.7, -3.6); o.fov = 44; o.range = 3.0; o.blur = 9; },
        },
        { // 7. 열쇠 수정이 알로 날아감
          a: K + 1.9, b: S_KEY.end, lab: {},
          fn: (u, t, o) => { const e = easeInOut(u); mix3(P, [cx + 2.2, 3.6, D - 0.2], [cx - 0.2, 3.0, D + 0.3], e); LK.set(cx - 0.1, 0.75, -1.0); FP.set(0, 0.8, 0); o.fov = 38; o.range = 13; o.blur = 4; },
        },
        { // 8. 부화 → 돌기둥이 솟는 로우 앵글
          a: RS, b: RS + 2.4, lab: { bubble: 0, name: 0, count: 0 },
          fn: (u, t, o) => { const e = easeInOut(u); mix3(P, [cx - 2.2, G + 0.45, 7.4], [cx + 0.4, G + 0.9, 9.2], e); LK.set(cx - 0.3, 1.1, 0); FP.set(orbX(leadIdx), 1, 0); o.fov = 38; o.range = 6; o.blur = 7; },
        },
        { // 9. 마지막 전경: 결과 확인
          a: RS + 2.4, b: 1e9, lab: {},
          fn: (u, t, o, now) => { const e = easeOut(seg(t, RS + 2.4, RS + 4.6)); P.set(cx + 0.5 - e * 0.5 + Math.sin(now * 0.13) * 0.35, lerp(1.7, 2.15, e), D - 0.4 + e * 0.6); LK.set(cx, 0.85, 0); FP.set(0, 0.8, 0.6); o.fov = 38; o.range = 13; o.blur = 3.5; },
        },
      ];
      const shotOut = { fov: 38, range: 8, blur: 5 };

      let width = 0, height = 0, pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const resize = () => {
        width = mount.clientWidth; height = mount.clientHeight;
        renderer.setPixelRatio(pixelRatio);
        renderer.setSize(width, height, false);
        pipeline.setSize(width, height, pixelRatio);
        camera.aspect = width / Math.max(1, height);
        camera.setViewOffset(width, height, 0, Math.round(height * 0.04), width, height); // 아래 자막 띠만큼 그림을 위로
      };
      ro = new ResizeObserver(resize);
      ro.observe(mount);
      resize();

      const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), tmp3 = new THREE.Vector3();
      const mtx = new THREE.Matrix4(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
      const mid = new THREE.Vector3();

      function frame(t, now) {
        const ice = 0.05 + 0.95 * easeInOut(seg(t, 0.6, RS + 0.8));
        world.update(now, ice);
        const resT = t - RS;
        const roarT = t - ROAR;

        // 1) 호박 속 표가 내려와 자리 잡음
        const loadP = seg(t, L + 2.3, S_LOAD.end - 0.25);
        const leave = seg(t, ROAR + 3.2, S_SUM.end - 0.9);
        ballots.forEach((b, i) => {
          const delay = (i / Math.max(1, n)) * 0.55;
          const p = easeBack(seg(loadP, delay, delay + 0.45));
          const float = Math.sin(now * 1.3 + i * 0.9) * 0.05;
          b.group.position.set(b.home.x, b.home.y + (1 - p) * 7 + float, b.home.z);
          b.group.rotation.set((1 - p) * 2.2 + Math.sin(now * 0.5 + i) * 0.08, (1 - p) * 1.5 + now * 0.25 + i, 0);
          let shell = 0.86, coreO = 0.4;
          if (story.deniable) {
            // 2) 공개된 카드와 집계 칸이 갈라짐
            const sp = easeInOut(seg(t, S_SLOT.start + 0.3 + b.seed * 0.6, S_SLOT.start + 1.9 + b.seed * 0.6));
            b.card.position.set(0, 0.6 * sp, -0.12);
            b.card.rotation.set(-0.12 * sp, 0, 0);
            b.cardMat.opacity = sp * (1 - seg(t, S_SLOT.end - 1.0, S_SLOT.end)) * 0.9;
            b.core.position.set(0, 0, 0.5 * sp);
            coreO = 0.4 + 0.6 * sp;
            shell = 0.86 - 0.3 * sp;
          } else {
            b.core.position.set(0, 0, 0.34 * seg(t, ROAR - 0.8, ROAR));
            coreO = 0.4 + 0.6 * seg(t, ROAR - 0.8, ROAR);
          }
          b.mat.opacity = shell * (1 - leave);
          b.coreMat.opacity = coreO * (1 - leave);
          b.core.scale.setScalar(1 + 0.15 * Math.sin(now * 5 + i));
          b.core.rotation.set(0.2, now * 1.7 + i, 0.15);
          b.mat.emissiveIntensity = 0.25 + 0.2 * Math.max(0, Math.sin(now * 1.6 + i * 0.7));
          b.group.visible = p > 0.001 && t < S_SUM.end && (b.mat.opacity > 0.01 || b.coreMat.opacity > 0.01);
          b.card.visible = b.cardMat.opacity > 0.01;
        });

        // 3) 동형 합산: 집계 칸에서 후보별 알로 빛이 흘러듦
        const sumP = seg(t, ROAR + 2.9, S_SUM.end - 0.4);
        streamMat.opacity = sumP > 0 && sumP < 1 ? 1 : 0;
        let pi = 0;
        ballots.forEach((b, i) => {
          b.group.updateMatrixWorld();
          b.core.getWorldPosition(tmp);
          for (let k = 0; k < candN; k++) {
            const d = (i / Math.max(1, n)) * 0.5 + k * 0.04;
            const q = easeInOut(seg(sumP, d, d + 0.45));
            tmp2.set(orbX(k), EGG_Y + 0.3, 0);
            mid.set((tmp.x + tmp2.x) / 2, Math.max(tmp.y, tmp2.y) + 1.4, (tmp.z + tmp2.z) / 2 + 1.0);
            const a = (1 - q) * (1 - q), bq = 2 * (1 - q) * q, c = q * q;
            streamPos[pi++] = q >= 1 || q <= 0 ? 999 : a * tmp.x + bq * mid.x + c * tmp2.x;
            streamPos[pi++] = a * tmp.y + bq * mid.y + c * tmp2.y;
            streamPos[pi++] = a * tmp.z + bq * mid.z + c * tmp2.z;
          }
        });
        streamGeo.attributes.position.needsUpdate = true;

        const filled = seg(sumP, 0.15, 1);
        const locked = easeOut(seg(t, ROAR + 2.9, ROAR + 3.7));
        const unlock = easeInOut(seg(t, K + 3.3, S_KEY.end - 0.3));
        const hatched = resT > 0.15;
        orbs.forEach((o, k) => {
          const wob = seg(t, K + 3.0, S_KEY.end) * (1 - seg(resT, 0, 0.15));
          o.orb.visible = !hatched;
          o.orb.scale.setScalar(0.9 + 0.2 * filled + 0.03 * Math.sin(now * 3 + k) * filled);
          o.orb.position.y = EGG_Y + 0.08 * filled + Math.abs(Math.sin(now * 19 + k)) * 0.05 * wob;
          o.orb.rotation.set(0, k * 1.7, Math.sin(now * 17 + k) * 0.13 * wob);
          o.mat.emissiveIntensity = 0.5 * filled + 0.35 * unlock;
          o.halo.material.opacity = 0.32 * filled + 0.3 * unlock;
          o.rings.forEach((r, j) => {
            r.material.opacity = locked * (1 - unlock) * (0.9 - 0.25 * j);
            r.rotation.z = now * (j ? -1.1 : 0.8);
            r.scale.setScalar(1 + unlock * 0.7);
          });
          const sink = easeInOut(seg(resT, 0.4 + k * 0.18, 1.3 + k * 0.18));
          o.nest.position.y = NEST_TOP - sink * 1.6;
          o.nest.visible = sink < 1;
        });

        // 4) 집계 기관 공룡: 바위 위로 깡충 올라와 열쇠 수정을 띄움
        const keyIn = easeOut(seg(t, K + 0.5, K + 1.3));
        keys.forEach((kk, j) => {
          const d = kk.dino;
          const appear = seg(t, K + 0.15 + j * 0.3, K + 0.95 + j * 0.3);
          const cheerHop = kk.active && resT > 0.9 ? Math.abs(Math.sin((resT - 0.9) * 6 + j)) * 0.3 * Math.max(0.3, 1 - seg(resT, 0.9, 3.6)) : 0;
          const launch = kk.active ? Math.sin(seg(t, K + 1.8, K + 2.5) * Math.PI) * 0.22 : 0;
          d.root.visible = appear > 0;
          d.root.position.set(kk.base.x, kk.base.y - (1 - easeOut(appear)) * 1.6 + Math.sin(appear * Math.PI) * 0.8 + cheerHop + launch, kk.base.z - (1 - appear) * 1.1);
          d.root.scale.setScalar(Math.max(0.01, 0.55 + 0.45 * easeBack(appear)));
          const breathe = 1 + Math.sin(now * (kk.active ? 2.4 : 1.1) + j) * (kk.active ? 0.02 : 0.035);
          if (kk.active) {
            const look = seg(t, K + 1.6, K + 2.3) * (1 - seg(t, K + 3.6, S_KEY.end));
            d.body.scale.set(1 / Math.sqrt(breathe), breathe, 1 / Math.sqrt(breathe));
            d.head.rotation.set(-0.4 * look + Math.sin(now * 1.2 + j) * 0.07 + (cheerHop > 0.05 ? -0.25 : 0), Math.sin(now * 0.8 + j * 2) * 0.2 * (1 - look), Math.sin(now * 1.4 + j) * 0.06);
            const blink = ((now + j * 1.7) % 3.7) < 0.12 ? 1 : 0;
            d.eyes.forEach((e) => e.set(blink));
          } else {
            // 이번엔 쉬는 기관: 납작 엎드려 꾸벅꾸벅
            d.body.scale.set(1.07, 0.84 * breathe, 1.07);
            d.head.rotation.set(0.42 + Math.sin(now * 1.1) * 0.05, 0.25, 0.18);
            d.eyes.forEach((e) => e.set(1));
          }
          d.root.updateMatrixWorld(true);
          d.head.getWorldPosition(tmp3);
          kk.home.set(tmp3.x, tmp3.y + d.headTop + (kk.active ? 0.75 : 0.55) + 0.06 * Math.sin(now * 2 + j), tmp3.z);
          kk.mat.opacity = keyIn * (1 - seg(resT, 0, 0.4));
          kk.mesh.visible = kk.mat.opacity > 0.01;
          kk.mesh.rotation.set(0, now * 1.6 + j, 0.15);
          if (kk.active) {
            const travel = easeInOut(seg(t, K + 1.9, K + 3.1));
            const slot = activeKeys.indexOf(kk);
            tmp.set((slot - (activeKeys.length - 1) / 2) * 1.8, 2.2 + 0.08 * Math.sin(now * 2 + slot), 0.7);
            kk.mesh.position.lerpVectors(kk.home, tmp, travel);
            kk.mesh.position.y += Math.sin(travel * Math.PI) * 0.9;
            kk.mat.emissiveIntensity = 1.4 + 2.2 * travel;
          } else {
            kk.mesh.position.copy(kk.home);
          }
        });
        const beamP = seg(t, K + 3.0, K + 3.5) * (1 - seg(t, S_KEY.end - 0.5, S_KEY.end));
        beamMat.opacity = beamP * (0.6 + 0.4 * Math.sin(now * 9));
        let bi = 0;
        activeKeys.forEach((kk) => {
          for (let k = 0; k < candN; k++) {
            beamPos[bi++] = kk.mesh.position.x; beamPos[bi++] = kk.mesh.position.y; beamPos[bi++] = kk.mesh.position.z;
            beamPos[bi++] = orbX(k); beamPos[bi++] = EGG_Y + 0.5; beamPos[bi++] = 0;
          }
        });
        beamGeo.attributes.position.needsUpdate = true;

        // 5) 부화 → 돌기둥
        const hatchT = resT - 0.15;
        shards.visible = hatchT > 0 && hatchT < 2.6;
        if (shards.visible) {
          shardSeed.forEach((sd, i) => {
            const y = EGG_Y + sd.d.y * sd.s * hatchT - 5.5 * hatchT * hatchT;
            tmp.set(orbX(sd.k) + sd.d.x * sd.s * hatchT, Math.max(G + 0.06, y), sd.d.z * sd.s * hatchT);
            quat.setFromAxisAngle(sd.ax, y > G + 0.07 ? hatchT * sd.sp : sd.sp);
            scl.setScalar(sd.sc * (1 - seg(hatchT, 1.9, 2.6)));
            shards.setMatrixAt(i, mtx.compose(tmp, quat, scl));
          });
          shards.instanceMatrix.needsUpdate = true;
        }
        const burstP = seg(resT, 0.15, 1.7);
        burstMat.opacity = burstP > 0 && burstP < 1 ? 1 - burstP : 0;
        burstDir.forEach((bd, i) => {
          const r = easeOut(burstP) * bd.s * 2.0;
          burstPos[i * 3] = orbX(bd.k) + bd.d.x * r;
          burstPos[i * 3 + 1] = EGG_Y + 0.2 + bd.d.y * r - burstP * burstP * 1.2;
          burstPos[i * 3 + 2] = bd.d.z * r;
        });
        burstGeo.attributes.position.needsUpdate = true;
        let thud = 0;
        bars.forEach((b, k) => {
          const g = easeBack(seg(resT, 0.5 + k * 0.18, 1.9 + k * 0.18));
          b.bar.scale.y = Math.max(0.001, b.h * g);
          b.bar.visible = g > 0.002;
          b.cap.visible = g > 0.05;
          const top = G - 0.02 + b.bar.scale.y;
          if (b.lead) { b.cap.position.set(orbX(k), top + 0.42 + Math.sin(now * 2) * 0.05, 0); b.cap.rotation.y = now * 1.3; } else { b.cap.position.set(orbX(k), top, 0); b.cap.scale.set(0.55, 0.13, 0.55); }
          thud += Math.sin(seg(resT, 0.5 + k * 0.18, 1.5 + k * 0.18) * Math.PI);
        });

        // 먼지
        puffs.forEach((pf) => {
          const a = (t - pf.t0) / pf.life;
          pf.s.visible = a > 0 && a < 1;
          if (!pf.s.visible) return;
          pf.s.position.set(pf.x + pf.drift * a, pf.y + a * 0.7, pf.z);
          pf.s.scale.setScalar(pf.size * (0.35 + a * 0.9));
          pf.m.opacity = Math.sin(a * Math.PI) * 0.3;
        });

        // ── 아기 티라노 ──
        const runAmt = seg(t, RUN0 - 0.05, RUN0 + 0.2) * (1 - seg(t, RUN1 - 0.5, RUN1 - 0.05));
        const skid = seg(t, RUN1 - 0.55, RUN1 - 0.2) * (1 - seg(t, RUN1 - 0.1, RUN1 + 0.35));
        const settled = seg(t, RUN1, RUN1 + 0.5);
        const tx = trexX(t);
        const phase = (tx + 13) * 2.5;
        const inhale = seg(roarT, 0.0, 0.5) * (1 - seg(roarT, 0.55, 0.72));
        const roar = seg(roarT, 0.6, 0.78) * (1 - seg(roarT, 2.0, 2.4));
        const roar2 = seg(resT, 2.6, 2.8) * (1 - seg(resT, 3.6, 4.0)); // 결과 확인 뒤 승리의 포효
        const runRoar = seg(t, L + 0.9, L + 1.1) * (1 - seg(t, L + 1.9, L + 2.2));
        const roarAll = Math.max(roar, roar2 * 0.8);
        const party = resT > 1.0 ? Math.abs(Math.sin((resT - 1.0) * 6.2)) * 0.5 * Math.max(0.22, 1 - seg(resT, 1.0, 3.6)) * (1 - roar2) : 0;
        const cold = seg(t, ROAR + 3.2, K + 1) * (1 - seg(resT, 0, 0.6));
        const shiver = Math.sin(now * 41) * 0.012 * cold;
        const nod = Math.max(0, Math.sin((t - ROAR - 3) * 6.5)) * 0.14 * (t > ROAR + 3 && t < S_SUM.end ? 1 : 0);
        const bob = Math.abs(Math.sin(phase)) * 0.16 * runAmt;
        trex.root.position.set(tx + shiver + Math.sin(now * 60) * 0.012 * roarAll, G + party, home.z);
        trex.root.rotation.y = lerp(1.32, FACE, easeInOut(seg(t, RUN1 - 0.45, RUN1 + 0.35))) + Math.sin(now * 0.7) * 0.05 * settled * (1 - roarAll);
        const breathe = 1 + Math.sin(now * 2.2) * 0.02 + inhale * 0.06;
        trex.body.scale.set(1 / Math.sqrt(breathe), breathe, 1 / Math.sqrt(breathe));
        trex.body.position.y = 1.02 + bob - 0.1 * skid - 0.06 * inhale + 0.05 * roarAll;
        trex.body.rotation.set(0.3 * runAmt - 0.32 * skid - 0.2 * inhale + 0.24 * roarAll, 0, Math.sin(phase) * 0.06 * runAmt + (party > 0.05 ? Math.sin(now * 13) * 0.05 : 0));
        trex.legs.forEach((lg, i) => {
          const sw = Math.sin(phase + i * Math.PI);
          lg.hip.rotation.x = -sw * 0.85 * runAmt - 0.3 * runAmt + 0.5 * skid + 0.2 * inhale - 0.24 * roarAll + (party > 0.05 ? (i ? 0.35 : -0.35) : 0);
          lg.ankle.rotation.x = (0.25 + 0.5 * Math.max(0, Math.cos(phase + i * Math.PI))) * runAmt - 0.35 * skid;
        });
        const glance = settled * (1 - seg(resT, 0, 0.4)) * (1 - roarAll) * (1 - inhale) * Math.pow(Math.max(0, Math.sin(now * 0.8)), 4);
        const jawOpen = 0.04 + 0.95 * roar + 0.8 * roar2 + 0.5 * runRoar * (0.6 + 0.4 * Math.sin(now * 10)) + (party > 0.05 ? 0.25 : 0) + Math.sin(now * 38) * 0.03 * roarAll;
        trex.jaw.rotation.x = jawOpen;
        trex.tongue.rotation.x = Math.sin(now * 33) * 0.06 * roarAll;
        trex.head.rotation.set(
          -0.3 * runAmt + 0.3 * skid + 0.3 * inhale - 0.42 * roarAll - 0.2 * runRoar + nod + 0.07 * Math.sin(now * 1.1) * settled - 0.12 * seg(resT, 0.4, 0.8) * (1 - roar2) + Math.sin(now * 47) * 0.02 * roarAll,
          Math.sin(now * 0.8) * 0.1 * settled * (1 - roarAll) - glance * 0.75 + Math.sin(now * 3.1) * 0.12 * roar,
          Math.sin(now * 1.3) * 0.06 * settled + Math.sin(now * 43) * 0.02 * roarAll,
        );
        trex.tail.forEach((g, i) => {
          const fast = party > 0.05 || runAmt > 0.2;
          g.rotation.y = Math.sin(now * (fast ? 8 : 2.6) - i * 0.7) * (0.12 + i * 0.035) * (1 + roarAll);
          g.rotation.x = 0.1 + 0.07 * runAmt - (0.16 * roarAll + 0.1 * skid) + (i === 0 ? -0.15 : 0);
        });
        const flap = (t > K && t < S_KEY.end) || resT > 0.4 || runAmt > 0.2 ? Math.sin(now * 14) * 0.5 : Math.sin(now * 2) * 0.1;
        trex.arms.forEach((a, i) => {
          a.rotation.x = -0.1 + (i ? flap : -flap) * 0.5 - 0.7 * roarAll;
          a.rotation.z = (i ? -1 : 1) * (0.1 + Math.abs(flap) * 0.3 + 0.5 * roarAll);
        });
        const blink = (now % 3.4) < 0.12 || ((now + 0.35) % 7.1) < 0.1 ? 1 : 0;
        const happy = party > 0.05 ? 0.35 : 0;
        trex.eyes.forEach((e) => e.set(Math.max(blink, 0.75 * roarAll, 0.6 * inhale, happy)));
        trex.root.updateMatrixWorld(true);
        trex.head.getWorldPosition(headWorld);
        trex.mouth.getWorldPosition(mouthWorld);

        // 포효 충격파
        waves.forEach((w, i) => {
          const src = roar > 0 ? roarT - 0.7 : resT - 2.75;
          const a = (src - i * 0.33) / 0.95;
          w.visible = roarAll > 0.01 && a > 0 && a < 1;
          if (!w.visible) return;
          trex.head.getWorldDirection(tmp);
          w.position.copy(mouthWorld).addScaledVector(tmp, 0.3 + a * 3.2);
          w.lookAt(tmp2.copy(w.position).add(tmp));
          w.scale.setScalar(0.3 + a * 2.6);
          w.material.opacity = (1 - a) * 0.28;
        });

        // ── 상상부기 ──
        const cling = Math.max(runAmt, roarAll, skid, inhale * 0.7);
        const cheer = seg(resT, 0.9, 1.3) * (1 - roar2);
        const keyWave = t > K + 2 && t < S_KEY.end ? 1 : 0;
        boogi.root.rotation.set(-0.08 + 0.22 * cling + 0.2 * roarAll, 0, Math.sin(now * 2.1) * 0.05 + Math.sin(now * 44) * 0.045 * cold + Math.sin(now * 50) * 0.03 * roarAll);
        boogi.root.position.y = Math.abs(Math.sin(phase + 0.6)) * 0.07 * runAmt + (party > 0.05 ? Math.abs(Math.sin(now * 13)) * 0.06 : 0);
        boogi.head.rotation.set(Math.sin(now * 1.3) * 0.07 + 0.2 * roarAll, -glance * 0.9 + Math.sin(now * 0.9) * 0.14 * (1 - cling), Math.sin(now * 1.7) * 0.09);
        boogi.arms.forEach((a, i) => {
          const sd = i ? -1 : 1;
          const hold = -1.3 + Math.sin(now * 22 + i) * 0.06;
          const idle = -0.25 + Math.sin(now * 2 + i) * 0.08 - keyWave * (0.9 + Math.sin(now * 12 + i * Math.PI) * 0.5);
          const up = i ? -2.75 : -2.3;
          a.rotation.x = lerp(lerp(idle, hold, cling), up, cheer);
          a.rotation.z = sd * (0.25 + cheer * 0.25) + (i ? Math.sin(now * 10) * 0.4 * cheer : 0) - sd * 0.22 * cold;
        });
        const bBlink = ((now + 1.3) % 4.1) < 0.12 || roarAll > 0.3 ? 0.15 : 1;
        boogi.eyes.forEach((e) => { e.scale.y = 0.036 * bBlink; });

        // ── 배경 무리 ──
        herd.forEach((hd, i) => {
          const span = 110, speed = 3.0 + ice * 2.0;
          hd.g.position.set(-55 + ((now * speed + hd.ph * span) % span), world.groundAt(0, hd.z) + Math.abs(Math.sin(now * 5 + i)) * 0.25 * hd.s, hd.z);
          hd.g.rotation.z = Math.sin(now * 5 + i) * 0.03;
        });
        pteros.forEach((pt, i) => {
          const span = 150;
          pt.g.position.set(-75 + ((now * 6.5 + pt.ph * span) % span), pt.y + Math.sin(now * 0.9 + i) * 0.8, pt.z);
          const f = Math.sin(now * 5.5 + i * 2);
          pt.wings.forEach((wg) => { wg.inner.rotation.z = wg.sd * f * 0.5; wg.outer.rotation.z = wg.sd * (f * 0.6 - 0.25); });
          pt.g.rotation.z = Math.sin(now * 0.6 + i) * 0.1;
        });

        // ── 카메라 ──
        let shot = shots[0];
        for (let i = 0; i < shots.length; i++) if (t >= shots[i].a) shot = shots[i];
        shot.fn(seg(t, shot.a, Math.min(shot.b, duration)), t, shotOut, now);
        const shake = roar * 0.05 + roar2 * 0.035 + Math.min(1, thud) * 0.02 + runAmt * Math.abs(Math.sin(phase)) * 0.012;
        camera.position.set(P.x + (fbm3(now * 9, 1, 0, 2) - 0.5) * shake * 2, P.y + (fbm3(0, now * 9, 3, 2) - 0.5) * shake * 2, P.z);
        camera.lookAt(LK);
        if (camera.fov !== shotOut.fov) { camera.fov = shotOut.fov; camera.updateProjectionMatrix(); }
        camera.updateMatrixWorld();
        pipeline.setFocus(camera.position.distanceTo(FP), shotOut.range, shotOut.blur * (pixelRatio / 2));
        const fl = pipeline.film;
        fl.uTime.value = now;
        fl.uIce.value = ice;
        fl.uFade.value = reduceMotion ? 1 : seg(t, 0, 0.6);
        fl.uFlash.value = resT > 0.15 ? 0.5 * (1 - seg(resT, 0.15, 0.6)) : 0;
        if (roarAll > 0.01) {
          const mp = project(mouthWorld);
          fl.uShock.value.set(mp.x * 0.5 + 0.5, mp.y * 0.5 + 0.5, (((roar > 0 ? roarT - 0.7 : resT - 2.75) * 1.5) % 1.2) + 0.02);
        } else fl.uShock.value.z = 0;

        // ── 글자 ──
        const w = width, h = height;
        const lab = shot.lab;
        const on = (key) => (lab[key] === 0 ? 0 : 1);
        ledgerLabel.style.opacity = String(on('ledger') * seg(t, L + 2.6, L + 3.2) * (1 - seg(t, ROAR - 0.3, ROAR)));
        ledgerLabel.style.transform = `translate(-50%,0) translate(${w / 2}px, ${h * 0.1}px)`;
        sumChip.style.opacity = String(seg(t, ROAR + 2.7, ROAR + 3.1) * (1 - seg(t, S_SUM.end - 0.4, S_SUM.end)));
        sumChip.style.transform = `translate(-50%,0) translate(${w / 2}px, ${h * 0.1}px)`;
        orbs.forEach((o, k) => {
          const vis = on('orb') * seg(t, L + 2.9, L + 3.5) * (1 - seg(resT, 0, 0.3));
          place(orbLabels[k], tmp.set(orbX(k), NEST_TOP - 0.42, 1.0), vis, w, h);
          orbLabels[k].lastChild.style.opacity = String(locked);
        });
        keys.forEach((kk, j) => {
          const plate = seg(t, K + 0.7 + j * 0.3, K + 1.1 + j * 0.3) * (1 - seg(resT, 0, 0.4));
          kk.dino.head.getWorldPosition(tmp3);
          place(keyLabels[j], tmp.copy(tmp3).add(tmp2.set(0, kk.dino.headTop + 0.22, 0)), plate, w, h);
          if (zzzLabels[j]) place(zzzLabels[j], tmp.copy(tmp3).add(tmp2.set(0.6, 0.25, 0)), plate, w, h);
          if (sayLabels[j]) {
            const ts = K + 1.15 + activeKeys.indexOf(kk) * 0.45;
            place(sayLabels[j], tmp.copy(tmp3).add(tmp2.set(0.95, 0.1, 0.2)), seg(t, ts, ts + 0.15) * (1 - seg(t, K + 3.3, K + 3.7)), w, h);
          }
        });
        bars.forEach((b, k) => {
          const appear = seg(resT, 2.4 + k * 0.12, 2.75 + k * 0.12);
          place(barLabels[k], tmp.set(orbX(k), G + b.bar.scale.y + (b.lead ? 1.2 : 0.7), 0.3), appear * on('count'), w, h);
          place(barNames[k], tmp.set(orbX(k), G + 0.05, 1.25), appear * on('name'), w, h);
          const value = Math.round(story.counts[k] * easeOut(seg(resT, 2.45 + k * 0.12, 3.7 + k * 0.12)));
          if (value !== shownCounts[k]) { shownCounts[k] = value; barLabels[k].firstChild.textContent = String(value); }
        });
        const say = resT > 1.0 ? '빙하기 전에 집계 완료!' : t > K + 2 ? '열쇠 2개 확인!' : t > ROAR + 3 ? '열지 않고 더하는 중… 추워!' : (S_SLOT.start >= 0 && t > S_SLOT.start) ? '집계 칸만 쏙!' : t > L + 0.5 ? '빙하기 온다! 표부터 챙겨!' : '';
        if (say !== bubbleSay) { bubbleSay = say; bubble.textContent = say; }
        boogi.head.getWorldPosition(tmp);
        place(bubble, tmp.add(tmp2.set(-0.1, 0.72, 0)), on('bubble') * (say ? seg(t, L + 0.5, L + 0.9) : 0) * (1 - roar2), w, h);
        place(roarLabel, tmp.copy(headWorld).add(tmp2.set(t < RUN1 ? 1.1 : 0.9, -0.2, 0.3)), Math.max(runRoar, roar2), w, h);
        // 포효와 함께 입에서 튀어나오는 "집계 중…"
        {
          const p = easeBack(seg(roarT, 0.72, 1.3));
          const mp = project(mouthWorld);
          const mx = (mp.x * 0.5 + 0.5) * w, my = (-mp.y * 0.5 + 0.5) * h;
          const x = lerp(mx, w * 0.27, p), y = lerp(my, h * 0.36, p);
          const jit = roar * 3;
          bigTitle.style.transform = `translate(-50%,-50%) translate(${x + Math.sin(now * 61) * jit}px, ${y + Math.cos(now * 53) * jit}px) scale(${0.12 + 0.88 * p})`;
          bigTitle.style.opacity = String(seg(roarT, 0.7, 0.85) * (1 - seg(roarT, 2.3, 2.58)));
        }
        if (progressRef.current) progressRef.current.style.transform = `scaleX(${Math.min(1, t / duration)})`;

        pipeline.render();
      }

      let t0 = performance.now(), offset = 0, lastScene = -1, finished = false, paused = false;
      let frames = 0, slow = 0, last = performance.now();
      const tick = () => {
        const nowMs = performance.now();
        const t = reduceMotion ? duration : paused ? offset : Math.min(duration, offset + (nowMs - t0) / 1000);
        frame(t, nowMs / 1000);
        // 느린 기기에서는 해상도와 심도 효과를 낮춤
        const dt = nowMs - last;
        last = nowMs;
        if (++frames > 20 && frames < 140) { if (dt > 34) slow++; if (frames === 139 && slow > 55 && pixelRatio > 1) { pixelRatio = 1; pipeline.setDof(false); resize(); } }
        const idx = Math.max(0, scenes.findIndex((s) => t >= s.start && t < s.end));
        const si = t >= scenes[scenes.length - 1].start ? scenes.length - 1 : idx;
        if (si !== lastScene) { lastScene = si; setSceneIdx(si); }
        const isDone = t >= duration;
        if (isDone !== finished) { finished = isDone; setDone(isDone); }
        raf = requestAnimationFrame(tick);
      };
      setReady(true);
      raf = requestAnimationFrame(tick);
      ctlRef.current = {
        replay: () => { offset = 0; t0 = performance.now(); },
        jump: (i) => { offset = scenes[i].start; t0 = performance.now(); },
      };
      if (new URLSearchParams(window.location.search).has('taDebug')) {
        window.__ta = { duration, scenes, seek: (t) => { paused = true; offset = t; }, play: () => { paused = false; t0 = performance.now(); } };
      }
    }, 60);

    return () => {
      cancelled = true;
      clearTimeout(bootTimer);
      cancelAnimationFrame(raf);
      ro?.disconnect();
      ctlRef.current = null;
      if (window.__ta) delete window.__ta;
      disposables.forEach((d) => d.dispose?.());
      pipeline?.dispose();
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
        {webgl && !ready && <div className="ta-fallback ta-loading">공룡들 불러오는 중…</div>}
        <div className="ta-overlay" ref={overlayRef} />
        <div className="ta-bars" />
        <div className="ta-caption" key={sceneIdx}>
          <div className="ta-row">
            <div className="ta-step"><span>{String(sceneIdx + 1).padStart(2, '0')}</span> / {String(timeline.scenes.length).padStart(2, '0')}</div>
            <div className="ta-title">{current.title}</div>
          </div>
          <div className="ta-sub">{current.caption}</div>
        </div>
        <div className="ta-progress"><div ref={progressRef} /></div>
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

if (typeof document !== 'undefined' && !document.getElementById('ta-style-v3')) {
  const s = document.createElement('style');
  s.id = 'ta-style-v3';
  s.textContent = `
.ta-root{--ta-font:"Pretendard Variable",Pretendard,-apple-system,system-ui,"Apple SD Gothic Neo",sans-serif;--ta-blue:#0e2d72;--ta-amber:#e0801f;--ta-ink:#2a1d12;--ta-sub:#6f604f;--ta-line:#eadcc4;display:flex;flex-direction:column;border:1.5px solid #1b1410;background:#0c0a08;overflow:hidden;font-family:var(--ta-font);border-radius:14px;box-shadow:0 1px 2px rgba(60,40,20,.05),0 18px 44px rgba(40,24,8,.22)}
.ta-stage{position:relative;width:100%;aspect-ratio:16/8.4;min-height:320px;background:#0c0a08;overflow:hidden}
.ta-stage canvas{display:block;width:100%!important;height:100%!important}
.ta-bars{position:absolute;inset:0;pointer-events:none}
.ta-bars:before,.ta-bars:after{content:'';position:absolute;left:0;right:0;background:#050403}
.ta-bars:before{top:0;height:6%}
.ta-bars:after{bottom:0;height:14%}
.ta-overlay{position:absolute;inset:0;pointer-events:none;font-family:var(--ta-font);overflow:hidden}
.ta-bubble{position:absolute;left:0;top:0;white-space:nowrap;will-change:transform;padding:7px 13px;border-radius:14px;background:#fff;border:2px solid #0e2d72;color:#0e2d72;font-size:13.5px;font-weight:800;letter-spacing:-.02em;box-shadow:0 8px 22px rgba(0,0,0,.28)}
.ta-bubble:after{content:'';position:absolute;left:50%;bottom:-7px;width:12px;height:12px;background:#fff;border-right:2px solid #0e2d72;border-bottom:2px solid #0e2d72;transform:translateX(-50%) rotate(45deg)}
.ta-say{font-size:13px;padding:6px 12px;border-color:#b06a10;color:#7a4300;background:#fffaf0}
.ta-say:after{left:-6px;bottom:50%;margin-bottom:-6px;border:0;border-left:2px solid #b06a10;border-bottom:2px solid #b06a10;background:#fffaf0;transform:rotate(45deg)}
.ta-roar{position:absolute;left:0;top:0;white-space:nowrap;will-change:transform;font-size:22px;font-weight:900;letter-spacing:-.02em;color:#ff7a1a;-webkit-text-stroke:5px #fff;paint-order:stroke fill;text-shadow:0 4px 14px rgba(0,0,0,.35)}
.ta-big{position:absolute;left:0;top:0;white-space:nowrap;will-change:transform,opacity;font-size:clamp(46px,7.4vw,112px);font-weight:900;letter-spacing:-.04em;line-height:1;color:#ffe9b0;filter:drop-shadow(0 6px 0 #9c4508) drop-shadow(0 0 26px rgba(255,160,50,.8)) drop-shadow(0 12px 24px rgba(0,0,0,.5))}
.ta-big span{background:linear-gradient(180deg,#fffdf2 20%,#ffd98a 60%,#ff9d2e);-webkit-background-clip:text;background-clip:text;color:transparent}
.ta-big i,.ta-sumchip i{font-style:normal;display:inline-block;animation:taDot 1s infinite both}
.ta-big i{color:#ffd98a}
.ta-big i:nth-of-type(2),.ta-sumchip i:nth-of-type(2){animation-delay:.18s}
.ta-big i:nth-of-type(3),.ta-sumchip i:nth-of-type(3){animation-delay:.36s}
@keyframes taDot{0%,70%,100%{transform:translateY(0);opacity:.35}35%{transform:translateY(-.18em);opacity:1}}
.ta-zzz{position:absolute;left:0;top:0;white-space:nowrap;will-change:transform;font-size:17px;font-weight:900;font-style:italic;color:#8a5fe0;-webkit-text-stroke:3px #fff;paint-order:stroke fill;animation:taZzz 1.6s ease-in-out infinite}
@keyframes taZzz{0%,100%{margin-top:0}50%{margin-top:-8px}}
.ta-label,.ta-key,.ta-count,.ta-ledger,.ta-name{position:absolute;left:0;top:0;white-space:nowrap;will-change:transform}
.ta-label{display:flex;flex-direction:column;align-items:center;gap:5px}
.ta-label b{font-size:14px;font-weight:800;letter-spacing:-.02em;color:#0e2d72;background:#fff;border:2px solid #0e2d72;padding:5px 14px;border-radius:999px;box-shadow:0 6px 16px rgba(0,0,0,.3)}
.ta-label span{font:600 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#8a4a12;background:rgba(255,250,240,.94);border:1px solid #ebcf9f;padding:4px 8px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.2)}
.ta-key{font-size:12.5px;font-weight:800;letter-spacing:-.01em;color:#6a4300;background:rgba(255,248,230,.97);padding:5px 12px;border:1px solid #f0c977;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.28)}
.ta-count{display:flex;align-items:baseline;gap:5px;color:#fff;-webkit-text-stroke:7px #3a2208;paint-order:stroke fill;filter:drop-shadow(0 4px 10px rgba(0,0,0,.45))}
.ta-count b{font-size:54px;font-weight:900;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.ta-count span{font-size:19px;font-weight:900;color:#ffd27a}
.ta-name{font-size:14px;font-weight:800;color:#0e2d72;background:#fff;border:2px solid #0e2d72;padding:6px 15px;border-radius:999px;box-shadow:0 6px 16px rgba(0,0,0,.3)}
.ta-ledger{font-size:13px;font-weight:700;letter-spacing:-.01em;color:#8a4a12;background:rgba(255,250,240,.96);border:1px solid #ebcf9f;padding:6px 14px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.25)}
.ta-caption{position:absolute;left:0;right:0;bottom:4px;height:calc(14% - 4px);padding:0 30px;display:flex;flex-direction:column;justify-content:center;color:#fff;pointer-events:none;animation:taIn .5s cubic-bezier(.2,.8,.2,1)}
.ta-caption .ta-row{display:flex;align-items:baseline;gap:14px}
.ta-step{font-size:12px;font-weight:700;letter-spacing:.12em;color:rgba(255,255,255,.55);font-variant-numeric:tabular-nums}
.ta-step span{color:#ffb454;font-weight:800}
.ta-title{font-size:clamp(17px,1.9vw,26px);font-weight:800;letter-spacing:-.035em;line-height:1.2}
.ta-sub{margin-top:3px;font-size:clamp(12px,1.1vw,14.5px);font-weight:500;color:rgba(255,255,255,.78);line-height:1.4;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ta-progress{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(255,255,255,.12)}
.ta-progress div{height:100%;background:linear-gradient(90deg,#ff9a3c,#ffd27a 45%,#9fd0ff);transform-origin:left;transform:scaleX(0)}
.ta-fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.75);font-weight:700;font-size:15px;z-index:2;background:#0c0a08}
.ta-loading{animation:taPulse 1.2s ease-in-out infinite}
@keyframes taPulse{0%,100%{opacity:.55}50%{opacity:1}}
.ta-bar{display:flex;flex-wrap:wrap;gap:6px;padding:12px 14px;background:#fffaf2;border-top:1px solid var(--ta-line)}
.ta-chip{display:flex;align-items:center;gap:7px;height:34px;padding:0 13px;border:1px solid #e6d3b3;background:#fff;color:var(--ta-sub);font:600 13px/1 var(--ta-font);letter-spacing:-.01em;cursor:pointer;border-radius:999px;transition:background .2s,color .2s,border-color .2s}
.ta-chip span{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;border-radius:999px;background:#fbeedb;color:var(--ta-amber);font-size:11px;font-weight:700}
.ta-chip:hover{border-color:var(--ta-blue);color:var(--ta-blue)}
.ta-chip.past{color:var(--ta-ink)}
.ta-chip.on{background:var(--ta-blue);border-color:var(--ta-blue);color:#fff}
.ta-chip.on span{background:#fff;color:var(--ta-blue)}
.ta-replay{margin-left:auto;height:34px;padding:0 16px;border:1.5px solid var(--ta-blue);border-radius:999px;background:#fff;color:var(--ta-blue);font:700 13px/1 var(--ta-font);cursor:pointer}
.ta-replay:hover{background:var(--ta-blue);color:#fff}
@keyframes taIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.ta-caption{animation:none}}
`;
  document.head.appendChild(s);
}
