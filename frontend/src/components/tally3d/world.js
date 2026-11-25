import * as THREE from 'three';
import { fbm3, noise3, rng } from './sculpt.js';

/**
 * 원시 시대 배경. 하늘 · 지형 · 먼 산 · 화산 · 야자수 · 바위 · 빙하 · 날씨 · 조명.
 * update(now, ice)에서 ice(0→1)가 커질수록 따뜻한 낮이 빙하기로 바뀐다.
 */

const GLSL_NOISE = `
float wH(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(wH(i), wH(i+vec2(1,0)), f.x), mix(wH(i+vec2(0,1)), wH(i+vec2(1,1)), f.x), f.y); }
float wF(vec2 p){ float a = 0.5, s = 0.0; for(int i=0;i<5;i++){ s += a*wN(p); p = p*2.03 + 7.1; a *= 0.5; } return s; }
`;

function softTexture(track, stops, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, col]) => grd.addColorStop(o, col));
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return track(tex);
}

function smokeTexture(track) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const r = rng(5);
  for (let i = 0; i < 26; i++) {
    const x = 128 + (r() - 0.5) * 120, y = 128 + (r() - 0.5) * 120, rad = 30 + r() * 46;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, 'rgba(255,255,255,0.22)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return track(tex);
}

function frondTexture(track) {
  const W = 512, H = 192;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const N = 34;
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    const x = 14 + u * (W - 60);
    const len = (H / 2 - 6) * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.62)), 0.75) + 6;
    const lean = 26 + u * 22;
    [-1, 1].forEach((sd) => {
      const grd = g.createLinearGradient(x, H / 2, x + lean, H / 2 + sd * len);
      grd.addColorStop(0, '#2f7f3c');
      grd.addColorStop(0.55, '#57b45a');
      grd.addColorStop(1, '#9fd86f');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(x - 5, H / 2);
      g.quadraticCurveTo(x + lean * 0.3, H / 2 + sd * len * 0.6, x + lean, H / 2 + sd * len);
      g.quadraticCurveTo(x + lean * 0.75, H / 2 + sd * len * 0.45, x + 9, H / 2);
      g.closePath();
      g.fill();
    });
  }
  g.strokeStyle = '#3d6b2c';
  g.lineWidth = 5;
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(4, H / 2); g.lineTo(W - 30, H / 2); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return track(tex);
}

/** 아래로 휘어지는 잎 한 장 (길이 방향 +z) */
function frondGeometry(track, L, W) {
  const geo = new THREE.PlaneGeometry(L, W, 12, 2);
  const p = geo.attributes.position;
  const R = L / 1.25;
  for (let i = 0; i < p.count; i++) {
    const u = (p.getX(i) + L / 2) / L, v = p.getY(i) / (W / 2);
    const a = u * 1.25;
    p.setXYZ(i, v * W / 2, R * (Math.cos(a) - 1) - Math.abs(v) * W * 0.22 * (0.4 + u), R * Math.sin(a));
  }
  geo.computeVertexNormals();
  return track(geo);
}

