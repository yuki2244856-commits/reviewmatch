import { createStripeApiHandler } from "../_shared/stripe-api-handler.ts";

Deno.serve(createStripeApiHandler());
