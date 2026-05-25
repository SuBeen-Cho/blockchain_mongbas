import { useState } from 'react';

export default function HashDisplay({ label, value, className = '' }) {
  const [copied, setCopied] = useState(false);

  if (!value) return null;

  const chunked = value.match(/.{1,8}/g)?.join(' · ') || value;

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`bg-slate-50 rounded-lg p-3 border border-slate-200 ${className}`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-medium text-slate-500">{label}</span>
        <button
          onClick={copy}
          className="text-[11px] text-blue-500 hover:text-blue-700 transition-colors duration-200 flex items-center gap-1"
        >
          {copied ? (
            <><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>복사됨</>
          ) : (
            <><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>복사</>
          )}
        </button>
      </div>
      <code className="text-xs font-mono text-slate-800 tracking-tight leading-relaxed break-all">
        {chunked}
      </code>
    </div>
  );
}
