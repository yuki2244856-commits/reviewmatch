import { preparePayoutExtensions, withoutPgNet } from "./payout-extension-stubs.mjs";
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const db = new PGlite();
await db.exec(`
  create schema auth;
  create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
  create role anon; create role authenticated; create role service_role;
  create function auth.uid() returns uuid language sql as $$
    select nullif(current_setting('test.uid',true),'')::uuid
  $$;
  grant usage on schema auth to anon, authenticated;
  -- PGlite has no pg_cron worker. Stub only the registration call, not approval logic.
  create schema cron;
  create table cron.registered(name text, schedule text, command text);
  create function cron.schedule(text,text,text) returns bigint language sql as $$
    insert into cron.registered values ($1,$2,$3) returning 1::bigint
  $$;
`);
await preparePayoutExtensions(db);
const directory = new URL("../migrations/", import.meta.url);
let schemaAssertions = 0;
for (const file of (await readdir(directory))
  .filter((x) => x.endsWith(".sql"))
  .sort()) {
  let sql = withoutPgNet(await readFile(new URL(file, directory), "utf8"));
  sql = sql.replace(
    "create extension if not exists pg_cron;",
    "-- pg_cron registration stubbed locally",
  );
  if (file === "202611090003_contract_refunded_status.sql") {
    // Production initially had this constraint outside the migration chain.
    await db.exec(`
      alter table public.contracts
        add constraint contracts_status_check
        check (
          status in (
            '提示中', '辞退', '契約成立', '支払済（預かり中）',
            '納品済（検収中）', '修正依頼中', '完了'
          )
        );
    `);
    await assert.rejects(
      () => db.query("insert into contracts(status) values ('返金済み')"),
      /contracts_status_check/,
    );
    schemaAssertions++;
  }
  await db.exec(sql);
  if (file === "202611090003_contract_refunded_status.sql") {
    const definition = () =>
      db.query(`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'public.contracts'::regclass
        and conname = 'contracts_status_check'
    `);
    const before = await definition();
    // Reapplying after the equivalent production hotfix preserves its definition.
    await db.exec(sql);
    assert.deepEqual((await definition()).rows, before.rows);
    schemaAssertions++;
    await assert.rejects(
      () => db.query("insert into contracts(status) values ('unknown')"),
      /contracts_status_check/,
    );
    schemaAssertions++;
  }
}
const uid = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const buyer = uid(1),
  creator = uid(2),
  stranger = uid(3),
  job = uid(4);
let assertions = 0;
const equal = (a, b) => {
  assert.deepEqual(a, b);
  assertions++;
};
const denied = async (action, pattern) => {
  await assert.rejects(action, pattern);
  assertions++;
};
await db.exec("alter table auth.users disable trigger on_auth_user_created");
for (const [id, role] of [
  [buyer, "company"],
  [creator, "creator"],
  [stranger, "company"],
]) {
  await db.query("insert into auth.users(id) values ($1)", [id]);
  await db.query(
    "insert into profiles(id,role,status,email) values ($1,$2,'approved','fixture@example.test')",
    [id, role],
  );
}
await db.query(
  "insert into subscriptions(user_id,plan,status) values ($1,'プロ','有効')",
  [buyer],
);
await db.query(
  `insert into stripe_accounts(user_id,account_id,api_generation,card_payments_status,payout_interval,exclusive_payout_controls_verified_until)
  values ($1,'acct_creator','v2','active','manual','2099-01-01')`,
  [creator],
);
const actor = async (id) => {
  await db.exec("reset role; set role authenticated");
  await db.query("select set_config('test.uid',$1,false)", [id]);
};
const service = async () => {
  await db.exec("reset role");
};
async function seed(n, amount = 1000) {
  await service();
  const conversation = uid(100 + n),
    contract = uid(200 + n),
    application = uid(300 + n);
  // Independent jobs/applications preserve the real workflow uniqueness constraints.
  const ownJob = uid(400 + n);
  await db.query(
    "insert into jobs(id,company_id,title,status,role,priority) values ($1,$2,'Job','掲載中','SNS運用',true)",
    [ownJob, buyer],
  );
  await db.query(
    "insert into applications(id,job_id,creator_id) values ($1,$2,$3)",
    [application, ownJob, creator],
  );
  await db.query(
    "insert into conversations(id,job_id,company_id,creator_id,application_id) values ($1,$2,$3,$4,$5)",
    [conversation, ownJob, buyer, creator, application],
  );
  await db.query(
    `insert into contracts(id,job_id,conversation_id,company_id,creator_id,application_id,amount,status,deadline,deliverable)
    values ($1,$2,$3,$4,$5,$6,$7,'契約成立','2027-01-01','Video')`,
    [contract, ownJob, conversation, buyer, creator, application, amount],
  );
  return { contract, conversation };
}
async function pay(n, amount = 1000) {
  const c = await seed(n, amount);
  const intent = (
    await db.query("select (claim_project_intent($1,$2)).*", [
      c.contract,
      buyer,
    ])
  ).rows[0];
  const facts = amount
    ? {
        charge_id: `ch_${n}`,
        processing_fee_jpy: 40,
        paid_at: "2026-11-01",
        available_at: "2026-11-04",
        holding_deadline: "2027-01-30",
      }
    : {};
  await db.query("select apply_project_payment($1,1,$2,$3,$4,$5)", [
    `evt_${n}`,
    intent.id,
    `cs_${n}`,
    `pi_${n}`,
    JSON.stringify(facts),
  ]);
  return { ...c, intent, facts };
}
async function transition(contract, status, values = {}) {
  const old = (
    await db.query("select status from contracts where id=$1", [contract])
  ).rows[0].status;
  return db.query("select apply_reviewmatch_workflow($1::jsonb)", [
    JSON.stringify([
      {
        table: "contracts",
        id: contract,
        insert: false,
        previous_status: old,
        values: { status, ...values },
      },
    ]),
  ]);
}
const status = async (id) =>
  (await db.query("select status from contracts where id=$1", [id])).rows[0]
    .status;
