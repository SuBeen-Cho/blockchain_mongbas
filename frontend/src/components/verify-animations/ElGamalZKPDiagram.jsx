import { motion } from 'framer-motion';

const spring = { type: 'spring', stiffness: 260, damping: 22 };

const pipeSteps = [
  { key: 'zkp_fetch', doneKey: 'zkp_fetch_done', icon: '1', label: '동형 암호문 집계', desc: '개별 ElGamal 암호문을 곱셈으로 결합 — 복호화 없이 암호문 상태로 합산', formula: 'E(v₁) × E(v₂) × … = E(Σvᵢ)' },
  { key: 'zkp_verify', doneKey: 'zkp_verify_done', icon: '2', label: 'Chaum-Pedersen ZKP', desc: '각 후보의 복호화가 정확한지 영지식 증명으로 확인 — 비밀키 없이 수학적 증명', formula: 'ZKP: (a,b,c,r) → 검증자가 비밀키 없이 확인' },
  { key: 'zkp_compare', doneKey: 'zkp_compare_done', icon: '3', label: '재집계 비교', desc: 'ZKP 검증된 집계와 공식 결과가 일치하는지 최종 확인', formula: 'ZKP 결과 = 공식 결과 → ✓' },
];

export default function ElGamalZKPDiagram({ verifySteps = [], result = null }) {
  const allDone = verifySteps.includes('zkp_compare_done');
  const verified = result?.verified;
  const failed = result?.failed;
  const recount = result?.recount;
  const resultsMatch = result?.resultsMatch;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-purple-50 border border-purple-200 flex items-center justify-center">
          <svg className="w-4 h-4 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-bold text-slate-800">ElGamal ZKP 검증 흐름</p>
          <p className="text-[11px] text-slate-400">Tallied-as-Recorded — 비밀키 없이 집계 정확성을 수학적으로 증명</p>
        </div>
      </div>

      {/* SVG 파이프라인 — 밝은 보라 톤 */}
      <div className="bg-gradient-to-r from-purple-50/50 to-white rounded-xl border border-purple-100 p-4">
        <svg viewBox="0 0 360 100" className="w-full max-w-md mx-auto">
          <defs>
            <pattern id="gridZKP" width="20" height="20" patternUnits="userSpaceOnUse">
              <circle cx="10" cy="10" r="0.5" fill="#a78bfa" opacity="0.2"/>
            </pattern>
          </defs>
          <rect width="360" height="100" fill="url(#gridZKP)" rx="8"/>

          {pipeSteps.map((s, i) => {
            const x = 10 + i * 120;
            const started = verifySteps.includes(s.key);
            const done = verifySteps.includes(s.doneKey);
            return (
              <motion.g key={s.key}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: started ? 1 : 0.2, y: 0 }}
                transition={{ ...spring, delay: i * 0.25 }}
              >
                {/* 박스 */}
                <rect x={x} y="10" width="105" height="50" rx="10"
                  fill={done ? '#f5f3ff' : '#fafafa'}
                  stroke={done ? '#8b5cf6' : '#e2e8f0'}
                  strokeWidth={done ? 2 : 1.5}
                />
                {/* 아이콘 원 */}
                <circle cx={x+16} cy="24" r="8"
                  fill={done ? '#8b5cf6' : '#f1f5f9'}
                  stroke={done ? '#7c3aed' : '#cbd5e1'}
                  strokeWidth="1.5"
                />
                <text x={x+16} y="27" textAnchor="middle" fontSize="7" fontWeight="700"
                  fill={done ? '#fff' : '#94a3b8'}
                >{done ? '✓' : s.icon}</text>
                {/* 라벨 */}
                <text x={x+30} y="28" fontSize="7" fontWeight="700" fill={done ? '#6d28d9' : '#64748b'}>{s.label}</text>
                {/* 수식 */}
                <text x={x+52} y="48" textAnchor="middle" fontSize="5.5" fill={done ? '#a78bfa' : '#cbd5e1'} fontStyle="italic">{s.formula}</text>

                {/* 화살표 */}
                {i < pipeSteps.length - 1 && (
                  <motion.path d={`M${x+110} 35 L${x+120} 35`}
                    stroke={done ? '#8b5cf6' : '#e2e8f0'} strokeWidth="2" fill="none"
                    markerEnd="url(#arrowP)"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: done ? 1 : 0 }}
                    transition={{ duration: 0.4, delay: i * 0.3 + 0.2 }}
                  />
                )}
              </motion.g>
            );
          })}

          {/* 수식 설명 */}
          <motion.text x="180" y="80" textAnchor="middle" fontSize="6" fill="#7c3aed" fontWeight="500"
            initial={{ opacity: 0 }} animate={{ opacity: verifySteps.includes('zkp_fetch') ? 0.7 : 0 }}
          >Exponential ElGamal: E(m) = (gʳ, gᵐ · yʳ) — 동형 성질로 복호화 없이 집계</motion.text>
          <motion.text x="180" y="92" textAnchor="middle" fontSize="5.5" fill="#a78bfa" fontWeight="400"
            initial={{ opacity: 0 }} animate={{ opacity: verifySteps.includes('zkp_verify') ? 0.6 : 0 }}
          >BSGS 이산로그 복원: O(√N) 시간 복잡도</motion.text>

          <defs>
            <marker id="arrowP" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <path d="M0,0 L8,3 L0,6" fill="#8b5cf6" />
            </marker>
          </defs>
        </svg>
      </div>

      {/* 단계 카드 */}
      <div className="space-y-2">
        {pipeSteps.map((s, i) => {
          const started = verifySteps.includes(s.key);
          const done = verifySteps.includes(s.doneKey);
          const isCurrent = started && !done;
          let extra = null;
          if (s.key === 'zkp_fetch' && done && verified != null) extra = `${verified}개 암호문 집계 완료`;
          if (s.key === 'zkp_verify' && done && verified != null) extra = `검증 성공: ${verified}개 / 실패: ${failed || 0}개`;
          if (s.key === 'zkp_compare' && done && recount) extra = Object.entries(recount).map(([c,n]) => `${c}: ${n}표`).join(' / ') + (resultsMatch ? ' — 일치 ✓' : ' — 불일치 ✗');
          return (
            <motion.div key={s.key}
              initial={{ opacity: 0, x: -12 }} animate={{ opacity: started ? 1 : 0.4, x: 0 }}
              transition={{ ...spring, delay: i * 0.2 }}
              className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${
                done ? 'bg-purple-50 border-purple-200' : isCurrent ? 'bg-white border-purple-400 shadow-sm' : 'bg-slate-50/50 border-slate-100'
              }`}
            >
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${
                done ? 'bg-purple-600 text-white' : isCurrent ? 'bg-purple-100 text-purple-600' : 'bg-slate-200 text-slate-400'
              }`}>{done ? '✓' : s.icon}</div>
              <div className="flex-1">
                <p className={`text-sm font-semibold ${done ? 'text-purple-700' : isCurrent ? 'text-slate-800' : 'text-slate-400'}`}>{s.label}</p>
                <p className={`text-[11px] mt-0.5 ${done ? 'text-purple-500' : isCurrent ? 'text-slate-500' : 'text-slate-300'}`}>{s.desc}</p>
                {done && extra && <p className="text-[10px] font-mono text-purple-400 mt-1 bg-purple-50 rounded px-2 py-0.5">{extra}</p>}
              </div>
              {isCurrent && (
                <svg className="w-4 h-4 text-purple-500 animate-spin shrink-0 mt-1" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
            </motion.div>
          );
        })}
      </div>

      {allDone && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.5 }}
          className="flex items-center gap-2 px-4 py-3 bg-purple-50 border border-purple-200 rounded-xl">
          <svg className="w-5 h-5 text-purple-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <div className="text-xs text-purple-700 space-y-1">
            <p><span className="font-bold">비밀키 없이 수학적 증명 완료</span> — 동형 집계가 정확함이 Chaum-Pedersen ZKP로 확인됨</p>
            {(verified != null || recount) && (
              <div className="flex flex-wrap gap-2 font-mono text-[10px] text-purple-500 bg-purple-100/50 rounded-lg px-3 py-1.5">
                {verified != null && <span>검증: <span className="font-bold text-purple-700">{verified}개 성공</span></span>}
                {failed != null && failed > 0 && <span className="text-red-500">실패: {failed}개</span>}
                {recount && Object.entries(recount).map(([c,n]) => <span key={c}>{c}: <span className="font-bold">{n}표</span></span>)}
                {resultsMatch != null && <span className={`font-bold ${resultsMatch ? 'text-purple-700' : 'text-red-600'}`}>{resultsMatch ? '재집계 일치 ✓' : '불일치 ✗'}</span>}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </div>
  );
}
