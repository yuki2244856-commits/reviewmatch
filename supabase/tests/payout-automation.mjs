import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  preparePayoutExtensions,
  withoutPgNet,
} from "./payout-extension-stubs.mjs";

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create function public.is_admin() returns boolean language sql as $$
    select coalesce(current_setting('test.admin', true), '') = 'true'
  $$;
  create schema cron;
  create table cron.registered(name text, schedule text, command text);
  create function cron.schedule(text,text,text) returns bigint language sql as $$
    insert into cron.registered values ($1,$2,$3) returning 1::bigint
  $$;
`);
await preparePayoutExtensions(db);
// Duplicate old registrations must all be replaced by one deterministic job.
await db.exec(`insert into cron.registered values
  ('reviewmatch-payout-scheduler','old','old'),
  ('reviewmatch-payout-scheduler','old','old');`);
const sql = await readFile(
  new URL("../migrations/202611100002_payout_automation.sql", import.meta.url),
  "utf8",
);
assert.match(sql, /create extension if not exists pg_net;/);
await db.exec(withoutPgNet(sql));
let assertions = 1;
const equal = (actual, expected) => {
  assert.deepEqual(actual, expected);
  assertions++;
};
equal(
  (await db.query(
    `select relrowsecurity from pg_class where oid='stripe_payout_schedule_runs'::regclass`,
  )).rows[0].relrowsecurity,
  true,
);
const policies = (await db.query(
  `select cmd, qual from pg_policies where tablename='stripe_payout_schedule_runs'`,
)).rows;
equal(policies.length, 1);
equal(policies[0].cmd, "SELECT");
assert.match(policies[0].qual, /is_admin\(\)/);
assertions++;
for (const role of ["anon", "authenticated"]) {
  equal(
    (await db.query(
      `select has_function_privilege($1, 'run_scheduled_payouts()', 'EXECUTE') allowed`,
      [role],
    )).rows[0].allowed,
    false,
  );
}
equal(
  (await db.query(
    `select prosecdef, proconfig from pg_proc where oid='run_scheduled_payouts()'::regprocedure`,
  )).rows[0],
  { prosecdef: true, proconfig: ['search_path=""'] },
);
await db.exec("select public.run_scheduled_payouts()");
equal(
  (await db.query("select count(*)::int n from net.requests")).rows[0].n,
  0,
);
equal(
  (await db.query("select name,schedule,command from cron.registered")).rows,
  [{
    name: "reviewmatch-payout-scheduler",
    schedule: "0 0 * * *",
    command: "select public.run_scheduled_payouts();",
  }],
);
// Re-run registration block to verify idempotence without recreating the table.
await db.exec(sql.slice(sql.indexOf("do $$")));
equal(
  (await db.query("select count(*)::int n from cron.registered")).rows[0].n,
  1,
);
await db.exec(
  `grant select, insert, update, delete on stripe_payout_schedule_runs to authenticated;
  insert into stripe_payout_schedule_runs(account_id,phase,status) values ('acct_example','reconcile','skipped');
  set role authenticated;`,
);
equal(
  (await db.query("select * from stripe_payout_schedule_runs")).rows.length,
  0,
);
await db.exec("set test.admin='true'");
equal(
  (await db.query("select * from stripe_payout_schedule_runs")).rows.length,
  1,
);
await assert.rejects(
  () =>
    db.exec(
      "insert into stripe_payout_schedule_runs(account_id,phase,status) values ('acct_other','worker','ok')",
    ),
  /row-level security/,
);
assertions++;
equal(
  (await db.query(
    "update stripe_payout_schedule_runs set status='error' returning id",
  )).rows.length,
  0,
);
equal(
  (await db.query("delete from stripe_payout_schedule_runs returning id")).rows
    .length,
  0,
);
await db.exec("reset role");
const schedulerToken = randomUUID();
await db.query(
  "insert into vault.decrypted_secrets values ('payout_scheduler_token', $1)",
  [schedulerToken],
);
await db.exec("select public.run_scheduled_payouts()");
const requests = (await db.query("select * from net.requests")).rows;
equal(requests.length, 1);
equal(
  requests[0].url,
  "https://kcgxyqfwwhcvjhizootc.supabase.co/functions/v1/stripe-payout-scheduler",
);
equal(requests[0].headers, {
  Authorization: `Bearer ${schedulerToken}`,
  "Content-Type": "application/json",
});
equal(requests[0].body, {});
equal(requests[0].timeout_milliseconds, 120000);
console.log(
  `PASS: payout automation ${assertions} assertions (RLS, privileges, no-secret no-op, cron idempotence)`,
);
await db.close();
