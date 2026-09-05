'use strict';

async function submitTransactionAndWait(contract, transactionName, argumentsList, options = {}) {
  const proposalOptions = { arguments: argumentsList };
  if (options.transientData) proposalOptions.transientData = options.transientData;
  const retry = options.endorsementRetry;
  const retryObservation = options.endorsementRetryObservation;
  if (retryObservation !== undefined &&
      (!retryObservation || typeof retryObservation !== 'object' || Array.isArray(retryObservation))) {
    throw new Error('endorsementRetryObservation must be an object');
  }
  let retryIndex = 0;
  let transaction;
  while (!transaction) {
    const proposal = contract.newProposal(transactionName, proposalOptions);
    try {
      transaction = await proposal.endorse();
    } catch (error) {
      const canRetry = retry && retryIndex < retry.maxRetries && retry.shouldRetry(error, {
        transactionName,
        retryIndex,
      });
      if (!canRetry) throw error;
      const delayMs = retry.delayMs(retryIndex);
      retryIndex += 1;
      if (retryObservation) {
        retryObservation.count = retryIndex;
        retryObservation.totalDelayMs = (retryObservation.totalDelayMs || 0) + delayMs;
      }
      await retry.sleep(delayMs);
    }
  }
  const result = transaction.getResult();
  const submitted = await transaction.submit();
  const status = await submitted.getStatus();
  if (!status.successful) {
    const error = new Error(`${transactionName} commit failed with status ${status.code}`);
    error.code = 'FABRIC_COMMIT_FAILED';
    error.commitStatus = status.code;
    throw error;
  }
  return result;
}

module.exports = { submitTransactionAndWait };
