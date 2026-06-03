import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import KioskPage from './pages/KioskPage.jsx';
import ControlPage from './pages/ControlPage.jsx';
import './index.css';

// [부스 시연] URL 쿼리 기반 라우팅 (react-router 미사용 — 경량)
//   /?app=kiosk&e=<electionID>  → 폰 투표 전용
//   /?app=control               → 발표자 관제판
//   그 외                        → 기존 탭 UI(투표/검증/관리자, 전체 파이프라인)
const params  = new URLSearchParams(window.location.search);
const appMode = params.get('app');

let rootEl;
if (appMode === 'kiosk') {
  rootEl = <KioskPage electionId={params.get('e')} />;
} else if (appMode === 'control') {
  rootEl = <ControlPage />;
} else {
  rootEl = <App />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {rootEl}
  </React.StrictMode>,
);
