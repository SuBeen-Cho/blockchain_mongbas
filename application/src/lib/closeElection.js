'use strict';

async function readElectionStatus(contract, electionID) {
  const encoded = await contract.evaluateTransaction('GetElection', electionID);
  const election = JSON.parse(Buffer.from(encoded).toString('utf8'));
  return election.status;
}

async function closeAndAggregateElection(contract, electionID) {
  const initialStatus = await readElectionStatus(contract, electionID);
  if (!['ACTIVE', 'CLOSED'].includes(initialStatus)) {
    throw new Error(`election must be ACTIVE or CLOSED before aggregation (status=${initialStatus || 'unknown'})`);
  }

  let closeRecoveredAfterError = false;
  if (initialStatus === 'ACTIVE') {
    try {
      await contract.submitTransaction('CloseElection', electionID);
    } catch (error) {
      // A Gateway deadline can expire after the transaction has committed. Reconcile
      // against ledger state before deciding whether retrying would be safe.
      const reconciledStatus = await readElectionStatus(contract, electionID);
      if (reconciledStatus !== 'CLOSED') throw error;
      closeRecoveredAfterError = true;
    }
  }

  await contract.submitTransaction('AggregateClosedElection', electionID);
  return {
    closeAlreadyCommitted: initialStatus === 'CLOSED',
    closeRecoveredAfterError,
  };
}

module.exports = { closeAndAggregateElection, readElectionStatus };
