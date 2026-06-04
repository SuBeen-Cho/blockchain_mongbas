import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import KioskPage from './pages/KioskPage.jsx';
import ControlPage from './pages/ControlPage.jsx';
import TrackPage from './pages/TrackPage.jsx';
import './index.css';

// [부스 시연] URL 쿼리 기반 라우팅 (react-router 미사용 — 경량)
//   /                           → 발표자 관제판 대시보드 (데모 기본 진입)
//   /?app=kiosk&e=<electionID>  → 폰 투표 전용
//   /?app=control               → 발표자 관제판 (기본과 동일)
//   /?app=track&e=<electionID>  → 내 표 추적/검증
//   /?app=full                  → 기존 탭 UI(투표/검증/관리자, 전체 파이프라인 심화)
const params  = new URLSearchParams(window.location.search);
const appMode = params.get('app');

let rootEl;
if (appMode === 'kiosk') {
  rootEl = <KioskPage electionId={params.get('e')} />;
} else if (appMode === 'track') {
  rootEl = <TrackPage electionId={params.get('e')} />;
} else if (appMode === 'full') {
  rootEl = <App />;
} else {
  // 기본(바 URL) 및 ?app=control → 발표자 관제판 대시보드
  rootEl = <ControlPage />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {rootEl}
  </React.StrictMode>,
);
