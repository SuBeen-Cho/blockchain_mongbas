import { useState, useEffect } from 'react';

/**
 * KioskPage — 부스 시연용 폰 투표 전용 화면 (Phase 4에서 본 구현)
 * 진입: /?app=kiosk&e=<electionID>  (QR로 접속)
 */
export default function KioskPage({ electionId }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif', background: '#f8fafc' }}>
      <div style={{ textAlign: 'center', padding: 24 }}>
        <h1 style={{ fontSize: 28 }}>📱 키오스크 투표</h1>
        <p>선거 ID: <strong>{electionId || '(미지정)'}</strong></p>
        <p style={{ color: '#94a3b8', marginTop: 12 }}>Phase 4에서 구현됩니다.</p>
      </div>
    </div>
  );
}
