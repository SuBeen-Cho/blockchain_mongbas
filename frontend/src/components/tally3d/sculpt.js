import * as THREE from 'three';
import { edgeTable, triTable } from 'three/examples/jsm/objects/MarchingCubes.js';

/**
 * 작은 조각 도구. 타원체·캡슐을 부드럽게 이어 붙인 거리장(SDF)을 만들고
 * 마칭 큐브로 매끈한 메시를 뽑는다. 색은 정점마다 섞여 들어가서
 * 배·등·무늬 경계가 자연스럽게 번진다.
 */

// ── 노이즈 ──
export function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
const sm = (t) => t * t * (3 - 2 * t);
export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = sm(x - xi), yf = sm(y - yi), zf = sm(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), xf), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), xf), yf),
    l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), xf), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), xf), yf),
    zf,
  );
}
export function fbm3(x, y, z, oct = 4) {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * noise3(x, y, z); n += a; x *= 2.03; y *= 2.03; z *= 2.03; a *= 0.5; }
  return s / n;
}
export function rng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

// ── 기본 도형 ──
const toLinear = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

/** 타원체. opts: { rot:[x,y,z] 오일러, k 이음매 부드러움, kc 색 번짐 폭, sub 깎아내기 } */
export function ell(c, r, color, opts = {}) {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(opts.rot || [0, 0, 0]))).invert().elements;
  return {
    t: 0, c, r, m, color: color == null ? null : toLinear(color),
    k: opts.k ?? 0.1, kc: opts.kc ?? opts.k ?? 0.1, sub: !!opts.sub,
    bx: c[0], by: c[1], bz: c[2], br: Math.max(r[0], r[1], r[2]), rmin: Math.min(r[0], r[1], r[2]),
  };
}
/** 둥근 원뿔(양 끝 반지름이 다른 캡슐) */
export function cap(a, b, ra, rb, color, opts = {}) {
  const ba = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(ba[0], ba[1], ba[2]);
  return {
    t: 1, a, ba, baba: Math.max(1e-9, len * len), ra, rb, color: color == null ? null : toLinear(color),
    k: opts.k ?? 0.1, kc: opts.kc ?? opts.k ?? 0.1, sub: !!opts.sub,
    bx: a[0] + ba[0] / 2, by: a[1] + ba[1] / 2, bz: a[2] + ba[2] / 2, br: len / 2 + Math.max(ra, rb),
  };
}

const col = [0, 0, 0];
function field(prims, x, y, z, wantColor) {
  let d = 1e9;
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    const k = p.k;
    const ex = x - p.bx, ey = y - p.by, ez = z - p.bz;
    const bd = Math.sqrt(ex * ex + ey * ey + ez * ez) - p.br;
    if (p.sub ? bd > k - d : bd > d + Math.max(k, p.kc)) continue;
    let d2;
    if (p.t === 0) {
      const m = p.m;
      const lx = (m[0] * ex + m[4] * ey + m[8] * ez) / p.r[0];
      const ly = (m[1] * ex + m[5] * ey + m[9] * ez) / p.r[1];
      const lz = (m[2] * ex + m[6] * ey + m[10] * ez) / p.r[2];
      const k0 = Math.sqrt(lx * lx + ly * ly + lz * lz);
      if (k0 < 1e-6) d2 = -p.rmin;
      else {
        const gx = lx / p.r[0], gy = ly / p.r[1], gz = lz / p.r[2];
        d2 = k0 * (k0 - 1) / Math.sqrt(gx * gx + gy * gy + gz * gz);
      }
    } else {
      const ax = x - p.a[0], ay = y - p.a[1], az = z - p.a[2];
      let h = (ax * p.ba[0] + ay * p.ba[1] + az * p.ba[2]) / p.baba;
      h = h < 0 ? 0 : h > 1 ? 1 : h;
      const qx = ax - p.ba[0] * h, qy = ay - p.ba[1] * h, qz = az - p.ba[2] * h;
      d2 = Math.sqrt(qx * qx + qy * qy + qz * qz) - (p.ra + (p.rb - p.ra) * h);
    }
    if (p.sub) {
      const h = Math.max(k - Math.abs(-d2 - d), 0) / k;
      if (wantColor && p.color) {
        let w = 0.5 + 0.5 * (-d2 - d) / p.kc; w = w < 0 ? 0 : w > 1 ? 1 : w;
        col[0] += (p.color[0] - col[0]) * w; col[1] += (p.color[1] - col[1]) * w; col[2] += (p.color[2] - col[2]) * w;
      }
      d = Math.max(d, -d2) + h * h * k * 0.25;
    } else {
      if (wantColor && p.color) {
        let w = d > 1e8 ? 1 : 0.5 + 0.5 * (d - d2) / p.kc; w = w < 0 ? 0 : w > 1 ? 1 : w;
        col[0] += (p.color[0] - col[0]) * w; col[1] += (p.color[1] - col[1]) * w; col[2] += (p.color[2] - col[2]) * w;
      }
      const h = Math.max(k - Math.abs(d - d2), 0) / k;
      d = Math.min(d, d2) - h * h * k * 0.25;
    }
  }
  return d;
}