const held = async (id) =>
  (
    await db.query("select * from stripe_held_orders where contract_id=$1", [
      id,
    ])
  ).rows[0];
const one = await pay(1);
equal(one.intent.application_fee_jpy, 150);
equal(one.intent.gross_jpy, 1150); // Priority fee deliberately excluded.
equal(await status(one.contract), "支払済（預かり中）");
await db.query("select apply_project_payment($1,1,$2,$3,$4,$5)", [
  "evt_1",
  one.intent.id,
  "cs_1",
  "pi_1",
  JSON.stringify(one.facts),
]);
await db.query("select apply_project_payment($1,1,$2,$3,$4,$5)", [
  "evt_replay",
  one.intent.id,
  "cs_1",
  "pi_1",
  JSON.stringify(one.facts),
]);
equal(
  (await db.query("select count(*)::int n from stripe_held_orders")).rows[0].n,
  1,
);
equal(
  (
    await db.query(
      "select count(*)::int n from messages where conversation_id=$1",
      [one.conversation],
    )
  ).rows[0].n,
  1,
);
equal((await held(one.contract)).net_jpy, 960);
await actor(stranger);
equal(
  (await db.query("select count(*)::int n from stripe_project_intents")).rows[0]
    .n,
  0,
);
await denied(
  () => db.query("select sync_project_review($1,false)", [one.contract]),
  /participant/,
);
await denied(
  () => db.query("update stripe_project_intents set state='paid'"),
  /permission denied/,
);
await denied(
  () => db.query("select complete_project_reviews()"),
  /permission denied/,
);
await actor(buyer);
await denied(
  () => db.query("select sync_project_review($1,false)", [one.contract]),
  /participant/,
);
await actor(creator);
await transition(one.contract, "納品済（検収中）", {
  delivery_url: "https://example.test/delivery",
  delivery_message: "Video",
});
const delivered = (
  await db.query("select delivery_at from contracts where id=$1", [
    one.contract,
  ])
).rows[0].delivery_at;
equal((await held(one.contract)).delivered_at, delivered);
await db.query("select sync_project_review($1,false)", [one.contract]);
await denied(
  () => db.query("select sync_project_review($1,true)", [one.contract]),
  /participant/,
);
await actor(buyer);
await transition(one.contract, "修正依頼中");
equal((await held(one.contract)).revision_requested, true);
await db.query("select sync_project_review($1,true)", [one.contract]);
await service();
equal(
  (await db.query("select complete_project_reviews('2026-12-01') n")).rows[0].n,
  0,
);
await actor(creator);
await transition(one.contract, "納品済（検収中）", {
  delivery_url: "https://example.test/revised",
  delivery_message: "Revised",
});
equal((await held(one.contract)).revision_requested, false);
await actor(buyer);
await denied(() => transition(one.contract, "完了"), /Valid Stripe ledger/);
await db.query("select approve_held_order($1)", [one.intent.id]);
await db.query("select approve_held_order($1)", [one.intent.id]);
await transition(one.contract, "完了");
equal(await status(one.contract), "完了");
await service();
equal((await db.query("select count(*)::int n from payments")).rows[0].n, 0);
equal((await db.query("select count(*)::int n from payouts")).rows[0].n, 0);
const demo = await seed(2);
await actor(buyer);
await denied(
  () => transition(demo.contract, "支払済（預かり中）"),
  /Contract payment required/,
);
const automatic = await pay(3);
await actor(creator);
await transition(automatic.contract, "納品済（検収中）", {
  delivery_url: "https://example.test/delivery",
  delivery_message: "Auto",
});
await service();
// Only the clock is controlled here. Trigger synchronization and completion remain real SQL.
await db.query(
  "update contracts set delivery_at='2026-11-01',review_deadline='2026-11-03' where id=$1",
  [automatic.contract],
);
await db.query(
  "update stripe_held_orders set delivered_at='2026-11-01' where contract_id=$1",
  [automatic.contract],
);
equal((await db.query("select auto_approve_expired_reviews() n")).rows[0].n, 0);
equal(
  (await db.query("select complete_project_reviews('2026-11-02T23:59:59Z') n"))
    .rows[0].n,
  0,
);
equal(
  (await db.query("select complete_project_reviews('2026-11-03') n")).rows[0].n,
  1,
);
equal(await status(automatic.contract), "完了");
equal(
  new Date((await held(automatic.contract)).due_on).toISOString().slice(0, 10),
  "2026-12-31",
);
equal(
  (await db.query("select complete_project_reviews('2026-11-04') n")).rows[0].n,
  0,
);
equal(
  (
    await db.query(
      "select count(*)::int n from messages where conversation_id=$1 and body like '48時間%'",
      [automatic.conversation],
    )
  ).rows[0].n,
  1,
);
equal(
  (
    await db.query(
      "select count(*)::int n from cron.registered where name='reviewmatch-project-auto-approval' and schedule='0 * * * *' and command='select public.complete_project_reviews();'",
    )
  ).rows[0].n,
  1,
);
const refunded = await pay(4);
await db.query("select request_held_refund($1)", [refunded.intent.id]);
await db.query("select request_held_refund($1)", [refunded.intent.id]);
equal((await held(refunded.contract)).state, "refund_pending");
await db.query(
  "select apply_project_charge_state('evt_refund',5,$1,'refunded')",
  [refunded.intent.id],
);
equal(await status(refunded.contract), "返金済み");
await db
  .query("update contracts set status='納品済（検収中）' where id=$1", [
    refunded.contract,
  ])
  .catch(() => {});
