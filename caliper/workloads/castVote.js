'use strict';
/**
 * castVote.js — Caliper 워크로드: CastVote 트랜잭션
 * peer-gateway 커넥터 형식 사용 (contractId / contractFunction / contractArguments)
 */

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const crypto = require('crypto');

class CastVoteWorkload extends WorkloadModuleBase {
  constructor() {
    super();
    this.electionID  = '';
    this.candidates  = [];
    this.txIndex     = 0;
  }

  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);

    this.electionID  = `${roundArguments.electionID}-w${workerIndex}-r${roundIndex}-${Date.now()}`;
    this.candidates  = roundArguments.candidates || ['A', 'B', 'C'];
    this.workerIndex = workerIndex;
    this.txIndex     = 0;

    const endTime = Math.floor(Date.now() / 1000) + 3600;

    // 선거 생성
    await this.sutAdapter.sendRequests({
      contractId:       'voting',
      channel:          'voting-channel',
      contractFunction: 'CreateElection',
      contractArguments: [
        this.electionID,
        `Caliper 벤치마크 선거 (Worker ${workerIndex})`,
        'Caliper 성능 측정용',
        JSON.stringify(this.candidates),
        String(Math.floor(Date.now() / 1000)),
        String(endTime),
      ],
      invokerIdentity: 'Admin',
      readOnly: false,
    });

    // 선거 활성화
    await this.sutAdapter.sendRequests({
      contractId:        'voting',
      channel:           'voting-channel',
      contractFunction:  'ActivateElection',
      contractArguments: [this.electionID],
      invokerIdentity:   'Admin',
      readOnly:          false,
    });
  }

  async submitTransaction() {
    this.txIndex++;
    const voterSecret   = `worker_${this.workerIndex}_voter_${this.txIndex}_${Date.now()}`;
    const nullifierHash = crypto
      .createHash('sha256')
      .update(voterSecret + this.electionID)
      .digest('hex');
    const candidateID = this.candidates[this.txIndex % this.candidates.length];

    const votePrivate = {
      docType:      'votePrivate',
      voterID:      `caliper_voter_${this.workerIndex}_${this.txIndex}`,
      electionID:   this.electionID,
      candidateID,
      nullifierHash,
      voteHash: crypto.createHash('sha256').update(voterSecret + candidateID).digest('hex'),
    };

    return this.sutAdapter.sendRequests({
      contractId:        'voting',
      channel:           'voting-channel',
      contractFunction:  'CastVote',
      contractArguments: [this.electionID, candidateID, nullifierHash],
      transientMap:      { votePrivate: Buffer.from(JSON.stringify(votePrivate)) },
      invokerIdentity:   'User1',
      readOnly:          false,
    });
  }

  async cleanupWorkloadModule() {
    try {
      await this.sutAdapter.sendRequests({
        contractId:        'voting',
        channel:           'voting-channel',
        contractFunction:  'CloseElection',
        contractArguments: [this.electionID],
        invokerIdentity:   'Admin',
        readOnly:          false,
      });
    } catch (_) {}
  }
}

module.exports.createWorkloadModule = () => new CastVoteWorkload();
