import { motion } from 'framer-motion';

const spring = { type: 'spring', stiffness: 260, damping: 22 };
const NODE_R = 16;

// 트리 노드 위치 — 밑에서 위로
const nodes = [
  { id: 'leaf', x: 55,  y: 185, label: '나의 투표', primary: true },
  { id: 's1',   x: 155, y: 185, label: 'H₁ (sibling)' },
  { id: 'n1',   x: 105, y: 120, label: 'H(leaf, H₁)' },
  { id: 's2',   x: 245, y: 120, label: 'H₂ (sibling)' },
  { id: 'n2',   x: 175, y: 55,  label: 'H(…, H₂)' },
  { id: 'root', x: 175, y: 5,   label: 'Root' },
];
const edges = [
  ['leaf','n1'], ['s1','n1'], ['n1','n2'], ['s2','n2'], ['n2','root'],
];
const stepNodes = {
  nullifier: ['leaf'],
  proof: ['leaf','s1','s2'],
  compute: ['leaf','s1','n1','s2','n2'],
  compare: ['leaf','s1','n1','s2','n2','root'],
};

const steps = [
  { key: 'nullifier', label: '내 투표 찾기', desc: 'nullifierHash로 블록체인에서 내 투표 위치를 검색' },
  { key: 'proof', label: '경로 증명 수신', desc: 'Root까지 올라가는 형제 해시(H₁, H₂)를 받음' },
  { key: 'compute', label: 'Root 직접 계산', desc: 'Leaf부터 형제 해시를 결합하여 Root를 브라우저에서 계산' },
  { key: 'compare', label: 'Root 일치 확인', desc: '직접 계산한 Root가 블록체인 Root와 같으면 검증 성공' },
];

function getNode(id) { return nodes.find(n => n.id === id); }

export default function MerkleTreeDiagram({ verifySteps = [], result = null }) {
  const activeIds = new Set();
  steps.forEach(s => {
    if (verifySteps.includes(s.key) || verifySteps.includes(s.key+'_done'))
      (stepNodes[s.key]||[]).forEach(n => activeIds.add(n));
  });
  const allDone = verifySteps.includes('compare_done');

  // 실제 해시값 (앞 8자리)
  const h = (v) => v ? v.slice(0, 8) + '…' : '';
  const leafHash = h(result?.localVerification?.leafHash || result?.proof?.leafHash || result?.leafHash);
  const chainRoot = h(result?.localVerification?.chainRoot);
  const computedRoot = h(result?.localVerification?.computedRoot);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
      {/* 헤더 */}
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-center">
          <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-bold text-slate-800">Merkle Proof 검증 흐름</p>
          <p className="text-[11px] text-slate-400">Recorded-as-Cast — 내 투표가 변조 없이 기록되었음을 증명</p>
        </div>
      </div>

      {/* SVG 트리 — 밝은 배경, 파란 톤 */}
      <div className="bg-gradient-to-b from-blue-50/50 to-white rounded-xl border border-blue-100 p-4">
        <svg viewBox="0 0 350 220" className="w-full max-w-sm mx-auto">
          {/* 점선 배경 그리드 */}
          <defs>
            <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <circle cx="10" cy="10" r="0.5" fill="#cbd5e1" opacity="0.5"/>
            </pattern>
          </defs>
          <rect width="350" height="220" fill="url(#grid)" rx="8"/>

          {/* 엣지 — 연한 파란색, 활성 시 진한 파란 + pathLength */}
          {edges.map(([fid,tid], i) => {
            const f = getNode(fid), t = getNode(tid);
            const active = activeIds.has(fid) && activeIds.has(tid);
            return (
              <motion.line key={i}
                x1={f.x+NODE_R} y1={f.y+NODE_R} x2={t.x+NODE_R} y2={t.y+NODE_R}
                stroke={active ? '#3b82f6' : '#e2e8f0'}
                strokeWidth={active ? 2.5 : 1.5}
                strokeDasharray={active ? 'none' : '4 4'}
                initial={{ pathLength: 0 }}
                animate={{ pathLength: active ? 1 : 0.3 }}
                transition={{ duration: 0.6, delay: i * 0.12 }}
              />
            );
          })}

          {/* 노드 */}
          {nodes.map((n, i) => {
            const active = activeIds.has(n.id);
            const isRoot = n.id === 'root';
            const done = isRoot && allDone;
            const isPrimary = n.primary;
            return (
              <motion.g key={n.id}
                initial={{ opacity: 0, scale: 0 }}
                animate={{ opacity: active ? 1 : 0.25, scale: active ? 1 : 0.7 }}
                transition={{ ...spring, delay: i * 0.1 }}
              >
                {/* 그림자 */}
                {active && <circle cx={n.x+NODE_R} cy={n.y+NODE_R+2} r={NODE_R+2} fill="#3b82f6" opacity="0.1"/>}
                {/* 원 */}
                <circle cx={n.x+NODE_R} cy={n.y+NODE_R} r={NODE_R}
                  fill={done ? '#3b82f6' : active ? (isPrimary ? '#dbeafe' : '#f1f5f9') : '#f8fafc'}
                  stroke={done ? '#2563eb' : active ? (isPrimary ? '#3b82f6' : '#94a3b8') : '#e2e8f0'}
                  strokeWidth={active ? 2 : 1}
                />
                {/* 텍스트 */}
                <text x={n.x+NODE_R} y={n.y+NODE_R+3.5}
                  textAnchor="middle" fontSize="7" fontWeight="600" fontFamily="system-ui"
                  fill={done ? '#fff' : active ? (isPrimary ? '#1d4ed8' : '#475569') : '#cbd5e1'}
                >{n.label}</text>
                {/* 완료 체크 */}
                {done && (
                  <motion.path
                    d={`M${n.x+NODE_R-5} ${n.y+NODE_R} l3 3 7-7`}
                    stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"
                    initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.4, delay: 0.3 }}
                  />
                )}
              </motion.g>
            );
          })}
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
              }`}>
                {done ? (
                  <motion.svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                    <motion.path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"
                      initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.3, type: 'spring' }} />
                  </motion.svg>
                ) : i+1}
              </div>
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

      {allDone && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.5 }}
          className="flex items-center gap-2 px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl">
          <svg className="w-5 h-5 text-blue-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <div className="text-xs text-blue-700 space-y-1">
            <p><span className="font-bold">직접 계산한 Root = 블록체인 Root</span> → 투표가 변조 없이 포함됨 증명</p>
            {computedRoot && chainRoot && (
              <div className="flex gap-3 font-mono text-[10px] text-blue-500 bg-blue-100/50 rounded-lg px-3 py-1.5">
                <span>Leaf: <span className="font-bold">{leafHash}</span></span>
                <span>계산Root: <span className="font-bold">{computedRoot}</span></span>
                <span>체인Root: <span className="font-bold">{chainRoot}</span></span>
                <span className="text-blue-700 font-bold">{computedRoot === chainRoot ? '= 일치 ✓' : '≠ 불일치'}</span>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </div>
  );
}
