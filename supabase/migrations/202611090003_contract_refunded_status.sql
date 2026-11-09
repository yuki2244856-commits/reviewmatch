begin;

alter table public.contracts
  drop constraint if exists contracts_status_check;

alter table public.contracts
  add constraint contracts_status_check
  check (
    status in (
      '提示中',
      '辞退',
      '契約成立',
      '支払済（預かり中）',
      '納品済（検収中）',
      '修正依頼中',
      '完了',
      '返金済み'
    )
  );

commit;
