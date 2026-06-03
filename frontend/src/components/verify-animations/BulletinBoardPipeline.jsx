import { motion } from 'framer-motion';

const spring = { type: 'spring', stiffness: 260, damping: 22 };

const pipeSteps = [
  { key: 'bb_fetch', doneKey: 'bb_fetch_done', icon: '1', label: 'BB 데이터 조회', desc: '공개된 암호문 + 암호화 키를 블록체인에서 가져옵니다' },
  { key: 'bb_decrypt', doneKey: 'bb_decrypt_done', icon: '2', label: '전체 투표 복호화', desc: '공개된 키로 모든 암호문을 브라우저에서 직접 복호화' },
  { key: 'bb_server', doneKey: 'bb_server_done', icon: '3', label: '독립 재집계', desc: '복호화된 투표를 직접 집계 + 서버도 독립적으로 검증' },
  { key: 'bb_compare', doneKey: 'bb_compare_done', icon: '4', label: '공식 결과 비교', desc: '브라우저 재집계 + 서버 검증 결과가 공식 결과와 일치하는지 확인' },
];

function StepCard({ step, index, verifySteps, extraInfo }) {
  const started = verifySteps.includes(step.key);
  const done = verifySteps.includes(step.doneKey);
  const isCurrent = started && !done;
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }} animate={{ opacity: started ? 1 : 0.4, y: 0 }}
      transition={{ ...spring, delay: index * 0.2 }}
      className={`flex items-start gap-3 p-4 rounded-xl border transition-colors ${
        done ? 'bg-blue-50 border-blue-200' : isCurrent ? 'bg-white border-blue-400 shadow-sm shadow-blue-100' : 'bg-slate-50 border-slate-200'
      }`}
    >
      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
        done ? 'bg-blue-600 text-white' : isCurrent ? 'bg-blue-100 text-blue-600' : 'bg-slate-200 text-slate-400'
      }`}>
        {done ? (
          <motion.svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
            <motion.path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"
              initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.4, type: 'spring' }} />
          </motion.svg>
        ) : step.icon}
      </div>
      <div className="flex-1">
        <p className={`text-sm font-semibold ${done ? 'text-blue-700' : isCurrent ? 'text-slate-800' : 'text-slate-400'}`}>{step.label}</p>
        <p className={`text-xs mt-0.5 ${done ? 'text-blue-500' : isCurrent ? 'text-slate-500' : 'text-slate-300'}`}>{step.desc}</p>
        {done && extraInfo && <p className="text-[10px] font-mono text-blue-400 mt-1 bg-blue-50 rounded px-2 py-0.5">{extraInfo}</p>}
      </div>
      {isCurrent && (
        <svg className="w-5 h-5 text-blue-500 animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
    </motion.div>
  );
}

export default function BulletinBoardPipeline({ verifySteps = [], result = null }) {
  const allDone = verifySteps.includes('bb_compare_done');
  const totalBallots = result?.bulletinBoard?.totalBallots || result?.clientVerification?.tallyVerification?.totalCount;
  const validCount = result?.clientVerification?.tallyVerification?.validCount;
  const tallyResults = result?.bulletinBoard?.tallyResults;
  const resultsMatch = result?.serverVerification?.resultsMatch ?? result?.clientVerification?.tallyVerification?.tallyMatch;
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
          <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-bold text-slate-800">Universal Verification 흐름</p>
          <p className="text-[11px] text-slate-400">인증 불필요 — 누구나 공개 데이터로 독립 검증 가능</p>
        </div>
      </div>

      {/* 파이프라인 아이콘 흐름 */}
      <div className="flex items-center justify-between gap-1 py-2 overflow-x-auto">
        {pipeSteps.map((s, i) => {
          const done = verifySteps.includes(s.doneKey);
          const started = verifySteps.includes(s.key);
          return (
            <div key={s.key} className="flex items-center">
              <motion.div
                initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: started ? 1 : 0.3, scale: started ? 1 : 0.85 }}
                transition={{ ...spring, delay: i * 0.2 }}
                className={`w-14 h-14 rounded-2xl flex items-center justify-center border-2 ${
                  done ? 'bg-blue-50 border-blue-500' : started ? 'bg-white border-blue-300' : 'bg-slate-50 border-slate-200'
                }`}
              >
                {done ? (
                  <motion.svg className="w-6 h-6 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <motion.path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"
                      initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.4, type: 'spring' }} />
                  </motion.svg>
                ) : <span className={`text-lg font-bold ${started ? 'text-blue-500' : 'text-slate-300'}`}>{s.icon}</span>}
              </motion.div>
              {i < pipeSteps.length - 1 && (
                <motion.div className="mx-1" initial={{ opacity: 0 }} animate={{ opacity: done ? 1 : 0.2 }} transition={{ delay: i * 0.2 + 0.1 }}>
                  <svg width="20" height="12" viewBox="0 0 20 12"><path d="M2 6h16M14 2l4 4-4 4" stroke={done?'#3b82f6':'#cbd5e1'} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </motion.div>
              )}
            </div>
          );
        })}
      </div>

      <div className="space-y-2">
        {pipeSteps.map((s, i) => {
          let extra = null;
          if (s.key === 'bb_fetch' && totalBallots) extra = `암호문 ${totalBallots}개 + 암호화 키 수신 완료`;
          if (s.key === 'bb_decrypt' && validCount) extra = `${validCount}/${totalBallots}개 복호화 성공`;
          if (s.key === 'bb_server' && tallyResults) extra = Object.entries(tallyResults).map(([c,n]) => `${c}: ${n}표`).join(' / ');
          if (s.key === 'bb_compare' && resultsMatch != null) extra = resultsMatch ? '공식 결과와 일치 ✓' : '불일치 ✗';
          return <StepCard key={s.key} step={s} index={i} verifySteps={verifySteps} extraInfo={extra} />;
        })}
      </div>

      {allDone && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.5 }}
          className="px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl flex items-center gap-2">
          <svg className="w-5 h-5 text-blue-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <div className="text-xs text-blue-700 space-y-1">
            <p><span className="font-bold">브라우저 + 서버 이중 검증 완료</span> — 누구나 독립적으로 집계 정확성을 확인할 수 있음</p>
            {(totalBallots || tallyResults) && (
              <div className="flex flex-wrap gap-2 font-mono text-[10px] text-blue-500 bg-blue-100/50 rounded-lg px-3 py-1.5">
                {totalBallots && <span>투표: <span className="font-bold">{validCount || totalBallots}/{totalBallots}건</span> 복호화</span>}
                {tallyResults && Object.entries(tallyResults).map(([c,n]) => <span key={c}>{c}: <span className="font-bold">{n}표</span></span>)}
                {resultsMatch != null && <span className={`font-bold ${resultsMatch ? 'text-blue-700' : 'text-red-600'}`}>{resultsMatch ? '일치 ✓' : '불일치 ✗'}</span>}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </div>
  );
}
