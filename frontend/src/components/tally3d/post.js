import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/**
 * 영화 느낌 후처리: 장면 → 피사계 심도 → 블룸 → 필름(색보정·비네트·그레인) → 출력.
 * 장면은 깊이 텍스처가 달린 HDR 타깃에 한 번만 그린다.
 */
const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

const DofShader = {
  uniforms: {
    tDiffuse: { value: null }, tColor: { value: null }, tDepth: { value: null },
    uNear: { value: 0.3 }, uFar: { value: 400 }, uFocus: { value: 10 }, uRange: { value: 6 }, uMaxBlur: { value: 9 },
    uTexel: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: VERT,
  fragmentShader: `varying vec2 vUv; uniform sampler2D tColor; uniform sampler2D tDepth;
uniform float uNear, uFar, uFocus, uRange, uMaxBlur; uniform vec2 uTexel;
float lin(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
float blurOf(float depth){ float c = clamp((abs(depth - uFocus) - uRange * 0.18) / uRange, 0.0, 1.0); return c * c * (3.0 - 2.0 * c) * uMaxBlur; }
void main(){
  vec3 color = texture2D(tColor, vUv).rgb;
  if (uMaxBlur < 0.5) { gl_FragColor = vec4(color, 1.0); return; }
  float centerDepth = lin(texture2D(tDepth, vUv).x);
  float centerSize = blurOf(centerDepth);
  float tot = 1.0, radius = 1.0;
  for (float ang = 0.0; ang < 200.0; ang += 2.39996323) {
    if (radius > uMaxBlur) break;
    vec2 tc = vUv + vec2(cos(ang), sin(ang)) * uTexel * radius;
    vec3 sc = texture2D(tColor, tc).rgb;
    float sd = lin(texture2D(tDepth, tc).x);
    float ss = blurOf(sd);
    if (sd > centerDepth) ss = clamp(ss, 0.0, centerSize * 2.0);
    float m = smoothstep(radius - 0.5, radius + 0.5, ss);
    color += mix(color / tot, sc, m);
    tot += 1.0;
    radius += 1.5 / radius;
  }
  gl_FragColor = vec4(color / tot, 1.0);
}`,
};

const FilmShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uIce: { value: 0 }, uFade: { value: 1 }, uFlash: { value: 0 },
    uAspect: { value: 1.9 }, uShock: { value: new THREE.Vector3(0.5, 0.5, 0) },
  },
  vertexShader: VERT,
  fragmentShader: `varying vec2 vUv; uniform sampler2D tDiffuse; uniform float uTime, uIce, uFade, uFlash, uAspect; uniform vec3 uShock;
float h21(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 uv = vUv;
  // 포효 충격파: 입에서 퍼져 나가는 굴절 고리
  vec2 sv = (uv - uShock.xy) * vec2(uAspect, 1.0);
  float sdist = length(sv);
  float ring = uShock.z > 0.0 ? exp(-pow((sdist - uShock.z) * 9.0, 2.0)) * (1.0 - smoothstep(0.5, 1.4, uShock.z)) : 0.0;
  uv += normalize(sv + 1e-5) * ring * 0.018 / vec2(uAspect, 1.0);
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  // 가장자리 색수차
  float ca = 0.0035 * r2 + ring * 0.004;
  vec3 col = vec3(texture2D(tDiffuse, uv + c * ca).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - c * ca).b);
  // 색보정: 따뜻한 하이라이트 + 청록 그림자 → 추워질수록 차갑게
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 warm = mix(vec3(0.94, 1.0, 1.08), vec3(1.07, 1.0, 0.9), smoothstep(0.05, 0.8, l));
  vec3 cold = mix(vec3(0.9, 0.98, 1.12), vec3(0.98, 1.0, 1.05), smoothstep(0.05, 0.8, l));
  col *= mix(warm, cold, uIce);
  col = mix(vec3(l), col, 1.2 - uIce * 0.12);
  col = (col - 0.18) * 1.16 + 0.18;
  col = max(col, 0.0);
  col *= 1.0 - smoothstep(0.18, 0.95, r2 * 1.9) * 0.55;
  col *= 1.0 + (h21(vUv * 913.0 + fract(uTime) * 71.0) - 0.5) * 0.07;
  col += uFlash * vec3(1.0, 0.95, 0.85);
  gl_FragColor = vec4(col * uFade, 1.0);
}`,
};

export function createPipeline(renderer, scene, camera) {
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4, depthTexture: new THREE.DepthTexture(4, 4) });
  const composer = new EffectComposer(renderer);
  const dof = new ShaderPass(DofShader);
  dof.uniforms.tColor.value = rt.texture;
  dof.uniforms.tDepth.value = rt.depthTexture;
  composer.addPass(dof);
  const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.3, 0.6, 1.2);
  composer.addPass(bloom);
  const film = new ShaderPass(FilmShader);
  composer.addPass(film);
  composer.addPass(new OutputPass());
  let dofOn = true;
  return {
    film: film.uniforms,
    setSize(w, h, pr) {
      const pw = Math.max(2, Math.floor(w * pr)), ph = Math.max(2, Math.floor(h * pr));
      rt.setSize(pw, ph);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      dof.uniforms.uTexel.value.set(1 / pw, 1 / ph);
      film.uniforms.uAspect.value = w / Math.max(1, h);
    },
    setFocus(focus, range, maxBlur) {
      dof.uniforms.uFocus.value = focus;
      dof.uniforms.uRange.value = range;
      dof.uniforms.uMaxBlur.value = dofOn ? maxBlur : 0;
    },
    setDof(on) { dofOn = on; },
    render() {
      dof.uniforms.uNear.value = camera.near;
      dof.uniforms.uFar.value = camera.far;
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      composer.render();
    },
    dispose() { rt.depthTexture.dispose(); rt.dispose(); composer.dispose(); },
  };
}
