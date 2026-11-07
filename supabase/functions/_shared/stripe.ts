import Stripe from "npm:stripe@23.1.0";
import { createClient } from "npm:@supabase/supabase-js@2.99.0";

export function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}
// Values are read only inside the Edge runtime. Never return or log credentials.
export function services() {
  // Fail before any API call if this test-only deployment is misconfigured.
  if (required("STRIPE_MODE") !== "test") throw new Error("Test mode required");
  const credential = required("STRIPE_SECRET_KEY");
  if (!/^(sk|rk)_test_/.test(credential))
    throw new Error("Test-mode server credential required");
  return {
    stripe: new Stripe(credential, {
      apiVersion: "2026-10-28.endive",
      httpClient: Stripe.createFetchHttpClient(),
      maxNetworkRetries: 2,
    }),
    db: createClient(
      required("SUPABASE_URL"),
      required("SUPABASE_SERVICE_ROLE_KEY"),
      {
        auth: { persistSession: false, autoRefreshToken: false },
      },
    ),
  };
}
export function checked<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw new Error("Database operation failed");
  return result.data;
}
export function appOrigin(): string {
  const url = new URL(required("APP_ORIGIN"));
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1"
  ) {
    throw new Error("APP_ORIGIN requires HTTPS");
  }
  return url.origin;
}
export function cors() {
  return {
    "Access-Control-Allow-Origin": appOrigin(),
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: cors() });
}
export { Stripe };
