import { heldProjectPaymentsEnabled } from "./held-payouts.ts";
import { payoutReconcile } from "./payout-reconcile.ts";
import {
  callPayoutWorker,
  readPayoutResponse,
} from "./payout-worker-client.ts";
import { checked, json, services } from "./stripe.ts";

type RunResult = {
  accountId: string;
  phase: "reconcile" | "worker";
  status: "ok" | "error" | "skipped";
  detail: unknown;
};

export function createPayoutSchedulerHandler(dependencies = {
  services,
  reconcile: payoutReconcile,
  worker: callPayoutWorker,
  now: () => new Date(),
  billingEnabled: () => Deno.env.get("STRIPE_BILLING_ENABLED") === "true",
  heldEnabled: heldProjectPaymentsEnabled,
  token: () => Deno.env.get("PAYOUT_SCHEDULER_TOKEN"),
}) {
  return async (req: Request) => {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }
    const token = dependencies.token();
    if (!token || req.headers.get("authorization") !== `Bearer ${token}`) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (!dependencies.billingEnabled() || !dependencies.heldEnabled()) {
      return json(
        { error: "Held payouts disabled: local report-only starter" },
        409,
      );
    }
    try {
      const context = dependencies.services();
      const { db } = context;
      const ranAt = dependencies.now().toISOString();
      const today = new Date(Date.parse(ranAt) + 9 * 3600000)
        .toISOString().slice(0, 10);
      const dueAccounts = new Set<string>();
      for (let offset = 0;; offset += 1000) {
        const orders = checked(
          await db.from("stripe_held_orders").select("id,account_id")
            .eq("state", "held").not("approved_at", "is", null)
            .lte("due_on", today).order("id").range(offset, offset + 999),
        );
        if (!orders) throw new Error("Missing due ledger page");
        for (const order of orders) dueAccounts.add(order.account_id);
        if (orders.length < 1000) break;
      }
      const accountIds: string[] = [];
      for (let offset = 0;; offset += 1000) {
        const accounts = checked(
          await db.from("stripe_accounts").select("account_id")
            .eq("api_generation", "v2").eq("payout_interval", "manual")
            .order("account_id").range(offset, offset + 999),
        );
        if (!accounts) throw new Error("Missing account page");
        for (const account of accounts) {
          if (dueAccounts.has(account.account_id)) {
            accountIds.push(account.account_id);
          }
        }
        if (accounts.length < 1000) break;
      }
      const results: RunResult[] = [];
      for (const accountId of accountIds) {
        let phase: RunResult["phase"] = "reconcile";
        let result: RunResult;
        try {
          const response = await dependencies.reconcile(context, accountId);
          const body = await readPayoutResponse(response);
          if (response.status !== 200) {
            result = {
              accountId,
              phase,
              status: "error",
              detail: { status: response.status, ...body },
            };
          } else if (body.eligibleTotalJpy === 0) {
            result = { accountId, phase, status: "skipped", detail: body };
          } else {
            phase = "worker";
            const worker = await dependencies.worker(accountId);
            result = {
              accountId,
              phase,
              status: worker.status === 200 ? "ok" : "error",
              detail: { status: worker.status, ...worker.body },
            };
          }
        } catch {
          // Do not persist exception messages that may contain server credentials.
          result = {
            accountId,
            phase,
            status: "error",
            detail: { error: "Payout phase failed" },
          };
        }
        try {
          checked(
            await db.from("stripe_payout_schedule_runs").insert({
              account_id: result.accountId,
              phase: result.phase,
              status: result.status,
              detail: result.detail,
            }),
          );
        } catch {
          result = {
            ...result,
            status: "error",
            detail: {
              result: result.detail,
              error: "Run history could not be recorded",
            },
          };
        }
        results.push(result);
      }
      return json({ ranAt, results });
    } catch {
      return json({ error: "Payout scheduler failed" }, 500);
    }
  };
}
