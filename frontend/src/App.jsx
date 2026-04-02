import { useState } from 'react';
import VoterPage  from './pages/VoterPage.jsx';
import AdminPage  from './pages/AdminPage.jsx';
import VerifyPage from './pages/VerifyPage.jsx';

const TABS = [
  { id: 'voter',  label: '투표하기' },
  { id: 'verify', label: 'E2E 검증' },
  { id: 'admin',  label: '관리자' },
];

export default function App() {
  const [tab, setTab] = useState('voter');

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 헤더 */}
      <header className="bg-blue-700 text-white shadow">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
          <span className="text-2xl">🗳️</span>
          <div>
            <h1 className="text-lg font-bold leading-tight">팀 몽바스 — BFT 익명 전자투표</h1>
            <p className="text-xs text-blue-200">Hyperledger Fabric 2.5 · 2-of-3 다중 기관 합의</p>
          </div>
        </div>
        {/* 탭 */}
        <div className="max-w-3xl mx-auto px-4 flex gap-1 pb-0">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-5 py-2 text-sm rounded-t font-medium transition-colors ${
                tab === t.id
                  ? 'bg-white text-blue-700'
                  : 'text-blue-100 hover:bg-blue-600'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {/* 콘텐츠 */}
      <main className="max-w-3xl mx-auto px-4 py-6">
        {tab === 'voter'  && <VoterPage />}
        {tab === 'verify' && <VerifyPage />}
        {tab === 'admin'  && <AdminPage />}
      </main>
    </div>
  );
}