// 큐브 모서리 12개: [아래쪽 꼭짓점 dx,dy,dz, 축]
const EDGES = [[0, 0, 0, 0], [1, 0, 0, 1], [0, 1, 0, 0], [0, 0, 0, 1], [0, 0, 1, 0], [1, 0, 1, 1], [0, 1, 1, 0], [0, 0, 1, 1], [0, 0, 0, 2], [1, 0, 0, 2], [1, 1, 0, 2], [0, 1, 0, 2]];
const CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];

/**
 * @param prims  ell()/cap() 목록 (앞에서부터 차례로 이어 붙임)
 * @param opts   res 격자 해상도, paint(p, n, rgb) 정점 색 손질, ao 틈새 그늘 세기
 */
export function sculpt(prims, opts = {}) {
  const res = opts.res ?? 44;
  const pad = opts.pad ?? 0.05;
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  prims.forEach((p) => {
    if (p.sub) return;
    const b = [p.bx, p.by, p.bz];
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b[a] - p.br - pad); hi[a] = Math.max(hi[a], b[a] + p.br + pad); }
  });
  const cell = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / res;
  const nx = Math.ceil((hi[0] - lo[0]) / cell) + 1, ny = Math.ceil((hi[1] - lo[1]) / cell) + 1, nz = Math.ceil((hi[2] - lo[2]) / cell) + 1;
  const f = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const row = (j + k * ny) * nx;
    for (let i = 0; i < nx; i++) {
      const d = field(prims, lo[0] + i * cell, lo[1] + j * cell, lo[2] + k * cell, false);
      f[row + i] = d;
      // 표면에서 먼 칸은 부호만 필요하므로 건너뜀
      let skip = Math.floor((Math.abs(d) * 0.6 - cell) / cell);
      while (skip-- > 0 && i < nx - 1) f[row + ++i] = d;
    }
  }
  const cache = new Int32Array(nx * ny * nz * 3).fill(-1);
  const pos = [], idx = [];
  const sx = 1, sy = nx, sz = nx * ny;
  const stride = [sx, sy, sz];
  const vert = new Int32Array(12);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const q = i + j * sy + k * sz;
    let ci = 0;
    for (let c = 0; c < 8; c++) if (f[q + CORNERS[c][0] + CORNERS[c][1] * sy + CORNERS[c][2] * sz] < 0) ci |= 1 << c;
    const bits = edgeTable[ci];
    if (!bits) continue;
    for (let e = 0; e < 12; e++) {
      if (!(bits & (1 << e))) continue;
      const E = EDGES[e];
      const qa = q + E[0] + E[1] * sy + E[2] * sz;
      const key = qa * 3 + E[3];
      let v = cache[key];
      if (v < 0) {
        const fa = f[qa], fb = f[qa + stride[E[3]]];
        const t = fa / (fa - fb);
        const p = [lo[0] + (i + E[0]) * cell, lo[1] + (j + E[1]) * cell, lo[2] + (k + E[2]) * cell];
        p[E[3]] += t * cell;
        v = pos.length / 3;
        pos.push(p[0], p[1], p[2]);
        cache[key] = v;
      }
      vert[e] = v;
    }
    for (let t = ci * 16; triTable[t] !== -1; t += 3) idx.push(vert[triTable[t]], vert[triTable[t + 1]], vert[triTable[t + 2]]);
  }
  const nv = pos.length / 3;
  const nrm = new Float32Array(nv * 3), color = new Float32Array(nv * 3);
  const eps = cell * 0.5, aoR = opts.aoR ?? cell * 4, aoK = opts.ao ?? 0.4;
  const pv = new THREE.Vector3(), nvv = new THREE.Vector3(), rgb = [0, 0, 0];
  for (let v = 0; v < nv; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let gx = field(prims, x + eps, y, z) - field(prims, x - eps, y, z);
    let gy = field(prims, x, y + eps, z) - field(prims, x, y - eps, z);
    let gz = field(prims, x, y, z + eps) - field(prims, x, y, z - eps);
    const gl = Math.hypot(gx, gy, gz) || 1;
    gx /= gl; gy /= gl; gz /= gl;
    nrm[v * 3] = gx; nrm[v * 3 + 1] = gy; nrm[v * 3 + 2] = gz;
    col[0] = col[1] = col[2] = 1;
    field(prims, x, y, z, true);
    rgb[0] = col[0]; rgb[1] = col[1]; rgb[2] = col[2];
    if (opts.paint) opts.paint(pv.set(x, y, z), nvv.set(gx, gy, gz), rgb);
    let ao = field(prims, x + gx * aoR, y + gy * aoR, z + gz * aoR) / aoR;
    ao = ao < 0 ? 0 : ao > 1 ? 1 : ao;
    const sh = 1 - aoK + aoK * ao;
    color[v * 3] = rgb[0] * sh; color[v * 3 + 1] = rgb[1] * sh; color[v * 3 + 2] = rgb[2] * sh;
  }
  // 삼각형 방향을 바깥(거리장이 커지는 쪽)으로 맞춤
  if (idx.length >= 3) {
    const a = idx[0] * 3, b = idx[1] * 3, c = idx[2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    if (fx * nrm[a] + fy * nrm[a + 1] + fz * nrm[a + 2] < 0) {
      for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geo.setIndex(nv > 65535 ? new THREE.BufferAttribute(new Uint32Array(idx), 1) : new THREE.BufferAttribute(new Uint16Array(idx), 1));
  geo.computeBoundingSphere();
  return geo;
}

/** 좌우 대칭 복사본 (x 뒤집기) */
export function mirrorX(geo) {
  const g = geo.clone();
  const p = g.attributes.position, n = g.attributes.normal, ix = g.index;
  for (let i = 0; i < p.count; i++) { p.setX(i, -p.getX(i)); n.setX(i, -n.getX(i)); }
  for (let t = 0; t < ix.count; t += 3) { const a = ix.getX(t + 1); ix.setX(t + 1, ix.getX(t + 2)); ix.setX(t + 2, a); }
  g.computeBoundingSphere();
  return g;
}

/** 프림 목록을 x 뒤집어 복사 (좌우 한 쌍을 한 번에 조각할 때) */
export function flipPrims(prims) {
  return prims.map((p) => {
    if (p.t === 0) {
      const o = { ...p, c: [-p.c[0], p.c[1], p.c[2]], bx: -p.bx };
      const m = p.m.slice();
      // 회전도 거울상으로: x 성분이 섞인 항의 부호 반전
      m[1] = -m[1]; m[2] = -m[2]; m[4] = -m[4]; m[8] = -m[8];
      o.m = m;
      return o;
    }
    return { ...p, a: [-p.a[0], p.a[1], p.a[2]], ba: [-p.ba[0], p.ba[1], p.ba[2]], bx: -p.bx };
  });
}
