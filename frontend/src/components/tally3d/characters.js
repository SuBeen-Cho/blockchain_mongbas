import * as THREE from 'three';
import { sculpt, ell, cap, mirrorX, noise3 } from './sculpt.js';

/**
 * 등장 캐릭터: 아기 티라노(주인공) · 상상부기 · 집계 기관 공룡 3종 · 배경 공룡 · 익룡.
 * 모두 sculpt()로 조각한 매끈한 메시라서 관절만 움직여도 이음매가 보이지 않는다.
 */

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const mixTo = (rgb, to, w) => { rgb[0] += (to[0] - rgb[0]) * w; rgb[1] += (to[1] - rgb[1]) * w; rgb[2] += (to[2] - rgb[2]) * w; };

export const NAVY = 0x0e2d72; // 한성 남색

/** 피부 재질. scales=false(기본)면 말랑한 인형 같은 매끈한 표면, true면 비늘 요철 */
export function skinMaterial(track, { scales = false, bump = 0.55, scale = 20, roughness = 0.72, clearcoat = 0.06, tint = 0xffffff, sheen = 0xffffff } = {}) {
  const m = track(new THREE.MeshPhysicalMaterial({
    color: tint, vertexColors: true, roughness, clearcoat, clearcoatRoughness: 0.45,
    sheen: 0.45, sheenRoughness: 0.6, sheenColor: new THREE.Color(sheen),
  }));
  if (!scales) return m;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uBump = { value: bump };
    sh.uniforms.uCell = { value: scale };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vObjP;
uniform float uBump;
uniform float uCell;
float gScale;
vec3 skH3(vec3 p){ p = vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6))); return fract(sin(p)*43758.5453); }
float skCell(vec3 x){ vec3 p=floor(x), f=fract(x); float d=1.0;
  for(int i=-1;i<=1;i++) for(int j=-1;j<=1;j++) for(int k=-1;k<=1;k++){ vec3 g=vec3(float(i),float(j),float(k)); vec3 r=g+skH3(p+g)-f; d=min(d,dot(r,r)); }
  return sqrt(d); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
gScale = 1.0 - smoothstep(0.0, 0.8, skCell(vObjP * uCell));
diffuseColor.rgb *= mix(0.84, 1.03, gScale);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{ vec3 sgX = normalize(dFdx(-vViewPosition)), sgY = normalize(dFdy(-vViewPosition));
  vec3 r1 = cross(sgY, normal), r2 = cross(normal, sgX);
  float det = dot(sgX, r1);
  vec3 grad = sign(det) * (dFdx(gScale) * uBump * r1 + dFdy(gScale) * uBump * r2);
  normal = normalize(abs(det) * normal - grad); }`);
  };
  m.customProgramCacheKey = () => 'ta-skin';
  return m;
}

export function createCharacters(track) {
  const sphere = track(new THREE.SphereGeometry(1, 32, 24));
  const coneGeo = track(new THREE.ConeGeometry(1, 1, 10));
  const cylGeo = track(new THREE.CylinderGeometry(1, 1, 1, 10));
  const whiteM = track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const inkM = track(new THREE.MeshStandardMaterial({ color: 0x12142b, roughness: 0.25 }));
  const toothM = track(new THREE.MeshStandardMaterial({ color: 0xfff7e6, roughness: 0.3 }));
  const mesh = (geo, mat, parent, shadow = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow; m.receiveShadow = shadow;
    if (parent) parent.add(m);
    return m;
  };
  const S = (prims, opts) => track(sculpt(prims, opts));
  const ball = (mat, r, x, y, z, parent) => { const m = new THREE.Mesh(sphere, mat); m.scale.setScalar(r); m.position.set(x, y, z); parent.add(m); return m; };

  /** 눈: 까만 콩알 눈 + 작은 반짝임. set(감은 정도 0~1) */
  function makeEye(r, parent, x, y, z, yaw) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = yaw;
    parent.add(g);
    const dot = new THREE.Mesh(sphere, inkM);
    dot.scale.set(r * 0.5, r * 0.72, r * 0.2);
    g.add(dot);
    ball(whiteM, r * 0.14, r * 0.14, r * 0.3, r * 0.2, g);
    const eye = { g, set(close) { g.scale.y = Math.max(0.1, 1 - close * 0.9); } };
    return eye;
  }

  // ───────────────────────── 아기 티라노 ─────────────────────────
  function buildTrex() {
    const SKIN = 0x93cf5c, BELLY = 0xd9f0aa, MOUTH = 0xb8405a, CLAW = 0xfffbe8, RIDGE = 0x4b9a48;
    const PINK = lin(0xff8fb4);
    const mat = skinMaterial(track, { sheen: 0xe6ffc4 });
    const paint = () => undefined; // 무늬 없이 단색
    const headPaint = (p, n, c) => {
      const d = Math.hypot(Math.abs(p.x) - 0.47, (p.y - 0.08) * 1.6, p.z - 0.3);
      if (c[1] > c[0]) mixTo(c, PINK, (1 - smooth(0.07, 0.16, d)) * 0.92); // 분홍 볼
    };
    const root = new THREE.Group();
    const body = new THREE.Group();
    body.position.y = 1.02;
    root.add(body);

    // 몸통 (엉덩이 중심)
    mesh(S([
      ell([0, 0.04, 0.02], [0.5, 0.54, 0.6], SKIN),
      ell([0, 0.42, 0.26], [0.42, 0.42, 0.42], SKIN, { k: 0.2 }),
      cap([0, 0.6, 0.38], [0, 0.95, 0.6], 0.3, 0.27, SKIN, { k: 0.18 }),
      cap([0, -0.04, -0.3], [0, -0.02, -0.8], 0.4, 0.3, SKIN, { k: 0.2 }),
      ell([0.36, -0.08, 0.02], [0.2, 0.3, 0.3], SKIN, { k: 0.15 }),
      ell([-0.36, -0.08, 0.02], [0.2, 0.3, 0.3], SKIN, { k: 0.15 }),
      ell([0, 0.1, 0.36], [0.36, 0.52, 0.34], BELLY, { k: 0.12, kc: 0.16 }),
      ell([0, 0.62, 0.52], [0.22, 0.3, 0.2], BELLY, { k: 0.1, kc: 0.14 }),
      ...[[0.88, 0.28, 0.1], [0.7, 0.03, 0.12], [0.5, -0.22, 0.13], [0.36, -0.48, 0.12]].map(([y, z, r]) => ell([0, y, z], [r * 0.8, r, r], RIDGE, { k: 0.03, kc: 0.02 })),
    ], { res: 52, paint: paint(0) }), mat, body);

    // 꼬리 (마디 6개, 이음매는 같은 반지름의 구라서 굽혀도 매끈함)
    const tailR = [0.3, 0.25, 0.2, 0.155, 0.11, 0.07, 0.025];
    const tail = [];
    let parent = body;
    for (let i = 0; i < 6; i++) {
      const g = new THREE.Group();
      g.position.set(0, i ? 0 : -0.02, i ? -0.3 : -0.8);
      parent.add(g);
      mesh(S([
        cap([0, 0, 0], [0, 0, -0.3], tailR[i], tailR[i + 1], SKIN, { k: 0.05 }),
        ell([0, tailR[i] * 0.98, -0.15], [tailR[i] * 0.34, tailR[i] * 0.4, tailR[i] * 0.42], RIDGE, { k: 0.02, kc: 0.02 }),
        ell([0, -tailR[i] * 0.55, -0.15], [tailR[i] * 0.7, tailR[i] * 0.5, 0.2], BELLY, { k: 0.05, kc: 0.1 }),
      ], { res: 26, paint: paint(-0.8 - i * 0.3) }), mat, g);
      tail.push(g);
      parent = g;
    }

    // 다리: 허벅지+정강이 / 발 (발목 관절)
    const legPrims = [
      ell([0, -0.16, 0.05], [0.2, 0.34, 0.27], SKIN),
      cap([0, -0.4, 0.02], [0, -0.72, -0.07], 0.15, 0.1, SKIN, { k: 0.12 }),
    ];
    const footPrims = [
      ell([0, -0.09, 0.14], [0.17, 0.09, 0.26], SKIN),
      ...[-0.1, 0, 0.1].map((tx) => cap([tx, -0.1, 0.28], [tx * 1.5, -0.12, 0.45], 0.062, 0.05, SKIN, { k: 0.05 })),
      ...[-0.1, 0, 0.1].map((tx) => cap([tx * 1.5, -0.12, 0.45], [tx * 1.7, -0.13, 0.56], 0.04, 0.008, CLAW, { k: 0.02, kc: 0.02 })),
    ];
    const legGeo = S(legPrims, { res: 34, paint: paint(0) });
    const footGeo = S(footPrims, { res: 34, paint: paint(0) });
    const legs = [1, -1].map((sd) => {
      const hip = new THREE.Group();
      hip.position.set(sd * 0.36, -0.1, 0.0);
      body.add(hip);
      mesh(sd > 0 ? legGeo : track(mirrorX(legGeo)), mat, hip);
      const ankle = new THREE.Group();
      ankle.position.set(0, -0.74, -0.07);
      hip.add(ankle);
      mesh(sd > 0 ? footGeo : track(mirrorX(footGeo)), mat, ankle);
      return { hip, ankle };
    });

    // 짧은 팔
    const armPrims = [
      cap([0, 0, 0], [0.02, -0.17, 0.13], 0.08, 0.06, SKIN, { k: 0.05 }),
      cap([0.02, -0.17, 0.13], [0.0, -0.19, 0.3], 0.06, 0.05, SKIN, { k: 0.05 }),
      cap([-0.03, -0.19, 0.3], [-0.05, -0.24, 0.38], 0.03, 0.006, CLAW, { k: 0.02, kc: 0.02 }),
      cap([0.03, -0.19, 0.3], [0.05, -0.24, 0.38], 0.03, 0.006, CLAW, { k: 0.02, kc: 0.02 }),
    ];
    const armGeo = S(armPrims, { res: 26, paint: paint(0) });
    const arms = [1, -1].map((sd) => {
      const a = new THREE.Group();
      a.position.set(sd * 0.36, 0.42, 0.5);
      body.add(a);
      mesh(sd > 0 ? armGeo : track(mirrorX(armGeo)), mat, a);
      return a;
    });

    // 머리 (목 위 관절)
    const head = new THREE.Group();
    head.position.set(0, 0.95, 0.6);
    body.add(head);
    mesh(S([
      ell([0, 0.22, 0.0], [0.52, 0.47, 0.48], SKIN),
      ell([0, 0.09, 0.36], [0.41, 0.3, 0.36], SKIN, { k: 0.2 }),
      ell([0, 0.07, 0.54], [0.33, 0.24, 0.21], SKIN, { k: 0.14 }),
      ell([0.38, 0.02, 0.1], [0.2, 0.2, 0.24], SKIN, { k: 0.14 }),
      ell([-0.38, 0.02, 0.1], [0.2, 0.2, 0.24], SKIN, { k: 0.14 }),
      ell([0, 0.5, -0.36], [0.09, 0.11, 0.11], RIDGE, { k: 0.03, kc: 0.02 }),
      ell([0, -0.41, 0.34], [0.62, 0.32, 0.56], MOUTH, { sub: true, k: 0.05, kc: 0.03 }),
    ], { res: 58, paint: headPaint }), mat, head);
    const throat = new THREE.Mesh(sphere, track(new THREE.MeshBasicMaterial({ color: 0x7a2238 })));
    throat.scale.set(0.27, 0.17, 0.24);
    throat.position.set(0, -0.13, 0.0);
    head.add(throat);

    // 아래턱 (턱 관절)
    const jaw = new THREE.Group();
    jaw.position.set(0, -0.07, 0.0);
    head.add(jaw);
    mesh(S([
      ell([0, -0.13, 0.3], [0.36, 0.16, 0.36], SKIN),
      ell([0, -0.12, 0.47], [0.28, 0.13, 0.18], SKIN, { k: 0.1 }),
      ell([0.28, -0.05, 0.08], [0.14, 0.16, 0.18], SKIN, { k: 0.1 }),
      ell([-0.28, -0.05, 0.08], [0.14, 0.16, 0.18], SKIN, { k: 0.1 }),
      ell([0, 0.1, 0.32], [0.28, 0.15, 0.31], MOUTH, { sub: true, k: 0.04, kc: 0.03 }),
    ], { res: 48 }), mat, jaw);
    const tongue = mesh(S([
      ell([0, -0.035, 0.25], [0.18, 0.05, 0.2], 0xff8fa8),
      ell([0, -0.02, 0.4], [0.12, 0.04, 0.11], 0xffa0b6, { k: 0.08 }),
    ], { res: 30, ao: 0.15 }), track(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.45, clearcoat: 0.3 })), jaw, false);
    // 앞니 두 개 (동글동글)
    [1, -1].forEach((sd) => { const t = new THREE.Mesh(sphere, toothM); t.scale.set(0.045, 0.055, 0.035); t.position.set(sd * 0.085, -0.085, 0.63); head.add(t); });

    // 눈
    const eyes = [1, -1].map((sd) => makeEye(0.27, head, sd * 0.405, 0.34, 0.3, sd * 0.85));
    const seat = new THREE.Group(); // 상상부기가 앉는 자리
    seat.position.set(0, 0.63, 0.0);
    head.add(seat);
    const mouth = new THREE.Group(); // 포효가 나가는 지점
    mouth.position.set(0, -0.1, 0.5);
    head.add(mouth);
    return { root, body, head, jaw, tongue, legs, arms, tail, eyes, seat, mouth };
  }

  // ───────────────────────── 상상부기 ─────────────────────────
  function buildBoogi() {
    const SHELL = 0xa9c3eb;
    const root = new THREE.Group();
    const cloth = track(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.85, sheen: 1, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x6f8fe0) }));
    const faceM = track(new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.5, sheen: 0.4, sheenColor: new THREE.Color(0xffffff) }));
    const shellM = track(new THREE.MeshPhysicalMaterial({ color: SHELL, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.2 }));
    const plateM = track(new THREE.MeshPhysicalMaterial({ color: 0xc9dbf5, roughness: 0.35, clearcoat: 0.6, side: THREE.DoubleSide }));
    const edgeM = track(new THREE.MeshBasicMaterial({ color: NAVY, side: THREE.DoubleSide }));
    const cheekM = track(new THREE.MeshBasicMaterial({ color: 0x9fbdeb }));
    const boneM = track(new THREE.MeshStandardMaterial({ color: 0xf7eedb, roughness: 0.5 }));
    // 몸 (HSU 맨투맨) + 앉은 다리
    mesh(S([
      ell([0, 0.32, 0], [0.36, 0.33, 0.3], NAVY),
      ell([0, 0.12, 0.02], [0.34, 0.14, 0.28], NAVY, { k: 0.08 }),
      cap([0.15, 0.08, 0.1], [0.15, 0.06, 0.3], 0.11, 0.1, 0xffffff, { k: 0.04, kc: 0.015 }),
      cap([-0.15, 0.08, 0.1], [-0.15, 0.06, 0.3], 0.11, 0.1, 0xffffff, { k: 0.04, kc: 0.015 }),
      ell([0.15, 0.05, 0.36], [0.1, 0.1, 0.08], 0xffffff, { k: 0.04, kc: 0.015 }),
      ell([-0.15, 0.05, 0.36], [0.1, 0.1, 0.08], 0xffffff, { k: 0.04, kc: 0.015 }),
    ], { res: 44, ao: 0.3 }), cloth, root);
    const logoTex = (() => {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 160;
      const g = c.getContext('2d');
      g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 9; g.lineCap = 'round';
      g.beginPath(); g.ellipse(112, 30, 16, 11, -0.5, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.ellipse(144, 30, 16, 11, 0.5, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(124, 40); g.lineTo(112, 62); g.moveTo(132, 40); g.lineTo(144, 62); g.stroke();
      g.font = '900 78px "Pretendard Variable",Pretendard,system-ui,sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      g.fillText('HSU', 128, 146);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      return track(tex);
    })();
    const logo = new THREE.Mesh(track(new THREE.PlaneGeometry(0.3, 0.19)), track(new THREE.MeshBasicMaterial({ map: logoTex, transparent: true, depthWrite: false })));
    logo.position.set(0, 0.31, 0.303);
    root.add(logo);
    // 등껍질 + 남색 테두리 + 육각 무늬
    const SC = [0, 0.36, -0.16], SA = [0.4, 0.42, 0.25];
    const shell = mesh(sphere, shellM, root);
    shell.scale.set(...SA); shell.position.set(...SC);
    const rim = mesh(track(new THREE.TorusGeometry(1, 0.07, 10, 48)), track(new THREE.MeshPhysicalMaterial({ color: NAVY, roughness: 0.6 })), root);
    rim.scale.set(0.4, 0.42, 1); rim.position.set(0, 0.36, -0.16);
    const hexG = track(new THREE.CircleGeometry(1, 6)), hexEdge = track(new THREE.RingGeometry(0.82, 1, 6));
    const zAxis = new THREE.Vector3(0, 0, 1);
    [[0, 0, 0.1], ...[0, 1, 2, 3, 4, 5].map((k) => [Math.cos(k * Math.PI / 3 + Math.PI / 6) * 0.21, Math.sin(k * Math.PI / 3 + Math.PI / 6) * 0.22, 0.075])].forEach(([dx, dy, r]) => {
      const inside = Math.max(0, 1 - (dx / SA[0]) ** 2 - (dy / SA[1]) ** 2);
      const pz = SC[2] - SA[2] * Math.sqrt(inside);
      const nrm = new THREE.Vector3(dx / SA[0] ** 2, dy / SA[1] ** 2, (pz - SC[2]) / SA[2] ** 2).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(zAxis, nrm);
      const pl = new THREE.Mesh(hexG, plateM); pl.scale.setScalar(r); pl.quaternion.copy(q);
      pl.position.set(dx, SC[1] + dy, pz).addScaledVector(nrm, 0.006); root.add(pl);
      const ed = new THREE.Mesh(hexEdge, edgeM); ed.scale.setScalar(r * 1.05); ed.quaternion.copy(q);
      ed.position.set(dx, SC[1] + dy, pz).addScaledVector(nrm, 0.01); root.add(ed);
    });
    // 머리: 남색 후드 + 하얀 얼굴
    const head = new THREE.Group();
    head.position.set(0, 0.62, 0.02);
    root.add(head);
    mesh(S([
      ell([0, 0.33, 0], [0.43, 0.42, 0.41], NAVY),
      ell([0, 0.3, 0.3], [0.3, 0.28, 0.2], null, { sub: true, k: 0.03 }),
    ], { res: 44, ao: 0.25 }), cloth, head);
    const face = mesh(sphere, faceM, head);
    face.scale.set(0.34, 0.32, 0.2); face.position.set(0, 0.3, 0.24);
    const eyes = [1, -1].map((sd) => { const e = new THREE.Mesh(sphere, inkM); e.scale.set(0.028, 0.036, 0.02); e.position.set(sd * 0.1, 0.34, 0.43); head.add(e); return e; });
    const smileGeo = track(new THREE.TorusGeometry(0.028, 0.008, 6, 16, Math.PI));
    [1, -1].forEach((sd) => {
      const ck = new THREE.Mesh(sphere, cheekM); ck.scale.set(0.075, 0.06, 0.015); ck.position.set(sd * 0.2, 0.25, 0.4); ck.rotation.y = sd * 0.55; head.add(ck);
      const m = new THREE.Mesh(smileGeo, inkM); m.rotation.z = Math.PI; m.position.set(sd * 0.028, 0.255, 0.437); head.add(m);
    });
    const curl = new THREE.Mesh(track(new THREE.TorusGeometry(0.04, 0.01, 6, 20, Math.PI * 1.4)), track(new THREE.MeshBasicMaterial({ color: NAVY })));
    curl.position.set(0.01, 0.52, 0.385); curl.rotation.set(-0.5, 0, 0.6); head.add(curl);
    // 팔 (남색 소매 + 하얀 손), 오른손엔 뼈다귀
    const armGeo = S([
      cap([0, 0, 0], [0, -0.2, 0], 0.105, 0.095, NAVY, { k: 0.04 }),
      ell([0, -0.29, 0.005], [0.088, 0.088, 0.088], 0xffffff, { k: 0.03, kc: 0.012 }),
    ], { res: 26, ao: 0.25 });
    const arms = [1, -1].map((sd) => {
      const a = new THREE.Group();
      a.position.set(sd * 0.33, 0.5, 0.02);
      root.add(a);
      mesh(armGeo, cloth, a);
      return a;
    });
    const bone = new THREE.Group();
    bone.position.set(0, -0.3, 0.05);
    arms[1].add(bone);
    mesh(S([
      cap([0, 0, -0.17], [0, 0, 0.17], 0.03, 0.03, 0xf7eedb),
      ...[-1, 1].flatMap((e) => [-1, 1].map((sd) => ell([sd * 0.035, 0, e * 0.18], [0.045, 0.045, 0.045], 0xf7eedb, { k: 0.03 }))),
    ], { res: 30, ao: 0.2 }), boneM, bone);
    return { root, head, arms, eyes, logo };
  }

  // ───────────────────────── 집계 기관 공룡 ─────────────────────────
  const ORG = {
    tri: { skin: 0x86b9f5, back: 0x3f74d6, belly: 0xfdf3da, accent: 0x2f5fc4 },
    stego: { skin: 0xffb46e, back: 0xe2713a, belly: 0xfff1d6, accent: 0xd6482e },
    brachio: { skin: 0xc7a8fb, back: 0x8a62de, belly: 0xfdf0ea, accent: 0x7045cc },
  };
  const plateGeo = { g: null };
  function buildOrgDino(kind) {
    const C = ORG[kind];
    const BACK = lin(C.back), ACC = lin(C.accent);
    const HORN = 0xfff4dc;
    const mat = skinMaterial(track);
    const SKIN_L = lin(C.skin);
    const paint = (p, n, c) => {
      const isSkin = Math.abs(c[0] - SKIN_L[0]) + Math.abs(c[1] - SKIN_L[1]) + Math.abs(c[2] - SKIN_L[2]) < 0.25;
      if (!isSkin) return;
      const top = smooth(0.3, 1.0, n.y * 0.85 + 0.15);
      mixTo(c, BACK, top * 0.22);
      if (kind === 'brachio') mixTo(c, ACC, smooth(0.58, 0.64, noise3(p.x * 5.5 + 3, p.y * 5.5, p.z * 5.5)) * top * 0.6); // 등 점박이
    };
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const tall = kind === 'brachio';
    const low = kind === 'stego';
    const neckTop = tall ? [0, 1.78, 0.78] : low ? [0, 0.74, 0.74] : [0, 0.98, 0.7];
    const legs = [[1, 1], [-1, 1], [1, -1], [-1, -1]].flatMap(([sx, sz]) => [
      cap([sx * 0.27, 0.5, sz * 0.34], [sx * 0.29, 0.13, sz * 0.36], 0.155, 0.13, C.skin, { k: 0.12 }),
      ell([sx * 0.29, 0.075, sz * 0.36 + 0.04], [0.15, 0.08, 0.17], C.skin, { k: 0.06 }),
      ...[-0.07, 0, 0.07].map((tx) => ell([sx * 0.29 + tx, 0.05, sz * 0.36 + 0.19], [0.03, 0.035, 0.03], HORN, { k: 0.02, kc: 0.012 })),
    ]);
    const bodyPrims = [
      ell([0, 0.64, 0], [0.47, low ? 0.46 : 0.4, 0.62], C.skin),
      cap([0, 0.6, -0.48], [0, low ? 0.5 : 0.36, -1.18], 0.25, 0.05, C.skin, { k: 0.2 }),
      ...legs,
      ell([0, 0.5, 0.1], [0.38, 0.3, 0.5], C.belly, { k: 0.1, kc: 0.18 }),
    ];
    if (tall) {
      bodyPrims.push(
        cap([0, 0.8, 0.4], [0, 1.3, 0.62], 0.24, 0.17, C.skin, { k: 0.2 }),
        cap([0, 1.3, 0.62], [0, 1.74, 0.76], 0.17, 0.15, C.skin, { k: 0.12 }),
        cap([0, 0.72, 0.52], [0, 1.6, 0.86], 0.12, 0.09, C.belly, { k: 0.08, kc: 0.12 }),
      );
    } else if (low) {
      bodyPrims.push(
        cap([0, 0.7, 0.45], [0, 0.72, 0.72], 0.24, 0.2, C.skin, { k: 0.16 }),
        ...[[0.07, 0.62, -1.02, 0.3], [-0.07, 0.62, -1.02, -0.3], [0.06, 0.56, -1.14, 0.3], [-0.06, 0.56, -1.14, -0.3]].map(([x, y, z, dx]) => cap([x, y - 0.08, z], [x + dx, y + 0.2, z - 0.04], 0.035, 0.006, HORN, { k: 0.02, kc: 0.015 })),
      );
    } else {
      bodyPrims.push(cap([0, 0.75, 0.42], [0, 0.95, 0.68], 0.27, 0.25, C.skin, { k: 0.16 }));
    }
    mesh(S(bodyPrims, { res: tall ? 60 : 50, paint }), mat, body);

    // 스테고사우루스 골판 (두 줄 엇갈림)
    if (low) {
      if (!plateGeo.g) {
        plateGeo.g = S([
          ell([0, 0.13, 0], [0.03, 0.17, 0.19], 0xffffff),
          cap([0, 0.2, 0], [0, 0.33, 0], 0.035, 0.012, 0xffffff, { k: 0.12 }),
        ], { res: 30, ao: 0.15, paint: (p, n, c) => { const t = smooth(0.02, 0.32, p.y); c[0] = 0.8 + 0.2 * t; c[1] = 0.45 + 0.55 * t; c[2] = 0.4 + 0.5 * t; } });
      }
      const plateM = track(new THREE.MeshPhysicalMaterial({ color: C.accent, vertexColors: true, roughness: 0.4, clearcoat: 0.5 }));
      for (let i = 0; i < 7; i++) {
        const u = i / 6, z = 0.42 - u * 1.15;
        const arch = Math.sin(Math.min(1, Math.max(0, (0.5 - z) / 1.15)) * Math.PI);
        const p = mesh(plateGeo.g, plateM, body);
        const s = 0.55 + arch * 0.75;
        p.scale.setScalar(s);
        p.position.set((i % 2 ? 1 : -1) * 0.075, 0.9 + arch * 0.2 - (z < -0.45 ? (-0.45 - z) * 0.5 : 0), z);
        p.rotation.set((u - 0.45) * -0.9, 0, (i % 2 ? -1 : 1) * 0.2);
      }
    }

    // 머리
    const head = new THREE.Group();
    head.position.set(...neckTop);
    body.add(head);
    const hs = low ? 0.82 : 1;
    const headPrims = [
      ell([0, 0.05, 0.05], [0.33 * hs, 0.3 * hs, 0.32 * hs], C.skin),
      ell([0, -0.04, 0.3 * hs], [0.24 * hs, 0.17 * hs, 0.21 * hs], C.skin, { k: 0.12 }),
    ];
    if (kind === 'tri') {
      headPrims.push(
        ell([0, 0.26, -0.2], [0.52, 0.46, 0.085], C.accent, { k: 0.06, kc: 0.05, rot: [-0.5, 0, 0] }),
        ...[-3, -2, -1, 0, 1, 2, 3].map((i) => { const a = i * 0.38; return ell([Math.sin(a) * 0.5, 0.3 + Math.cos(a) * 0.42, -0.2 - Math.cos(a) * 0.23], [0.06, 0.06, 0.05], HORN, { k: 0.03, kc: 0.02 }); }),
        cap([0.15, 0.26, 0.12], [0.21, 0.62, 0.32], 0.062, 0.01, HORN, { k: 0.03, kc: 0.02 }),
        cap([-0.15, 0.26, 0.12], [-0.21, 0.62, 0.32], 0.062, 0.01, HORN, { k: 0.03, kc: 0.02 }),
        cap([0, 0.06, 0.44], [0, 0.25, 0.54], 0.05, 0.008, HORN, { k: 0.03, kc: 0.02 }),
        ell([0, -0.12, 0.47], [0.1, 0.085, 0.07], 0xf2d9a6, { k: 0.05, kc: 0.03 }),
      );
    } else if (tall) {
      headPrims.push(ell([0, 0.32, 0.06], [0.14, 0.13, 0.17], C.skin, { k: 0.1 }));
    }
    const PINK = lin(0xff8fb4);
    const headPaint = (p, n, c) => {
      paint(p, n, c);
      const d = Math.hypot(Math.abs(p.x) - 0.3 * hs, (p.y + 0.05) * 1.5, p.z - 0.2 * hs);
      mixTo(c, PINK, (1 - smooth(0.04, 0.1, d)) * 0.9);
    };
    mesh(S(headPrims, { res: 46, paint: headPaint }), mat, head);
    const smile = new THREE.Mesh(track(new THREE.TorusGeometry(0.075 * hs, 0.012, 8, 20, Math.PI)), inkM);
    smile.rotation.z = Math.PI;
    smile.rotation.x = -0.25;
    smile.position.set(0, -0.07 * hs, 0.495 * hs);
    head.add(smile);
    const eyes = [1, -1].map((sd) => makeEye(0.17, head, sd * 0.27 * hs, 0.12 * hs, 0.23 * hs, sd * 0.85));
    return { root, body, head, eyes, kind, headTop: (tall ? 0.48 : kind === 'tri' ? 0.72 : 0.36) };
  }

  // ───────────────────────── 배경: 목 긴 공룡 · 익룡 ─────────────────────────
  let herdGeo = null;
  function buildSauropod(tint) {
    if (!herdGeo) {
      const legs = [[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([sx, sz]) => cap([sx * 0.3, 0.9, sz * 0.5], [sx * 0.32, 0.12, sz * 0.52], 0.2, 0.17, 0x7da887, { k: 0.15 }));
      herdGeo = S([
        ell([0, 1.2, 0], [0.55, 0.52, 0.95], 0x7da887),
        cap([0, 1.2, -0.8], [0, 0.7, -2.4], 0.34, 0.04, 0x7da887, { k: 0.3 }),
        cap([0, 1.4, 0.7], [0, 2.4, 1.3], 0.3, 0.2, 0x7da887, { k: 0.3 }),
        cap([0, 2.4, 1.3], [0, 3.25, 1.55], 0.2, 0.15, 0x7da887, { k: 0.15 }),
        ell([0, 3.3, 1.75], [0.19, 0.16, 0.3], 0x7da887, { k: 0.12 }),
        ...legs,
        ell([0, 1.0, 0.1], [0.42, 0.36, 0.8], 0xd9d4b0, { k: 0.1, kc: 0.25 }),
      ], { res: 40, paint: (p, n, c) => mixTo(c, lin(0x4d7f66), smooth(0.1, 0.9, n.y) * 0.6) });
    }
    const m = mesh(herdGeo, track(new THREE.MeshStandardMaterial({ color: tint, vertexColors: true, roughness: 0.75 })), null);
    const g = new THREE.Group();
    g.add(m);
    return g;
  }

  function buildPtero() {
    const g = new THREE.Group();
    const matB = track(new THREE.MeshStandardMaterial({ color: 0x8c6f5c, roughness: 0.8, vertexColors: true }));
    mesh(S([
      ell([0, 0, 0], [0.16, 0.14, 0.42], 0xffffff),
      cap([0, 0.05, 0.35], [0, 0.12, 0.62], 0.09, 0.07, 0xffffff, { k: 0.1 }),
      cap([0, 0.12, 0.62], [0, 0.06, 1.05], 0.06, 0.012, 0xffe7b8, { k: 0.05, kc: 0.05 }),
      cap([0, 0.16, 0.6], [0, 0.34, 0.3], 0.045, 0.012, 0xff9a6b, { k: 0.05, kc: 0.05 }),
    ], { res: 30, ao: 0.2 }), matB, g, false);
    const wingM = track(new THREE.MeshStandardMaterial({ color: 0x9c7a62, roughness: 0.85, side: THREE.DoubleSide }));
    const tri = (pts) => { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3)); geo.computeVertexNormals(); return track(geo); };
    const wings = [1, -1].map((sd) => {
      const inner = new THREE.Group();
      inner.position.set(sd * 0.1, 0.04, 0.1);
      g.add(inner);
      inner.add(new THREE.Mesh(tri([0, 0, 0.22, sd * 0.9, 0, 0.2, 0, 0, -0.34, sd * 0.9, 0, 0.2, sd * 0.85, 0, -0.18, 0, 0, -0.34]), wingM));
      const outer = new THREE.Group();
      outer.position.set(sd * 0.9, 0, 0);
      inner.add(outer);
      outer.add(new THREE.Mesh(tri([0, 0, 0.2, sd * 1.15, 0, -0.05, -sd * 0.05, 0, -0.18]), wingM));
      return { inner, outer, sd };
    });
    return { g, wings };
  }

  return { buildTrex, buildBoogi, buildOrgDino, buildSauropod, buildPtero, sphere, coneGeo, cylGeo, whiteM, inkM };
}
