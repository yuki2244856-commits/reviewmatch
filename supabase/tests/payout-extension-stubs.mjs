// PGlite has no extension workers. Only the cron/network/Vault boundaries are
// stubbed; the migration's SQL, privileges and no-secret branch run unchanged.
export async function preparePayoutExtensions(db) {
  await db.exec(`
    alter table cron.registered add column jobid bigserial;
    create view cron.job as
      select jobid, name as jobname, schedule, command from cron.registered;
    create function cron.unschedule(bigint) returns boolean language sql as $$
      with removed as (delete from cron.registered where jobid = $1 returning *)
      select exists(select 1 from removed)
    $$;
    create schema vault;
    create table vault.decrypted_secrets(name text, decrypted_secret text);
    create schema net;
    create table net.requests(url text, headers jsonb, body jsonb, timeout_milliseconds integer);
    create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer)
      returns bigint language sql as $$
      insert into net.requests values ($1,$2,$3,$4) returning 1::bigint
    $$;
  `);
}

export function withoutPgNet(sql) {
  return sql.replace(
    "create extension if not exists pg_net;",
    "-- pg_net boundary stubbed locally",
  );
}