// Test the ledger directly in an allowed transition from a synthetic service-set review state.
await db.exec(
  "alter table contracts disable trigger sync_project_review_transition",
);
await db.query("update contracts set status='納品済（検収中）' where id=$1", [
  refunded.contract,
]);
await db.exec(
  "alter table contracts enable trigger sync_project_review_transition",
);
await actor(buyer);
await denied(
  () => transition(refunded.contract, "完了"),
  /Valid Stripe ledger/,
);
const fee = await pay(5, 0);
equal(await held(fee.contract), undefined);
await actor(creator);
await transition(fee.contract, "納品済（検収中）", {
  delivery_url: "https://example.test/product",
  delivery_message: "Product",
});
await actor(buyer);
await db.query("select approve_project_fee($1)", [fee.contract]);
await transition(fee.contract, "完了");
equal(await status(fee.contract), "完了");
await service();
equal((await db.query("select count(*)::int n from payouts")).rows[0].n, 0);
// Expiry preserves history while admitting a fresh intent; mismatched session cannot expire it.
const retry = await seed(6);
const first = (
  await db.query("select (claim_project_intent($1,$2)).*", [
    retry.contract,
    buyer,
  ])
).rows[0];
await db.query("select attach_project_session($1,'cs_old')", [first.id]);
await db.query("select expire_project_intent($1,'cs_wrong')", [first.id]);
equal(
  (
    await db.query("select (claim_project_intent($1,$2)).id", [
      retry.contract,
      buyer,
    ])
  ).rows[0].id,
  first.id,
);
await db.query("select expire_project_intent($1,'cs_old')", [first.id]);
const second = (
  await db.query("select (claim_project_intent($1,$2)).*", [
    retry.contract,
    buyer,
  ])
).rows[0];
assert.notEqual(first.id, second.id);
assertions++;
// A replaced/expired network lease cannot commit stale Stripe state.
const key = "project:acct_creator";
const token = (await db.query("select claim_stripe_resource($1) token", [key]))
  .rows[0].token;
