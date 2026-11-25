// 스크립트가 켜진 경우에만 등장 효과를 쓴다. 본문 스크립트가 못 뜨면 3초 뒤 그냥 보여 준다.
document.documentElement.classList.add('js');
setTimeout(function () { if (!window.__siteReady) document.documentElement.classList.remove('js'); }, 3000);
