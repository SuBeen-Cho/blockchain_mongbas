'use strict';

function positiveInteger(name, fallback, maximum) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name}는 1~${maximum} 범위의 정수여야 합니다.`);
  return value;
}

class ConcurrencyGate {
  constructor({ limit, maxQueue, waitTimeoutMs }) {
    this.limit = limit; this.maxQueue = maxQueue; this.waitTimeoutMs = waitTimeoutMs;
    this.active = 0; this.queue = [];
  }
  acquire() {
    if (this.active < this.limit) { this.active += 1; return Promise.resolve(this.releaseHandle()); }
    if (this.queue.length >= this.maxQueue) return Promise.reject(Object.assign(new Error('Fabric 요청 대기열이 가득 찼습니다.'), { code: 'FABRIC_QUEUE_FULL' }));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(Object.assign(new Error('Fabric 요청 대기 시간을 초과했습니다.'), { code: 'FABRIC_QUEUE_TIMEOUT' }));
      }, this.waitTimeoutMs);
      this.queue.push(waiter);
    });
  }
  releaseHandle() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.queue.shift();
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(this.releaseHandle()); } else { this.active -= 1; }
    };
  }
  status() { return { limit: this.limit, active: this.active, queued: this.queue.length, maxQueue: this.maxQueue }; }
}

const fabricConcurrencyGate = new ConcurrencyGate({
  // Fabric Gateway peer의 기본 동시 RPC 상한(500)보다 여유를 둔다.
  limit: positiveInteger('FABRIC_MAX_IN_FLIGHT', 400, 499),
  maxQueue: positiveInteger('FABRIC_MAX_QUEUE', 2000, 100000),
  waitTimeoutMs: positiveInteger('FABRIC_QUEUE_TIMEOUT_MS', 180000, 600000),
});

module.exports = { ConcurrencyGate, fabricConcurrencyGate };
