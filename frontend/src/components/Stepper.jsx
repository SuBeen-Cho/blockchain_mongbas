const CheckIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

export default function Stepper({ steps, current }) {
  return (
    <div className="flex items-center justify-between w-full px-2">
      {steps.map((step, i) => {
        const isComplete = i < current;
        const isCurrent = i === current;
        const isLast = i === steps.length - 1;

        return (
          <div key={i} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center">
              <div className={`
                w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold
                transition-all duration-300 ease-out
                ${isComplete
                  ? 'bg-blue-600 text-white'
                  : isCurrent
                    ? 'bg-blue-600 text-white ring-4 ring-blue-100'
                    : 'bg-slate-200 text-slate-500'
                }
              `}>
                {isComplete ? <CheckIcon /> : i + 1}
              </div>
              <span className={`
                mt-1.5 text-[10px] sm:text-[11px] font-medium text-center leading-tight
                transition-colors duration-200
                ${isCurrent ? 'text-blue-600' : isComplete ? 'text-slate-600' : 'text-slate-400'}
              `}>
                {step}
              </span>
            </div>
            {!isLast && (
              <div className={`
                flex-1 h-0.5 mx-2 rounded-full transition-colors duration-300
                ${isComplete ? 'bg-blue-600' : 'bg-slate-200'}
              `} />
            )}
          </div>
        );
      })}
    </div>
  );
}