export function createWorld({ scene, track, ground }) {
  const R = rng(20261125);
  const sunDir = new THREE.Vector3(0.45, 0.7, -0.55).normalize();
  const HOR_WARM = new THREE.Color().setRGB(0.95, 0.66, 0.42), HOR_ICE = new THREE.Color().setRGB(0.52, 0.62, 0.78);
  const horizon = new THREE.Color().copy(HOR_WARM);

  // ── 하늘 ──
  const skyU = { uIce: { value: 0 }, uTime: { value: 0 }, uSun: { value: sunDir } };
  const sky = new THREE.Mesh(
    track(new THREE.SphereGeometry(300, 40, 24)),
    track(new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyU,
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying vec3 vDir; uniform float uIce; uniform float uTime; uniform vec3 uSun;
${GLSL_NOISE}
void main(){
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 zen = mix(vec3(0.10, 0.30, 0.72), vec3(0.16, 0.24, 0.42), uIce);
  vec3 hor = mix(vec3(0.95, 0.66, 0.42), vec3(0.52, 0.62, 0.78), uIce);
  vec3 col = mix(zen, hor, pow(1.0 - h, 3.2));
  float sd = max(dot(d, uSun), 0.0);
  float sunK = 1.0 - uIce * 0.8;
  col += sunK * (vec3(1.0, 0.86, 0.6) * pow(sd, 420.0) * 6.0 + vec3(1.0, 0.62, 0.3) * pow(sd, 14.0) * 0.55 + vec3(1.0, 0.7, 0.42) * pow(sd, 3.0) * 0.16);
  vec2 uv = d.xz / (d.y + 0.22) * 1.1 + vec2(uTime * 0.012, uTime * 0.004);
  float cover = mix(0.6, 0.4, uIce);
  float cl = smoothstep(cover, cover + 0.28, wF(uv * 1.3)) * smoothstep(0.015, 0.22, d.y);
  vec3 cloud = mix(vec3(1.0, 0.86, 0.7), vec3(0.42, 0.5, 0.64), uIce) * (0.85 + 0.6 * pow(sd, 5.0) * sunK);
  col = mix(col, cloud, cl * 0.8);
  col = mix(col, hor, smoothstep(0.0, -0.08, d.y));
  gl_FragColor = vec4(col, 1.0);
}`,
    })),
  );
  sky.frustumCulled = false;
  scene.add(sky);
  scene.fog = new THREE.Fog(horizon.getHex(), 30, 230);

  // ── 조명: 뒤에서 비추는 해(그림자) + 정면 보조광 ──
  const hemi = new THREE.HemisphereLight(0xfff0dc, 0xd9b98a, 0.55);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe2b8, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 5;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  Object.assign(sun.shadow.camera, { left: -17, right: 17, top: 14, bottom: -14, near: 1, far: 90 });
  sun.target.position.set(0, ground, -1);
  sun.position.copy(sun.target.position).addScaledVector(sunDir, 45);
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0xfff3e4, 1.25);
  fill.position.set(-4, 6, 10);
  scene.add(fill);
  const SUN_WARM = new THREE.Color(0xffe2b8), SUN_ICE = new THREE.Color(0xdfeaff);
  const FILL_WARM = new THREE.Color(0xfff3e4), FILL_ICE = new THREE.Color(0xcfe0ff);
  const HEMI_WARM = new THREE.Color(0xfff0dc), HEMI_ICE = new THREE.Color(0xd8e6ff);
  const GND_WARM = new THREE.Color(0xd9b98a), GND_ICE = new THREE.Color(0xdfe8f5);

  // ── 지형: 가운데는 평평한 무대, 멀어질수록 언덕 ──
  const height = (x, z) => {
    const d = Math.hypot(x * 0.9, z + 3);
    const m = Math.min(1, Math.max(0, (d - 17) / 30));
    const mm = m * m * (3 - 2 * m);
    return mm * (fbm3(x * 0.035 + 3, 0, z * 0.035, 4) * 15 - 2.5) + mm * mm * fbm3(x * 0.11, 2, z * 0.11, 3) * 2.5;
  };
  const terrainGeo = track(new THREE.PlaneGeometry(260, 260, 170, 170));
  terrainGeo.rotateX(-Math.PI / 2);
  {
    const p = terrainGeo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, Math.max(-1.2, height(p.getX(i), p.getZ(i))));
    terrainGeo.computeVertexNormals();
  }
  const terrU = { uIce: { value: 0 }, uFront: { value: -40 } };
  const terrainMat = track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 }));
  terrainMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, terrU);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWP; uniform float uIce; uniform float uFront;\n${GLSL_NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{ float n1 = wF(vWP.xz * 0.22), n2 = wN(vWP.xz * 3.1), n3 = wN(vWP.xz * 17.0);
  vec3 sand = mix(vec3(0.60, 0.40, 0.21), vec3(0.83, 0.62, 0.36), n1) * (0.9 + 0.14 * n2) * (0.95 + 0.08 * n3);
  float away = smoothstep(11.0, 26.0, length(vWP.xz + vec2(0.0, 3.0)));
  float gr = smoothstep(0.42, 0.62, wF(vWP.xz * 0.09 + 4.0)) * away;
  vec3 grass = mix(vec3(0.20, 0.36, 0.12), vec3(0.36, 0.5, 0.18), n2);
  vec3 base = mix(sand, grass, gr * 0.85);
  base = mix(base, vec3(0.36, 0.3, 0.27), smoothstep(${(ground + 5).toFixed(1)}, ${(ground + 12).toFixed(1)}, vWP.y) * 0.8);
  float front = uFront + (wF(vWP.xz * 0.16) - 0.5) * 9.0 + (n2 - 0.5) * 1.2;
  float snow = smoothstep(front + 2.5, front - 3.0, vWP.x);
  snow = max(snow, uIce * uIce * smoothstep(0.35, 0.75, wF(vWP.xz * 0.5 + 9.0)) * 0.75);
  snow = max(snow, smoothstep(${(ground + 9).toFixed(1)}, ${(ground + 13).toFixed(1)}, vWP.y + n1 * 3.0));
  diffuseColor.rgb = mix(base, vec3(0.74, 0.81, 0.92) * (0.94 + 0.08 * n3), snow); }`);
  };
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.position.y = ground - 0.01;
  terrain.receiveShadow = true;
  scene.add(terrain);
  const groundAt = (x, z) => ground - 0.01 + Math.max(-1.2, height(x, z));

  // ── 바위 (집계 기관이 올라서는 바위도 여기서 만듦) ──
  const rockMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
  const makeRock = (seed, sx, sy, sz, detail = 2) => {
    const geo = new THREE.IcosahedronGeometry(1, detail);
    const p = geo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const cA = new THREE.Color(0x8a7a68), cB = new THREE.Color(0xb7a58d), cM = new THREE.Color(0x6f9a52), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const n = fbm3(x * 1.3 + seed, y * 1.3, z * 1.3, 3);
      const k = 0.72 + n * 0.55;
      let yy = y * k;
      if (yy > 0.62) yy = 0.62 + (yy - 0.62) * 0.12; // 윗면은 평평하게
      p.setXYZ(i, x * k * sx, yy * sy, z * k * sz);
      c.copy(cA).lerp(cB, noise3(x * 2 + seed, y * 5, z * 2));
      if (y > 0.5) c.lerp(cM, 0.55 * noise3(x * 3 + seed, 1, z * 3));
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(track(geo), rockMat);
    m.castShadow = true; m.receiveShadow = true;
    m.userData.top = 0.64 * sy;
    return m;
  };
  [[-6.4, -2.2, 0.55], [6.6, -1.4, 0.4], [9.6, -7.8, 0.9], [-9.4, -6.6, 0.8], [3.0, -10.5, 0.7], [-2.2, -12, 1.1], [12.5, -2.5, 0.7], [-12, 1.5, 0.6], [7.8, 4.6, 0.35], [-7.2, 5.4, 0.45]].forEach(([x, z, r], i) => {
    const m = makeRock(i * 3.7, r * (1.1 + R() * 0.5), r * (0.8 + R() * 0.5), r * (1 + R() * 0.3), 1);
    m.position.set(x, groundAt(x, z) + r * 0.18, z);
    m.rotation.y = R() * 6;
    scene.add(m);
  });

  // ── 먼 산 ──
  const mtnMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  for (let i = 0; i < 16; i++) {
    const a = -Math.PI * 0.98 + (i / 15) * Math.PI * 0.96 + (R() - 0.5) * 0.08;
    const dist = 80 + R() * 28;
    const hgt = 16 + R() * 20, rad = 16 + R() * 12;
    const geo = new THREE.ConeGeometry(rad, hgt, 14, 8);
    const p = geo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const rock = new THREE.Color(0x4a3f4c), rock2 = new THREE.Color(0x6b5650), snow = new THREE.Color(0xe6eefc), c = new THREE.Color();
    for (let v = 0; v < p.count; v++) {
      const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
      const n = fbm3(x * 0.12 + i, y * 0.12, z * 0.12, 3) - 0.5;
      const kk = y > hgt / 2 - 0.01 ? 0 : 1;
      p.setXYZ(v, x + n * 10 * kk, y + n * 5 * kk, z + n * 10 * kk);
      const u = (y + hgt / 2) / hgt;
      c.copy(rock).lerp(rock2, noise3(x * 0.2, y * 0.3, z * 0.2));
      if (u + n * 0.35 > 0.62) c.lerp(snow, 0.9);
      colors[v * 3] = c.r; colors[v * 3 + 1] = c.g; colors[v * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(track(geo), mtnMat);
    m.position.set(Math.cos(a) * dist, ground + hgt / 2 - 2, Math.sin(a) * dist * 0.85 - 10);
    scene.add(m);
  }

  // ── 화산 ──
  const VOL = new THREE.Vector3(19, ground, -30), VH = 13;
  const volR = (u) => 1.5 + 11.5 * Math.pow(1 - u, 1.9); // u: 0 바닥 → 1 분화구
  {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 44, 22, true);
    const p = geo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const c0 = new THREE.Color(0x5a4034), c1 = new THREE.Color(0x8d5c44), c2 = new THREE.Color(0x3a2a26), c = new THREE.Color();
    for (let v = 0; v < p.count; v++) {
      const u = p.getY(v) + 0.5, ang = Math.atan2(p.getZ(v), p.getX(v));
      const n = fbm3(Math.cos(ang) * 2.2 + 5, u * 3, Math.sin(ang) * 2.2, 4) - 0.5;
      const r = volR(u) * (1 + n * 0.3 * (1 - u * 0.5));
      p.setXYZ(v, Math.cos(ang) * r, u * VH + n * 1.2 * (1 - u), Math.sin(ang) * r);
      c.copy(c0).lerp(c1, noise3(Math.cos(ang) * 3, u * 6, Math.sin(ang) * 3)).lerp(c2, u * u * 0.8);
      colors[v * 3] = c.r; colors[v * 3 + 1] = c.g; colors[v * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(track(geo), track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true })));
    m.position.copy(VOL);
    scene.add(m);
  }
  const lavaMat = track(new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(3.0, 0.7, 0.12) }));
  const lavaTop = new THREE.Mesh(track(new THREE.CircleGeometry(1.7, 24)), lavaMat);
  lavaTop.rotation.x = -Math.PI / 2;
  lavaTop.position.set(VOL.x, VOL.y + VH - 0.5, VOL.z);
  scene.add(lavaTop);
  [2.2, 3.4, 4.5].forEach((a0, i) => {
    const pts = [];
    for (let s = 0; s <= 10; s++) {
      const u = 1 - (s / 10) * (0.45 + i * 0.12);
      const ang = a0 + Math.sin(s * 0.9 + i) * 0.16;
      const r = volR(u) * 1.04;
      pts.push(new THREE.Vector3(Math.cos(ang) * r, u * VH + 0.05, -Math.sin(ang) * r));
    }
    const tube = new THREE.Mesh(track(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, 0.12 - i * 0.02, 6)), lavaMat);
    tube.position.copy(VOL);
    scene.add(tube);
  });
  const glowTex = softTexture(track, [[0, 'rgba(255,220,160,1)'], [0.3, 'rgba(255,140,60,0.55)'], [1, 'rgba(255,90,20,0)']]);
  const craterGlow = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color().setRGB(2.2, 1.1, 0.5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
  craterGlow.scale.setScalar(11);
  craterGlow.position.set(VOL.x, VOL.y + VH + 0.8, VOL.z);
  scene.add(craterGlow);
  const smokeTex = smokeTexture(track);
  const smoke = Array.from({ length: 18 }, (_, i) => {
    const m = track(new THREE.SpriteMaterial({ map: smokeTex, color: 0x8d8078, transparent: true, opacity: 0, depthWrite: false, rotation: R() * 6 }));
    const s = new THREE.Sprite(m);
    scene.add(s);
    return { s, m, ph: i / 18, w: R() };
  });
  const EMB = 70;
  const embGeo = track(new THREE.BufferGeometry());
  const embPos = new Float32Array(EMB * 3), embSeed = Array.from({ length: EMB }, () => [R(), R(), R(), R()]);
  embGeo.setAttribute('position', new THREE.BufferAttribute(embPos, 3));
  const embers = new THREE.Points(embGeo, track(new THREE.PointsMaterial({ size: 0.5, map: glowTex, color: new THREE.Color().setRGB(3, 1.2, 0.3), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
  embers.frustumCulled = false;
  scene.add(embers);

  // ── 야자수 · 양치식물 ──
  const frondTex = frondTexture(track);
  const LEAF = new THREE.Color(0xffffff), LEAF_FROST = new THREE.Color(0xc4e2ea);
  const leafMat = track(new THREE.MeshStandardMaterial({ map: frondTex, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.6 }));
  const frondBig = frondGeometry(track, 3.0, 1.05), frondSmall = frondGeometry(track, 1.25, 0.5);
  const barkMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
  const nutMat = track(new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.6 }));
  const nutGeo = track(new THREE.SphereGeometry(0.17, 12, 10));
  const crowns = [];
  const palm = (x, z, h, lean, s) => {
    const g = new THREE.Group();
    g.position.set(x, groundAt(x, z), z);
    g.scale.setScalar(s);
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, -0.2, 0), new THREE.Vector3(lean * 0.25, h * 0.4, 0.1), new THREE.Vector3(lean * 0.75, h * 0.78, 0.05), new THREE.Vector3(lean * 1.25, h, 0)]);
    const TS = 30, RS = 8;
    const geo = new THREE.TubeGeometry(curve, TS, 1, RS);
    const p = geo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const c = new THREE.Color(), cA = new THREE.Color(0x8a6844), cB = new THREE.Color(0x5e452c), pt = new THREE.Vector3();
    for (let i = 0; i <= TS; i++) {
      const u = i / TS;
      curve.getPointAt(u, pt);
      const ring = 1 + 0.16 * (1 - ((u * 15) % 1));
      const r = (0.3 - u * 0.14) * ring;
      for (let j = 0; j <= RS; j++) {
        const v = i * (RS + 1) + j;
        p.setXYZ(v, pt.x + (p.getX(v) - pt.x) * r, pt.y + (p.getY(v) - pt.y) * r, pt.z + (p.getZ(v) - pt.z) * r);
        c.copy(cA).lerp(cB, ((u * 15) % 1) * 0.8);
        colors[v * 3] = c.r; colors[v * 3 + 1] = c.g; colors[v * 3 + 2] = c.b;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const trunk = new THREE.Mesh(track(geo), barkMat);
    trunk.castShadow = true;
    g.add(trunk);
    const crown = new THREE.Group();
    crown.position.set(lean * 1.25, h, 0);
    g.add(crown);
    const N = 11;
    for (let k = 0; k < N; k++) {
      const holder = new THREE.Group();
      holder.rotation.y = (k / N) * Math.PI * 2 + R() * 0.4;
      crown.add(holder);
      const f = new THREE.Mesh(frondBig, leafMat);
      f.rotation.x = -0.75 + (k % 3) * 0.32 + R() * 0.2;
      f.scale.setScalar(0.85 + R() * 0.3);
      f.castShadow = true;
      holder.add(f);
    }
    [0, 1, 2].forEach((k) => { const n = new THREE.Mesh(nutGeo, nutMat); n.position.set(Math.cos(k * 2.1) * 0.24, -0.2, Math.sin(k * 2.1) * 0.24); crown.add(n); });
    scene.add(g);
    crowns.push({ crown, ph: R() * 6 });
  };
  palm(-9.5, -9.5, 6.4, 1.0, 1);
  palm(-5.6, -15, 5.6, -0.8, 0.95);
  palm(8.6, -10, 6.0, -1.0, 1);
  palm(11.4, -5.5, 4.8, 1.1, 0.9);
  palm(-13.5, -3, 5.4, -0.6, 0.9);
  palm(14, -13, 6.6, 0.7, 1.05);
  palm(-12, 6.5, 6.8, 0.9, 1.1);
  palm(13, 7, 6.2, -1.0, 1.1);
  const ferns = [];
  const fern = (x, z, s) => {
    const g = new THREE.Group();
    g.position.set(x, groundAt(x, z), z);
    g.scale.setScalar(s);
    for (let k = 0; k < 9; k++) {
      const holder = new THREE.Group();
      holder.rotation.y = (k / 9) * Math.PI * 2 + R();
      g.add(holder);
      const f = new THREE.Mesh(frondSmall, leafMat);
      f.rotation.x = -1.0 + R() * 0.45;
      f.castShadow = true;
      holder.add(f);
    }
    scene.add(g);
    ferns.push({ g, ph: R() * 6 });
  };
  [[-7.2, -3.2, 1.2], [7.4, -2.6, 1.1], [-3.8, -8.5, 1.0], [5.6, -12, 1.4], [-10.5, -1, 1.3], [10.2, -9.5, 1.2], [9.2, 3.4, 1.0], [-8.8, 4.2, 1.1], [1.0, -13.5, 1.2], [-13, -9, 1.5], [6.2, 5.6, 0.9], [-5.4, 6.4, 1.0]].forEach((f) => fern(...f));

  // ── 빙하: 왼쪽에서 밀려오는 얼음 벽 ──
  const iceMats = [0xdff1ff, 0xb9dcf7, 0x9ccdf2].map((col, i) => track(new THREE.MeshPhysicalMaterial({
    color: col, roughness: 0.14, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, flatShading: true,
    emissive: 0x6db6ff, emissiveIntensity: 0.12 + i * 0.07, envMapIntensity: 1.6,
  })));
  const glacier = new THREE.Group();
  scene.add(glacier);
  const shardGeo = [track(new THREE.ConeGeometry(1, 1, 5, 1)), track(new THREE.ConeGeometry(1, 1, 6, 1)), track(new THREE.IcosahedronGeometry(1, 0)), track(new THREE.OctahedronGeometry(1, 0))];
  for (let i = 0; i < 70; i++) {
    const depth = R(); // 0 앞줄 → 1 뒷줄
    const gi = Math.floor(R() * 4);
    const m = new THREE.Mesh(shardGeo[gi], iceMats[Math.floor(R() * 3)]);
    const hgt = 1.2 + depth * depth * 12 + R() * 2.2;
    const wid = 0.9 + depth * 2.6 + R() * 1.2;
    const x = -8.5 - depth * 16 - R() * 2, z = 6 - R() * 26;
    if (gi < 2) { m.scale.set(wid, hgt, wid * (0.7 + R() * 0.5)); m.position.set(x, ground + hgt / 2 - 0.2, z); m.rotation.set((R() - 0.5) * 0.35, R() * 6, (R() - 0.5) * 0.5 - 0.12); } else { const s = wid * 0.9; m.scale.set(s * 1.2, s * (0.7 + R() * 0.6), s); m.position.set(x, ground + s * 0.35, z); m.rotation.set(R() * 3, R() * 3, R() * 3); }
    m.castShadow = true;
    glacier.add(m);
  }
  const mistTex = softTexture(track, [[0, 'rgba(255,255,255,0.75)'], [0.5, 'rgba(240,247,255,0.3)'], [1, 'rgba(235,245,255,0)']]);
  const mist = Array.from({ length: 14 }, () => {
    const s = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: mistTex, color: 0xf2f8ff, transparent: true, opacity: 0, depthWrite: false })));
    const sc = 5 + R() * 5;
    s.scale.set(sc * 1.6, sc * 0.7, 1);
    s.userData = { x: -7.5 - R() * 3, z: 6 - R() * 24, ph: R() * 6, y: ground + 0.5 + R() * 0.9 };
    glacier.add(s);
    return s;
  });

  // ── 날씨: 따뜻할 땐 금빛 먼지, 추워지면 눈보라 ──
  const SNOW = 1100;
  const snowGeo = track(new THREE.BufferGeometry());
  const snowSeed = new Float32Array(SNOW * 4), snowPos = new Float32Array(SNOW * 3);
  for (let i = 0; i < SNOW; i++) { snowSeed[i * 4] = R() * 44 - 22; snowSeed[i * 4 + 1] = R() * 13; snowSeed[i * 4 + 2] = R() * 30 - 18; snowSeed[i * 4 + 3] = 0.6 + R() * 1.0; }
  snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
  const snowTex = softTexture(track, [[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(244,249,255,0.75)'], [1, 'rgba(230,240,255,0)']], 64);
  const snowMat = track(new THREE.PointsMaterial({ size: 0.16, map: snowTex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
  const snow = new THREE.Points(snowGeo, snowMat);
  snow.frustumCulled = false;
  scene.add(snow);
  const MOTE = 160;
  const moteGeo = track(new THREE.BufferGeometry());
  const moteSeed = new Float32Array(MOTE * 4), motePos = new Float32Array(MOTE * 3);
  for (let i = 0; i < MOTE; i++) { moteSeed[i * 4] = R() * 30 - 15; moteSeed[i * 4 + 1] = R() * 6; moteSeed[i * 4 + 2] = R() * 18 - 8; moteSeed[i * 4 + 3] = R() * 6; }
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  const moteMat = track(new THREE.PointsMaterial({ size: 0.1, map: glowTex, color: new THREE.Color().setRGB(1.6, 1.2, 0.6), transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false;
  scene.add(motes);

  const SMOKE_HOT = new THREE.Color(0xc47a4a), SMOKE_COLD = new THREE.Color(0x8f8780);
  function update(now, ice) {
    skyU.uIce.value = ice;
    skyU.uTime.value = now;
    horizon.copy(HOR_WARM).lerp(HOR_ICE, ice);
    scene.fog.color.copy(horizon);
    scene.fog.near = 30 - ice * 6;
    scene.fog.far = 230 - ice * 90;
    sun.color.copy(SUN_WARM).lerp(SUN_ICE, ice);
    sun.intensity = 3.3 - ice * 1.5;
    fill.color.copy(FILL_WARM).lerp(FILL_ICE, ice);
    fill.intensity = 1.15 + ice * 0.1;
    hemi.color.copy(HEMI_WARM).lerp(HEMI_ICE, ice);
    hemi.groundColor.copy(GND_WARM).lerp(GND_ICE, ice);
    hemi.intensity = 0.5 + ice * 0.08;
    terrU.uIce.value = ice;
    terrU.uFront.value = -24 + ice * 21;
    leafMat.color.copy(LEAF).lerp(LEAF_FROST, ice * 0.75);
    glacier.position.x = -15 * (1 - ice);
    mist.forEach((s) => {
      const d = s.userData;
      s.position.set(d.x + Math.sin(now * 0.25 + d.ph) * 1.6 + ice * 2.5, d.y + Math.sin(now * 0.4 + d.ph) * 0.2, d.z);
      s.material.opacity = (0.08 + 0.2 * ice) * (0.7 + 0.3 * Math.sin(now * 0.5 + d.ph));
    });
    const wind = 1 + ice * 2.2;
    crowns.forEach((c) => { c.crown.rotation.z = Math.sin(now * (0.9 + ice) + c.ph) * 0.04 * wind + ice * 0.06; c.crown.rotation.x = Math.cos(now * 0.7 + c.ph) * 0.03 * wind; });
    ferns.forEach((f) => { f.g.rotation.z = Math.sin(now * (1.3 + ice) + f.ph) * 0.03 * wind; });
    // 화산
    const pulse = 0.85 + 0.15 * Math.sin(now * 2.3) + 0.08 * Math.sin(now * 7.1);
    lavaMat.color.setRGB(3.0 * pulse, 0.7 * pulse, 0.12);
    craterGlow.material.opacity = 0.75 * pulse;
    smoke.forEach((sm) => {
      const u = (now * 0.045 + sm.ph) % 1;
      sm.s.position.set(VOL.x + u * u * 16 + Math.sin(u * 9 + sm.w * 6) * 0.9, VOL.y + VH + 0.6 + u * 17, VOL.z - u * 3);
      sm.s.scale.setScalar(4.5 + u * 15);
      sm.m.opacity = Math.sin(Math.min(1, u * 1.15) * Math.PI) * 0.6;
      sm.m.color.copy(SMOKE_HOT).lerp(SMOKE_COLD, Math.min(1, u * 4));
      sm.m.rotation += 0.0015;
    });
    for (let i = 0; i < EMB; i++) {
      const s = embSeed[i], u = (now * (0.1 + s[3] * 0.12) + s[0]) % 1;
      embPos[i * 3] = VOL.x + (s[1] - 0.5) * 3 + Math.sin(u * 7 + s[2] * 6) * 1.4 + u * 4;
      embPos[i * 3 + 1] = VOL.y + VH + u * 12 - u * u * 3;
      embPos[i * 3 + 2] = VOL.z + (s[2] - 0.5) * 3;
    }
    embGeo.attributes.position.needsUpdate = true;
    // 눈
    snowMat.opacity = Math.min(1, ice * 1.6) * 0.95;
    const shown = Math.floor(SNOW * Math.min(1, 0.05 + ice * 1.1));
    const slant = 1.5 + ice * 4.5;
    for (let i = 0; i < SNOW; i++) {
      if (i >= shown) { snowPos[i * 3 + 1] = 999; continue; }
      const sp = snowSeed[i * 4 + 3], fall = (snowSeed[i * 4 + 1] + now * sp * (1.2 + ice)) % 13;
      snowPos[i * 3] = ((snowSeed[i * 4] + 22 + now * slant * sp * 0.6 + Math.sin(now * 0.8 + i) * 0.4) % 44) - 22;
      snowPos[i * 3 + 1] = ground + 12.5 - fall;
      snowPos[i * 3 + 2] = snowSeed[i * 4 + 2];
    }
    snowGeo.attributes.position.needsUpdate = true;
    moteMat.opacity = 0.8 * (1 - Math.min(1, ice * 1.5));
    motes.visible = moteMat.opacity > 0.01;
    if (motes.visible) {
      for (let i = 0; i < MOTE; i++) {
        const ph = moteSeed[i * 4 + 3];
        motePos[i * 3] = moteSeed[i * 4] + Math.sin(now * 0.3 + ph) * 0.8;
        motePos[i * 3 + 1] = ground + 0.3 + ((moteSeed[i * 4 + 1] + now * 0.12) % 6) + Math.sin(now * 0.7 + ph) * 0.2;
        motePos[i * 3 + 2] = moteSeed[i * 4 + 2] + Math.cos(now * 0.25 + ph) * 0.8;
      }
      moteGeo.attributes.position.needsUpdate = true;
    }
  }

  return { update, makeRock, groundAt, sunDir, horizon, sun, glowTex, mistTex, smokeTex };
}
