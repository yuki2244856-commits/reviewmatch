import { serializedResourceEvent } from "./resource-event.ts";
import { submitWithPayoutLease } from "./payout-submission.ts";
function assert(value: unknown) {
  if (!value) throw new Error("Assertion failed");
}
async function rejects(action: () => Promise<unknown>) {
  let failed = false;
  try {
    await action();
  } catch {
    failed = true;
  }
  assert(failed);
}
Deno.test("resource lease spans fresh retrieval; contender retries and fetches latest state", async () => {
  let held = false;
  let upstream = "old";
  let stored = "";
  let wake!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const run = (wait: boolean) =>
    serializedResourceEvent({
      claim: async () => {
        if (held) throw new Error("busy");
        held = true;
        return "token";
      },
      retrieve: async () => {
        const value = upstream;
        if (wait) {
          entered();
          await gate;
        }
        return value;
      },
      apply: async (_token, state) => {
        stored = state;
      },
      release: async () => {
        held = false;
      },
    });
  const first = run(true);
  await ready;
  upstream = "latest";
  await rejects(() => run(false));
  wake();
  await first;
  await run(false);
  assert(stored === "latest" && !held);
});
Deno.test("failed retrieve releases resource lease without applying", async () => {
  let released = false;
  let applied = false;
  await rejects(() =>
    serializedResourceEvent({
      claim: async () => "token",
      retrieve: async () => {
        throw new Error("Stripe unavailable");
      },
      apply: async () => {
        applied = true;
      },
      release: async () => {
        released = true;
      },
    })
  );
  assert(released && !applied);
});
Deno.test("payout asserts proof before and after Stripe and only then acknowledges", async () => {
  const trace: string[] = [];
  await submitWithPayoutLease({
    assertEvidence: async () => {
      trace.push("proof");
    },
    submit: async () => {
      trace.push("Stripe");
      return "po_1";
    },
    finish: async (id) => {
      trace.push(id);
    },
  });
  assert(trace.join() === "proof,Stripe,proof,po_1");
});
for (const failAt of [1, 2]) {
  Deno.test(`expired or changed payout evidence at check ${failAt} stops progress`, async () => {
    let checks = 0, submissions = 0, finishes = 0;
    await rejects(() =>
      submitWithPayoutLease({
        assertEvidence: async () => {
          if (++checks === failAt) throw new Error("expired");
        },
        submit: async () => {
          submissions++;
          return "po_1";
        },
        finish: async () => {
          finishes++;
        },
      })
    );
    assert(submissions === failAt - 1 && finishes === 0);
  });
}
Deno.test("ambiguous Stripe outcome never advances or releases the worker", async () => {
  let finishes = 0, checks = 0;
  await rejects(() =>
    submitWithPayoutLease({
      assertEvidence: async () => {
        checks++;
      },
      submit: async () => {
        throw new Error("timeout after request");
      },
      finish: async () => {
        finishes++;
      },
    })
  );
  assert(checks === 1 && finishes === 0);
});
