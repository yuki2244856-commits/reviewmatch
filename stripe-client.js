/* Hosted Checkout redirects do not require Stripe.js or the publishable key.
 * The public key is retained in stripe-config.js for a future Payment Element.
 * Never put any server-side credential in this file.
 */
window.ReviewMatchStripe = Object.freeze({
  get enabled() {
    return window.REVIEWMATCH_STRIPE_CONFIG?.enabled === true;
  },
  async redirect(client, action, extra = {}) {
    const {
      data: { session },
      error: authError,
    } = await client.auth.getSession();
    if (authError || !session) throw new Error("ログインしてください。");
    const { data, error } = await client.functions.invoke("stripe-api", {
      body: { ...extra, action },
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (error) {
      let message =
        "Stripe に接続できませんでした。時間をおいて再度お試しください。";
      try {
        message = (await error.context.json()).error || message;
      } catch {
        /* no JSON response */
      }
      throw new Error(message);
    }
    const url = new URL(data?.url);
    if (
      url.protocol !== "https:" ||
      ![
        "checkout.stripe.com",
        "billing.stripe.com",
        "connect.stripe.com",
      ].includes(url.hostname)
    ) {
      throw new Error("決済先を確認できませんでした。");
    }
    window.location.assign(url.href);
  },
});
