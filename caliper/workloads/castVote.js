'use strict';
/**
 * castVote.js — Caliper 워크로드: CastVote 트랜잭션
 *
 * 각 라운드 시작 시 선거를 생성·활성화하고,
 * 각 트랜잭션에서 유일한 nullifierHash로 CastVote를 호출합니다.
 *
 * Nullifier 설계 (체인코드와 동일):
 *   nullifierHash = SHA256(voterSecret + electionID)
 *   Caliper에서는 crypto.createHash('sha256') 사용 (Node.js 내장)
 */

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const crypto = require('crypto');

class CastVoteWorkload extends WorkloadModuleBase {
  constructor() {
    super();
    this.electionID  = '';
    this.candidates  = [];
    this.txIndex     = 0;  // 트랜잭션 순번 (고유 nullifier 생성용)
  }

  /**
   * 라운드 시작 시 1회 호출 — 선거 생성 및 활성화
   */
  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);

    this.electionID = `${roundArguments.electionID}-w${workerIndex}-r${roundIndex}`;
    this.candidates = roundArguments.candidates || ['A', 'B', 'C'];
    this.workerIndex = workerIndex;
    this.txIndex    = 0;

    const endTime = Math.floor(Date.now() / 1000) + 3600;

    // 선거 생성
    await this.sutAdapter.sendRequests({
      contract: 'voting',
      channel:  'voting-channel',
      fcn:      'CreateElection',
      args:     [
        this.electionID,
        `Caliper 벤치마크 선거 (Worker ${workerIndex})`,
        'Caliper 성능 측정용',
        JSON.stringify(this.candidates),
        String(Math.floor(Date.now() / 1000)),
        String(endTime),
      ],
      invokerIdentity: 'Admin',
    });

    // 선거 활성화
    await this.sutAdapter.sendRequests({
      contract:        'voting',
      channel:         'voting-channel',
      fcn:             'ActivateElection',
      args:            [this.electionID],
      invokerIdentity: 'Admin',
    });
  }

  /**
   * 각 트랜잭션마다 호출 — CastVote 제출
   */
  async submitTransaction() {
    this.txIndex++;
    const voterSecret   = `worker_${this.workerIndex}_voter_${this.txIndex}_${Date.now()}`;
    const nullifierHash = crypto
      .createHash('sha256')
      .update(voterSecret + this.electionID)
      .digest('hex');
    const candidateID = this.candidates[this.txIndex % this.candidates.length];

    // PDC 비공개 데이터 (Transient Map)
    const votePrivate = {
      docType:      'votePrivate',
      voterID:      `caliper_voter_${this.workerIndex}_${this.txIndex}`,
      electionID:   this.electionID,
      candidateID,
      nullifierHash,
      voteHash:     crypto.createHash('sha256').update(voterSecret + candidateID).digest('hex'),
    };

    return this.sutAdapter.sendRequests({
      contract:        'voting',
      channel:         'voting-channel',
      fcn:             'CastVote',
      args:            [this.electionID, candidateID, nullifierHash],
      transientData:   { votePrivate: Buffer.from(JSON.stringify(votePrivate)) },
      invokerIdentity: 'User1',
      readOnly:        false,
    });
  }

  async cleanupWorkloadModule() {
    // 라운드 종료 후 선거 종료 (집계 트리거)
    try {
      await this.sutAdapter.sendRequests({
        contract:        'voting',
        channel:         'voting-channel',
        fcn:             'CloseElection',
        args:            [this.electionID],
        invokerIdentity: 'Admin',
      });
    } catch (_) {
      // 이미 종료된 선거면 무시
    }
  }
}

module.exports.createWorkloadModule = () => new CastVoteWorkload();
