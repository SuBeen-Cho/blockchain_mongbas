'use strict';
/**
 * getMerkleProof.js — Caliper 워크로드: GetMerkleProof 조회
 *
 * 전제: 해당 electionID의 선거가 종료되고 BuildMerkleTree가 완료된 상태.
 * initializeWorkloadModule에서 투표 데이터와 Merkle Tree를 준비합니다.
 */

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const crypto = require('crypto');

class GetMerkleProofWorkload extends WorkloadModuleBase {
  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);

    this.electionID = roundArguments.electionID;
    this.workerIndex = workerIndex;

    // 워커 0만 Merkle Tree 구축 (다른 워커는 기다림)
    if (workerIndex === 0) {
      try {
        await this.sutAdapter.sendRequests({
          contract: 'voting', channel: 'voting-channel',
          fcn: 'BuildMerkleTree', args: [this.electionID],
          invokerIdentity: 'Admin',
        });
      } catch (_) { /* 이미 구축된 경우 무시 */ }
    }

    // 쿼리에 사용할 nullifierHash 목록 미리 생성 (투표 시 사용한 것과 동일 포맷)
    this.nullifiers = Array.from({ length: 50 }, (_, i) =>
      crypto.createHash('sha256')
        .update(`worker_${workerIndex}_voter_${i + 1}_` + this.electionID)
        .digest('hex')
    );
    this.idx = 0;
  }

  async submitTransaction() {
    const nullifierHash = this.nullifiers[this.idx % this.nullifiers.length];
    this.idx++;

    return this.sutAdapter.sendRequests({
      contract:        'voting',
      channel:         'voting-channel',
      fcn:             'GetMerkleProof',
      args:            [this.electionID, nullifierHash],
      invokerIdentity: 'User1',
      readOnly:        true,
    });
  }
}

module.exports.createWorkloadModule = () => new GetMerkleProofWorkload();
