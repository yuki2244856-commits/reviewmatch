// Claim before retrieving Stripe state. A busy/expired lease fails the webhook for retry.
// Injected operations keep the ordering protocol testable without remote services.
export async function serializedResourceEvent<T>(operations: {
  claim: () => Promise<string>;
  retrieve: () => Promise<T>;
  apply: (token: string, state: T) => Promise<void>;
  release: (token: string) => Promise<void>;
}): Promise<void> {
  const token = await operations.claim();
  try {
    const latest = await operations.retrieve();
    await operations.apply(token, latest);
  } finally {
    await operations.release(token);
  }
}
