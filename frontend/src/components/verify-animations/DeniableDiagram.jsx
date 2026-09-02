import { motion } from 'framer-motion';

const spring = { type: 'spring', stiffness: 260, damping: 22 };

const steps = [
  { key: 'nullifier', label: 'Nullifier 생성', desc: '서명된 자격증명 결합값과 선거 범위로 중복방지 식별자를 생성합니다' },
  { key: 'proof', label: '비밀번호로 증명 요청', desc: '입력한 비밀번호에 따라 서로 다른 Merkle 경로가 반환됩니다' },
  { key: 'compute', label: 'Root 재계산', desc: '반환된 경로로 Root를 직접 계산합니다' },
  { key: 'compare', label: 'Root 비교 → 검증 성공', desc: '어떤 비밀번호든 "성공"으로 보이지만 내부 경로가 다릅니다' },
];

export default function DeniableDiagram({ verifySteps = [], result = null, prevResult = null }) {
  const activeKeys = new Set();
  steps.forEach(s => { if (verifySteps.includes(s.key) || verifySteps.includes(s.key+'_done')) activeKeys.add(s.key); });
  const allDone = verifySteps.includes('compare_done');

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-red-50 border border-red-200 flex items-center justify-center">
          <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-bold text-slate-800">Deniable Verification 흐름</p>
          <p className="text-[11px] text-slate-400">Opaque proof API — API transcript 보완 범위만 시연</p>
        </div>
      </div>

      {/* SVG 분기 다이어그램 — 밝은 배경 */}
      <div className="bg-gradient-to-b from-red-50/30 to-white rounded-xl border border-red-100 p-4">
        <svg viewBox="0 0 340 150" className="w-full max-w-sm mx-auto">
          <defs>
            <pattern id="gridD" width="20" height="20" patternUnits="userSpaceOnUse">
              <circle cx="10" cy="10" r="0.5" fill="#fca5a5" opacity="0.3"/>
            </pattern>
          </defs>
          <rect width="340" height="150" fill="url(#gridD)" rx="8"/>

          {/* Nullifier 박스 */}
          <motion.g initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: activeKeys.has('nullifier') ? 1 : 0.3, scale: 1 }} transition={spring}>
            <rect x="110" y="5" width="120" height="28" rx="8" fill="#eff6ff" stroke="#3b82f6" strokeWidth="1.5"/>
            <text x="170" y="23" textAnchor="middle" fontSize="8" fontWeight="700" fill="#1d4ed8">Nullifier (동일)</text>
          </motion.g>

          {/* 분기선 */}
          <motion.line x1="140" y1="33" x2="70" y2="62" stroke="#3b82f6" strokeWidth="1.5"
            initial={{ pathLength: 0 }} animate={{ pathLength: activeKeys.has('proof') ? 1 : 0 }} transition={{ duration: 0.5, delay: 0.2 }} />
          <motion.line x1="200" y1="33" x2="270" y2="62" stroke="#ef4444" strokeWidth="1.5"
            initial={{ pathLength: 0 }} animate={{ pathLength: activeKeys.has('proof') ? 1 : 0 }} transition={{ duration: 0.5, delay: 0.3 }} />

          {/* Normal PW */}
          <motion.g initial={{ opacity: 0, y: 8 }} animate={{ opacity: activeKeys.has('proof') ? 1 : 0.2, y: 0 }} transition={{ ...spring, delay: 0.3 }}>
            <rect x="10" y="62" width="120" height="28" rx="8" fill="#eff6ff" stroke="#93c5fd" strokeWidth="1.5"/>
            <text x="70" y="80" textAnchor="middle" fontSize="8" fontWeight="600" fill="#2563eb">Normal PW</text>
          </motion.g>

          {/* Panic PW */}
          <motion.g initial={{ opacity: 0, y: 8 }} animate={{ opacity: activeKeys.has('proof') ? 1 : 0.2, y: 0 }} transition={{ ...spring, delay: 0.4 }}>
            <rect x="210" y="62" width="120" height="28" rx="8" fill="#fef2f2" stroke="#fca5a5" strokeWidth="1.5"/>
            <text x="270" y="80" textAnchor="middle" fontSize="8" fontWeight="600" fill="#dc2626">Panic PW</text>
          </motion.g>

          {/* 결과 화살표 */}
          <motion.line x1="70" y1="90" x2="70" y2="112" stroke="#3b82f6" strokeWidth="1.5"
            initial={{ pathLength: 0 }} animate={{ pathLength: activeKeys.has('compute') ? 1 : 0 }} transition={{ duration: 0.4, delay: 0.5 }} />
          <motion.line x1="270" y1="90" x2="270" y2="112" stroke="#ef4444" strokeWidth="1.5"
            initial={{ pathLength: 0 }} animate={{ pathLength: activeKeys.has('compute') ? 1 : 0 }} transition={{ duration: 0.4, delay: 0.6 }} />

          {/* 결과 박스 */}
          <motion.g initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: allDone ? 1 : activeKeys.has('compute') ? 0.6 : 0.15, scale: 1 }}
            transition={{ ...spring, delay: 0.6 }}>
            <rect x="10" y="112" width="120" height="28" rx="8" fill={allDone ? '#eff6ff' : '#f8fafc'} stroke={allDone ? '#3b82f6' : '#e2e8f0'} strokeWidth="1.5"/>
            <text x="70" y="128" textAnchor="middle" fontSize="7" fontWeight="700" fill={allDone ? '#1d4ed8' : '#94a3b8'}>✓ 실제 증명 반환</text>
          </motion.g>
          <motion.g initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: allDone ? 1 : activeKeys.has('compute') ? 0.6 : 0.15, scale: 1 }}
            transition={{ ...spring, delay: 0.7 }}>
            <rect x="210" y="112" width="120" height="28" rx="8" fill={allDone ? '#fef2f2' : '#f8fafc'} stroke={allDone ? '#ef4444' : '#e2e8f0'} strokeWidth="1.5"/>
            <text x="270" y="128" textAnchor="middle" fontSize="7" fontWeight="700" fill={allDone ? '#dc2626' : '#94a3b8'}>✓ 가짜 증명 반환</text>
          </motion.g>

          {/* 핵심 메시지 */}
          {allDone && (
            <motion.text x="170" y="148" textAnchor="middle" fontSize="7" fontWeight="700" fill="#d97706"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1 }}
            >둘 다 검증 형태 응답 — 제한된 API 데모</motion.text>
          )}
        </svg>
      </div>

      {/* 단계 카드 */}
      <div className="space-y-2">
        {steps.map((s, i) => {
          const started = verifySteps.includes(s.key);
          const done = verifySteps.includes(s.key+'_done');
          const isCurrent = started && !done;
          return (
            <motion.div key={s.key}
              initial={{ opacity: 0, x: -12 }} animate={{ opacity: started ? 1 : 0.4, x: 0 }}
              transition={{ ...spring, delay: i * 0.2 }}
              className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${
                done ? 'bg-blue-50 border-blue-200' : isCurrent ? 'bg-white border-blue-400 shadow-sm' : 'bg-slate-50/50 border-slate-100'
              }`}
            >
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${
                done ? 'bg-blue-600 text-white' : isCurrent ? 'bg-blue-100 text-blue-600' : 'bg-slate-200 text-slate-400'
              }`}>{done ? '✓' : i+1}</div>
              <div className="flex-1">
                <p className={`text-sm font-semibold ${done ? 'text-blue-700' : isCurrent ? 'text-slate-800' : 'text-slate-400'}`}>{s.label}</p>
                <p className={`text-[11px] mt-0.5 ${done ? 'text-blue-500' : isCurrent ? 'text-slate-500' : 'text-slate-300'}`}>{s.desc}</p>
              </div>
              {isCurrent && (
                <svg className="w-4 h-4 text-blue-500 animate-spin shrink-0 mt-1" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
            </motion.div>
          );
        })}
      </div>

      {/* 실제 leaf 비교 — 이전 결과가 있을 때 */}
      {allDone && prevResult && result && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.8 }}
          className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 space-y-2">
          <p className="text-xs font-bold text-amber-700">이전 결과와 비교 — Leaf Hash가 다름 (구분 불가)</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="text-center">
              <p className="text-[10px] font-semibold text-blue-600 mb-1">이전 (다른 비밀번호)</p>
              <p className="font-mono text-[10px] text-slate-500 break-all bg-white rounded px-2 py-1">{(prevResult.localVerification?.leafHash || prevResult.proof?.leafHash || prevResult.leafHash || '').slice(0, 16)}…</p>
            </div>
            <div className="text-center">
              <p className="text-[10px] font-semibold text-red-500 mb-1">현재</p>
              <p className="font-mono text-[10px] text-slate-500 break-all bg-white rounded px-2 py-1">{(result.localVerification?.leafHash || result.proof?.leafHash || result.leafHash || '').slice(0, 16)}…</p>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}
