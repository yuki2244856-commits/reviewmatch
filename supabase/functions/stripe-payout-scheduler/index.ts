import { createPayoutSchedulerHandler } from "../_shared/payout-scheduler.ts";

Deno.serve(createPayoutSchedulerHandler());
