import { required } from "./stripe.ts";

export async function readPayoutResponse(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

// Server-only: neither caller returns the authorization header to the browser.
export async function callPayoutWorker(accountId: string) {
  const response = await fetch(
    `${required("SUPABASE_URL")}/functions/v1/stripe-payout-worker`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${required("PAYOUT_WORKER_TOKEN")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accountId }),
    },
  );
  return { status: response.status, body: await readPayoutResponse(response) };
}
