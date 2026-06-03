import { useState, useEffect } from 'react';

/**
 * ControlPage — 부스 시연용 발표자 관제판 (Phase 3에서 본 구현)
 * 진입: /?app=control
 */
export default function ControlPage() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif', background: '#0f172a', color: '#e2e8f0' }}>
      <div style={{ textAlign: 'center', padding: 24 }}>
        <h1 style={{ fontSize: 28 }}>🎛️ 발표자 관제판</h1>
        <p style={{ color: '#94a3b8', marginTop: 12 }}>Phase 3에서 구현됩니다.</p>
      </div>
    </div>
  );
}