await denied(
  () =>
    db.query("select finish_project_event($1,$2,'expire',$3)", [
      key,
      uid(999),
      JSON.stringify({ p_intent_id: second.id, p_session_id: "cs_new" }),
    ]),
  /lease/,
);
await db.query("select release_stripe_resource($1,$2)", [key, token]);
// Delivered orders cannot enter the cancellation path, even through the service RPC.
await denied(
  () => db.query("select request_held_refund($1)", [one.intent.id]),
  /pre-delivery/,
);
const disputed = await pay(7);
await db.query(
  "select apply_project_charge_state('evt_dispute',7,$1,'disputed')",
  [disputed.intent.id],
);
equal((await held(disputed.contract)).state, "disputed");
equal(await status(disputed.contract), "支払済（預かり中）");
await db.query("select apply_project_charge_state('evt_won',8,$1,'held')", [
  disputed.intent.id,
]);
equal((await held(disputed.contract)).state, "held");
await db.query("select apply_project_charge_state('evt_lost',9,$1,'blocked')", [
  disputed.intent.id,
]);
await db.query(
  "select apply_project_charge_state('evt_late_won',10,$1,'held')",
  [disputed.intent.id],
);
equal((await held(disputed.contract)).state, "blocked");
const automaticFee = await pay(8, 0);
await actor(creator);
await transition(automaticFee.contract, "納品済（検収中）", {
  delivery_url: "https://example.test/free",
  delivery_message: "Fee only",
});
await service();
await db.query(
  "update contracts set delivery_at='2026-11-01',review_deadline='2026-11-03' where id=$1",
  [automaticFee.contract],
);
equal((await db.query("select auto_approve_expired_reviews() n")).rows[0].n, 0);
equal(
  (await db.query("select complete_project_reviews('2026-11-03') n")).rows[0].n,
  1,
);
equal(await status(automaticFee.contract), "完了");
equal((await db.query("select count(*)::int n from payouts")).rows[0].n, 0);
// A valid lease commits the event and payment atomically; direct service calls
// to the internal reducer remain denied.
const fenced = await seed(9);
const fencedIntent = (
  await db.query("select (claim_project_intent($1,$2)).*", [
    fenced.contract,
    buyer,
  ])
).rows[0];
const lease = (await db.query("select claim_stripe_resource($1) token", [key]))
  .rows[0].token;
await db.query("select finish_project_event($1,$2,'payment',$3)", [
  key,
  lease,
  JSON.stringify({
    p_event_id: "evt_fenced",
    p_created: 11,
    p_intent_id: fencedIntent.id,
    p_session_id: "cs_fenced",
    p_payment_id: "pi_fenced",
    p_facts: {
      charge_id: "ch_fenced",
      processing_fee_jpy: 40,
      paid_at: "2026-11-01",
      available_at: "2026-11-04",
      holding_deadline: "2027-01-30",
    },
  }),
]);
equal(await status(fenced.contract), "支払済（預かり中）");
await db.exec("set role service_role");
await denied(
  () =>
    db.query("select apply_project_charge_state('evt_direct',1,$1,'held')", [
      fencedIntent.id,
    ]),
  /permission denied/,
);
await service();
await db.query("select release_stripe_resource($1,$2)", [key, lease]);
console.log(
  `PASS: project payments ${assertions} assertions and ${schemaAssertions} schema upgrade assertions: actual ledger/replay, RLS, delivery/revision, manual/automatic approval, zero-amount fee, refund, expiry, lease fencing, cron and demo isolation`,
);
await db.close();
