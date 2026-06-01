import { useState, useEffect } from 'react';
import VoterPage  from './pages/VoterPage.jsx';
import AdminPage  from './pages/AdminPage.jsx';
import VerifyPage from './pages/VerifyPage.jsx';

const TABS = [
  { id: 'voter',  label: '투표하기',  icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },
  { id: 'verify', label: '검증',      icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
  { id: 'admin',  label: '관리자',    icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
];

export default function App() {
  const [tab, setTab] = useState('voter');
  const [connected, setConnected] = useState(null);

  useEffect(() => {
    fetch('/health').then(r => { setConnected(r.ok); }).catch(() => setConnected(false));
  }, []);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* 헤더 */}
      <header className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-6">
          <div className="flex items-center justify-between h-16">
            {/* 로고 */}
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <div>
                <h1 className="text-base font-bold text-slate-900 leading-tight tracking-tight">MONGBAS</h1>
                <p className="text-[10px] text-slate-400 font-medium">E2E Verifiable E-Voting on Hyperledger Fabric</p>
              </div>
            </div>

            {/* 탭 내비게이션 */}
            <nav className="flex items-center h-full" role="tablist">
              {TABS.map(t => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`
                    relative h-full px-5 flex items-center gap-2 text-sm font-medium
                    transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:ring-inset
                    ${tab === t.id
                      ? 'text-blue-600'
                      : 'text-slate-500 hover:text-slate-800'
                    }
                  `}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={t.icon} />
                  </svg>
                  {t.label}
                  {tab === t.id && (
                    <span className="absolute bottom-0 left-3 right-3 h-[3px] bg-blue-600 rounded-t-full" />
                  )}
                </button>
              ))}
            </nav>

            {/* 연결 상태 */}
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : connected === false ? 'bg-red-500' : 'bg-slate-300'}`} />
              <span className="text-[11px] text-slate-500 font-medium">
                {connected ? 'Fabric 연결됨' : connected === false ? '연결 끊김' : '확인 중...'}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* 콘텐츠 */}
      <main className={`mx-auto px-6 py-10 ${tab === 'admin' ? 'max-w-5xl' : 'max-w-4xl'}`}>
        {tab === 'voter'  && <VoterPage />}
        {tab === 'verify' && <VerifyPage />}
        {tab === 'admin'  && <AdminPage />}
      </main>
    </div>
  );
}
