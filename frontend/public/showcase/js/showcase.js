/* Mongbas 소개 페이지: 등장 효과, 큰 글자 흐름, 메뉴, 폰 화면 전환, 히어로 씬 불러오기 */
(function () {
  'use strict';
  var doc = document;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s) { return doc.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(doc.querySelectorAll(s)); };
  var hasGsap = !!(window.gsap && window.ScrollTrigger);

  // 히어로: UnicornStudio 씬 (원래 쓰던 것). 못 불러오면 같은 장면의 정지 그림이 그대로 보인다.
  (function () {
    if (window.UnicornStudio) return;
    window.UnicornStudio = { isInitialized: false };
    var s = doc.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/gh/hiunicornstudio/unicornstudio.js@v2.2.1/dist/unicornStudio.umd.js';
    s.onload = function () { try { window.UnicornStudio.init(); } catch (e) { /* 정지 그림 유지 */ } };
    (doc.head || doc.body).appendChild(s);
  })();

  // 메뉴: 히어로를 지나면 흰 바탕으로
  var nav = $('#nav'), hero = $('#top');
  var links = $$('.nav-links a');
  var secs = links.map(function (a) { return $(a.getAttribute('href')); });
  var onScroll = function () {
    var y = window.scrollY;
    if (nav) nav.classList.toggle('solid', y > (hero ? hero.offsetHeight - 80 : 80));
    var mid = y + window.innerHeight * 0.45, cur = 0;
    secs.forEach(function (s, i) { if (s && s.getBoundingClientRect().top + y <= mid) cur = i; });
    links.forEach(function (a, i) { a.classList.toggle('on', i === cur); });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  $$('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var t = $(a.getAttribute('href'));
      if (!t) return;
      e.preventDefault();
      window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - (a.getAttribute('href') === '#top' ? 0 : 60), behavior: reduce ? 'auto' : 'smooth' });
    });
  });

  if (!hasGsap || reduce) {
    doc.documentElement.classList.remove('js');
    window.__siteReady = true;
    return;
  }
  gsap.registerPlugin(ScrollTrigger);

  // 등장: 아래에서 올라오며 나타남 (원래 방식)
  $$('.reveal').forEach(function (el) {
    gsap.to(el, { opacity: 1, y: 0, duration: 0.9, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 88%' } });
  });
  // 큰 영문 워드: 스크롤에 따라 옆으로 흐름
  $$('.wm[data-drift]').forEach(function (el) {
    var d = parseFloat(el.dataset.drift);
    gsap.fromTo(el, { xPercent: -d }, { xPercent: d, ease: 'none', scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: 0.6 } });
  });
  // 3D 오브제: 스크롤에 따라 위아래로 떠다님
  $$('.obj[data-float]').forEach(function (el) {
    var d = parseFloat(el.dataset.float);
    gsap.fromTo(el, { y: -d, rotate: d > 0 ? -6 : 6 }, { y: d, rotate: d > 0 ? 6 : -6, ease: 'none', scrollTrigger: { trigger: el.parentNode, start: 'top bottom', end: 'bottom top', scrub: 0.8 } });
  });
  // 계단 블록: 아래에서 차례로 솟음
  $$('.steps').forEach(function (s) {
    gsap.from(s.querySelectorAll('.blk'), { scaleY: 0, transformOrigin: 'bottom center', duration: 0.8, stagger: 0.12, ease: 'power3.out', scrollTrigger: { trigger: s, start: 'top 78%' } });
  });
  // 표: 줄이 차례로
  $$('.tbl').forEach(function (t) {
    gsap.from(t.querySelectorAll('.tr'), { opacity: 0, y: 18, duration: 0.5, stagger: 0.07, ease: 'power2.out', scrollTrigger: { trigger: t, start: 'top 82%' } });
  });
  // 체커보드: 칸이 차례로
  var grid = $('.pgrid');
  if (grid) gsap.from(grid.children, { opacity: 0, y: 26, duration: 0.55, stagger: 0.06, ease: 'power2.out', scrollTrigger: { trigger: grid, start: 'top 80%' } });

  // 폰 화면: 투표 → 완료 반복 (원래 방식)
  if ($('#s1') && $('#s2')) {
    gsap.set('#s1', { opacity: 1 });
    gsap.timeline({ repeat: -1, defaults: { ease: 'power2.inOut' } }).to({}, { duration: 1.8 })
      .to('#s1', { opacity: 0, duration: 0.5 }).to('#s2', { opacity: 1, duration: 0.5 }, '<')
      .to('#s2 .code', { scale: 1.06, duration: 0.4, yoyo: true, repeat: 1 })
      .to({}, { duration: 1.6 }).to('#s2', { opacity: 0, duration: 0.5 }).to('#s1', { opacity: 1, duration: 0.5 }, '<');
  }
  window.__siteReady = true;
  window.addEventListener('load', function () { ScrollTrigger.refresh(); });
})();
