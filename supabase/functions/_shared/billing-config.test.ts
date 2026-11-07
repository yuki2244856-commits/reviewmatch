import {
  assertReviewMatchAccount,
  STRIPE_ACCOUNT_ID,
} from "./billing-config.ts";

Deno.test(
  "account guard accepts the ReviewMatch platform without an account override",
  async () => {
    let calls = 0;
    await assertReviewMatchAccount({
      accounts: {
        retrieve: async (...args: unknown[]) => {
          if (args.length !== 1 || args[0] !== null)
            throw new Error("Unexpected account override");
          calls++;
          return { id: STRIPE_ACCOUNT_ID };
        },
      },
    });
    if (calls !== 1) throw new Error("Platform was not checked");
  },
);

Deno.test("account guard rejects a different platform", async () => {
  try {
    await assertReviewMatchAccount({
      accounts: { retrieve: async () => ({ id: "acct_other_platform" }) },
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Stripe platform account mismatch"
    )
      return;
    throw error;
  }
  throw new Error("Different platform was accepted");
});

Deno.test("account guard fails closed when platform lookup fails", async () => {
  const failure = new Error("Account lookup unavailable");
  try {
    await assertReviewMatchAccount({
      accounts: {
        retrieve: async () => {
          throw failure;
        },
      },
    });
  } catch (error) {
    if (error === failure) return;
    throw error;
  }
  throw new Error("Unavailable platform lookup was accepted");
});
