'use strict';
/**
 * getElection.js — Caliper 워크로드: GetElection 조회 (Read-only)
 */

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

class GetElectionWorkload extends WorkloadModuleBase {
  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
    this.electionID = roundArguments.electionID;
  }

  async submitTransaction() {
    return this.sutAdapter.sendRequests({
      contract:        'voting',
      channel:         'voting-channel',
      fcn:             'GetElection',
      args:            [this.electionID],
      invokerIdentity: 'User1',
      readOnly:        true,
    });
  }
}

module.exports.createWorkloadModule = () => new GetElectionWorkload();
