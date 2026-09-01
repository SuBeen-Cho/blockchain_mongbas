'use strict';

async function submitTransactionAndWait(contract, transactionName, argumentsList) {
  const proposal = contract.newProposal(transactionName, { arguments: argumentsList });
  const transaction = await proposal.endorse();
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
