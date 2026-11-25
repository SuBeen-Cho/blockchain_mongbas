// 배경의 파란 와이어프레임: 스크롤을 따라 화면 가장자리로 움직인다 (원래 구성)
import * as THREE from '../vendor/three.module.min.js';
const cv = document.getElementById('three');
const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
try {
  const r = new THREE.WebGLRenderer({ canvas: cv, alpha: true, antialias: true });
  r.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  const sc = new THREE.Scene(), cam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 100);
  cam.position.z = 7;
  const grp = new THREE.Group();
  sc.add(grp);
  grp.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.8, 1), new THREE.MeshBasicMaterial({ color: 0x2440f2, wireframe: true, transparent: true, opacity: 0.15 })));
  grp.add(new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.36, 12, 40), new THREE.MeshBasicMaterial({ color: 0x2440f2, wireframe: true, transparent: true, opacity: 0.08 })));
  let t = 0, s = 0;
  addEventListener('scroll', () => { t = scrollY / (document.body.scrollHeight - innerHeight || 1); }, { passive: true });
  const rs = () => { r.setSize(innerWidth, innerHeight); cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); };
  addEventListener('resize', rs);
  rs();
  const draw = () => {
    s += (t - s) * 0.06;
    grp.rotation.y += 0.003; grp.rotation.x += 0.0014;
    grp.position.x = 3.6 - s * 7.4; grp.position.y = 2.2 - s * 4.8; grp.scale.setScalar(0.75 + s * 1.3);
    r.render(sc, cam);
  };
  if (reduce) draw(); else (function l() { requestAnimationFrame(l); if (!document.hidden) draw(); })();
} catch (e) { /* WebGL이 없으면 배경 장식만 빠진다 */ }
