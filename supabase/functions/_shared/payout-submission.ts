// Keep the lease and the captured proof through the external effect and DB acknowledgement.
// Any error must retain the lease for explicit reconciliation, including a Stripe timeout.
export async function submitWithPayoutLease<T>(operations: {
  assertEvidence: () => Promise<void>;
  submit: () => Promise<T>;
  finish: (result: T) => Promise<void>;
}): Promise<T> {
  await operations.assertEvidence();
  const result = await operations.submit();
  await operations.assertEvidence();
  await operations.finish(result);
  return result;
}
