import { motion } from 'framer-motion';

const spring = { type: 'spring', stiffness: 260, damping: 22 };

const items = [
  { key: 'included', label: '포함 여부', status: 'pass', desc: '투표가 집계에 포함되어 있습니다' },
  { key: 'candidate', label: '후보자 정보', status: 'block', desc: '반환하지 않음 — 누구에게 투표했는지 알 수 없음' },
  { key: 'proof', label: 'Merkle Proof', status: 'block', desc: '이 API 응답에서 미반환' },
  { key: 'ciphertext', label: '암호문 데이터', status: 'block', desc: '이 API 응답에서 미반환' },
];

export default function ReceiptFreeDiagram({ verifySteps = [], result = null }) {
  const started = verifySteps.includes('rf_query');
  const done = verifySteps.includes('rf_check_done');

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-amber-50 border border-amber-200 flex items-center justify-center">
          <svg className="w-4 h-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-bold text-slate-800">Receipt-Free 검증 흐름</p>
          <p className="text-[11px] text-slate-400">후보·proof·암호문을 제거한 API 응답 형태 데모</p>
        </div>
      </div>

      {/* SVG 차단 시각화 */}
      <div className="bg-gradient-to-b from-amber-50/30 to-white rounded-xl border border-amber-100 p-4">
        <svg viewBox="0 0 340 160" className="w-full max-w-sm mx-auto">
          <defs>
            <pattern id="gridRF" width="20" height="20" patternUnits="userSpaceOnUse">
              <circle cx="10" cy="10" r="0.5" fill="#cbd5e1" opacity="0.4"/>
            </pattern>
          </defs>
          <rect width="340" height="160" fill="url(#gridRF)" rx="8"/>

          {/* 서버 박스 */}
          <motion.g initial={{ opacity: 0 }} animate={{ opacity: started ? 1 : 0.3 }} transition={{ ...spring }}>
            <rect x="10" y="55" width="80" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8" strokeWidth="1.5"/>
            <text x="50" y="78" textAnchor="middle" fontSize="8" fontWeight="700" fill="#475569">서버 응답</text>
            <text x="50" y="92" textAnchor="middle" fontSize="6" fill="#94a3b8">블록체인 조회</text>
          </motion.g>

          {/* 화살표들 */}
          {items.map((item, i) => {
            const y = 25 + i * 34;
            const isPass = item.status === 'pass';
            const showItem = started;
            return (
              <motion.g key={item.key}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: showItem ? 1 : 0.15, x: showItem ? 0 : -5 }}
                transition={{ ...spring, delay: 0.2 + i * 0.15 }}
              >
                {/* 연결선 */}
                <motion.line x1="90" y1="80" x2="120" y2={y+12}
                  stroke={done ? (isPass ? '#3b82f6' : '#ef4444') : '#e2e8f0'}
                  strokeWidth="1.5" strokeDasharray={isPass ? 'none' : '4 3'}
                  initial={{ pathLength: 0 }} animate={{ pathLength: showItem ? 1 : 0 }}
                  transition={{ duration: 0.4, delay: 0.3 + i * 0.1 }}
                />
                {/* 결과 박스 */}
                <rect x="120" y={y} width="210" height="24" rx="6"
                  fill={done ? (isPass ? '#eff6ff' : '#fef2f2') : '#f8fafc'}
                  stroke={done ? (isPass ? '#bfdbfe' : '#fecaca') : '#e2e8f0'}
                  strokeWidth="1.5"
                />
                {/* 아이콘 */}
                {done && isPass && (
                  <motion.path d={`M130 ${y+12} l3 3 6-6`} stroke="#3b82f6" strokeWidth="2" fill="none" strokeLinecap="round"
                    initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.3, delay: 0.5 + i * 0.1 }} />
                )}
                {done && !isPass && (
                  <motion.g initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ ...spring, delay: 0.5 + i * 0.1 }}>
                    <line x1="128" y1={y+7} x2="137" y2={y+17} stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round"/>
                    <line x1="137" y1={y+7} x2="128" y2={y+17} stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round"/>
                  </motion.g>
                )}
                {/* 라벨 */}
                <text x="145" y={y+14} fontSize="7.5" fontWeight="600"
                  fill={done ? (isPass ? '#1d4ed8' : '#dc2626') : '#94a3b8'}
                >{item.label}</text>
                {done && (
                  <text x="320" y={y+14} textAnchor="end" fontSize="6.5" fontWeight="700"
                    fill={isPass ? '#3b82f6' : '#ef4444'}
                  >{isPass ? '전달됨' : '차단됨'}</text>
                )}
              </motion.g>
            );
          })}
        </svg>
      </div>

      {done && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.8 }}
          className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 space-y-1">
          <p className="text-xs font-bold text-amber-700">제한된 정보 반환</p>
          <p className="text-[11px] text-amber-600">이 응답은 후보·proof·암호문을 포함하지 않습니다. 다른 API·공개 원장·네트워크·단말 관측을 포함한 receipt-freeness는 별도 미검증입니다.</p>
          {result && (
            <div className="font-mono text-[10px] text-amber-500 bg-amber-100/50 rounded px-3 py-1 mt-1">
              포함: <span className="font-bold">{result.included ? 'YES' : 'NO'}</span> / 총 투표: <span className="font-bold">{result.totalVotes}표</span> / 후보 정보: <span className="font-bold text-red-500">차단됨</span>
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}
