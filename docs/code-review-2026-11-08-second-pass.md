# ReviewMatch 全体レビュー：第2回・独立ダブルチェック

- **レビュー日：2026-11-08（JST）**
- **対象：PR #27 マージ直後の main、`1d29aad17b7d9658ade756a1c629a29297414aee`**。取得時の main と一致。
- 前回資料：`docs/code-review-main-2026-11-08.md`。前回の33件をそのまま再掲せず、最終ソースと実 SQL を再確認した。
- **成果物は本レポートのみ。コード・マイグレーション・設定は変更していない。**

## 結果

**残存問題は12件：高3件・中8件・低1件。** うち S09・S10 は無効な Stripe スターターの有効化前制約で、既知の判断事項を含む。S05 もデモの無料なプラン切替そのものを課金回避とは評価していない。

特に重要なのは、**原子 RPC は処理の一括成功・失敗を保証するが、契約の業務上正しい遷移や権限を保証するものではない**点。登録者が自分を管理者にできる RLS と、第三者が公開案件を書き換えられる RLS は、Stripe ゲートとは無関係に成立する。

### 確認範囲と証拠の読み方

`app.js`、Stripe フロント2ファイル、Edge Functions 全5入口と `_shared`、全14 SQL、HTML・関連ドキュメントと既存テストを確認した。`STRIPE_BILLING_ENABLED` は未設定／オフ、`HELD_PROJECT_PAYMENTS_ENABLED=false` のまま扱った。

以下の DB 再現は、既存 `supabase/tests/review-batch-two.mjs` と同様に、隔離 PGlite に Auth の最小スタブと全14 SQLを番号順に適用し、`SET ROLE authenticated` と `auth.uid()` のテスト用設定で行った。**認可に関する再現は管理者権限を持つ DB 接続のままではなく、一般利用者ロールへ切り替えて実施した。** S01 の昇格を各再現の前提にはしていない。

**本番DBの脆弱性を実証したものではない。** ベースラインに記録された RLS／GRANT と新規環境での再現は確定できるが、既存環境には未記録の列権限・トリガー等がある可能性がある。既存環境で `202611010000` を実行してはならない。既存環境への影響判定は、該当する実適用済み DDL との比較が必要。本レビューでは実DBに接続していない。

シークレットファイル、環境の秘密値、Stripe Dashboard・実アカウントにはアクセスしていない。決済・返金・出金、リモート SQL 適用、デプロイ、有効化は実行していない。ブラウザー試験の Auth/REST はローカル fixture で遮断・模擬した。

## 指摘一覧

| ID | 重大度 | 概要 | ゲートオフでの影響 |
| --- | --- | --- | --- |
| S01 | **高** | 自分の `profiles.role/status` を更新し管理者・承認済みへ昇格できる | ベースラインの認可が迂回可能 |
| S02 | **高** | 公開案件を無関係な利用者が更新でき、所有者も変更できる | 公開内容・所有関係の改ざん |
| S03 | **高** | 契約遷移・金額・支払い・報酬の整合性がクライアント任せ | デモ台帳・契約の偽造、cron による不整合の確定 |
| S04 | 中 | UPDATE で作成日時を戻すと R21 の掲載上限を迂回できる | フリーでも同月に繰り返し作成可能 |
| S05 | 中 | R21/R22 が有効性を確認せず、変更可能なデモプランだけを信頼 | 失効プランでも上限緩和・優先掲載。Stripe 権利とも未接続 |
| S06 | 中 | 会話参加者が相手のメッセージ本文・送信者等を変更できる | 会話・合意内容の偽造 |
| S07 | 中 | クリエイターが自分の認定バッジを付与できる | 公開される審査結果を偽造 |
| S08 | 中 | R28 の同秒 ID 比較が再取得した最新状態も捨てる | Webhook はゲートオフでも動く。既存状態の同期漏れ |
| S09 | 中 | 税込 Price 前提が API の検証対象になっていない | 現状課金なし。有効化前の設定整合性不足 |
| S10 | 中 | 無条件の30日トライアルが登録日起算・再申込資格と一致しない | 現状課金なし。既知の有効化前制約 |
| S11 | 中 | 募集締切 NULL の1案件で一覧全体が描画失敗する | 公開カタログの可用性低下 |
| S12 | 低 | 完了は終端なのにチャット UI が再提示を禁止し続ける | 正規画面から次の契約を提示できない |

以下のソースリンクはすべて上記固定コミットを指す。

## 詳細

### S01【高】本人更新で管理者ロール・承認状態を変更できる

**場所：** [base_schema.sql:204–205](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611010000_base_schema.sql#L204)、[同:174–180](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611010000_base_schema.sql#L174)、[同:282–283](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611010000_base_schema.sql#L282)。

**根拠・再現：** `profiles` にテーブル単位の UPDATE があり、`profiles_update` は本人の `id` だけで許可する。pending の登録者として次の更新が成功し、直後の `is_admin()` は true になった。

```sql
-- 認証済み本人のロールで実行
UPDATE public.profiles SET role = 'admin', status = 'approved'
WHERE id = auth.uid();
SELECT public.is_admin(); -- true
```

`WITH CHECK` を省略した UPDATE は同じ条件を新行にも適用するが、`id` を変更していないため防御にならない。登録トリガーの role 検証も登録後の UPDATE を防げない。管理者用の各 RLS、他ユーザー情報の参照・更新等へ波及する。前回 R19 で未確認だった自己昇格を、記録された DDL で具体的に再現した。

**修正の方向性：** 本人が更新できる列を表示名等に限定し、role/status/review_note を管理者または専用の認可 RPC に分離する。`USING` と `WITH CHECK` の両方を設計し、一般利用者による昇格を実 SQL で拒否する。既存環境は実 DDL を確認したうえで追加マイグレーションで修正する。

### S02【高】公開案件の UPDATE が全認証利用者に開かれている

**場所：** [base_schema.sql:213](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611010000_base_schema.sql#L213)、[同:264–267](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611010000_base_schema.sql#L264)。

**根拠・再現：** `jobs_update` に SELECT と同じ `status = '掲載中'` 条件がある。別会社の掲載中案件に対し、一般クリエイターが `UPDATE jobs SET title='tampered' WHERE id=...` を実行して成功した。掲載中を維持すれば暗黙の新行チェックも通る。テーブル UPDATE は `company_id` も対象なので、所有者の変更も防げない。S01 の昇格は不要。

**修正の方向性：** 公開 SELECT と所有者／運営の UPDATE 条件を分離する。所有者・作成日時等を不変にし、掲載審査の status は運営のみ変更できるようにする。自社の案件でも INSERT の status を自由指定して審査を省略できる点を併せて閉じる。

### S03【高】原子性・CAS はあるが、契約と金銭台帳の業務ルールをサーバーで強制しない

**場所：** [atomic_workflow.sql:14–25](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611080001_atomic_workflow.sql#L14)、[同:47–51](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611080001_atomic_workflow.sql#L47)、[base_schema.sql:254–257](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611010000_base_schema.sql#L254)、[同:298–301](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611010000_base_schema.sql#L298)、[demo_auto_approval.sql:16–31](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611080006_demo_auto_approval.sql#L16)。

**根拠・再現：** RPC は SECURITY INVOKER で列・テーブルの許可リストを持つが、「誰がどの状態からどこへ進めるか」「承諾後の金額は不変か」「支払額と契約額が一致するか」を検査しない。契約当事者には列単位の制約もない。一般クリエイターによる次の1操作を RPC に渡して成功した。

```json
{
  "table": "contracts",
  "insert": false,
  "id": "<本人が当事者の契約UUID>",
  "previous_status": "提示中",
  "values": {
    "amount": 999999,
    "status": "納品済（検収中）",
    "review_deadline": "2000-01-01T00:00:00Z"
  }
}
```

さらに会社ロールで同契約に amount=1・status='預かり中' の payment を作ると、cron 本体が承認し、**999999円の payout** を作成した。実際の送金は発生しないが、サーバー自動処理も偽造された契約・支払い状態を信頼する。`payments`／`payouts` の契約単位一意制約もなく、契約 CAS を含めずに台帳行のみ INSERT する呼出しを一律には防げない。

**修正の方向性：** 操作種別を持つ業務 RPC にし、当事者の役割・承認状態・許可遷移・不変列・金額・契約と会話の参加者対応をロック下で検証する。決済／報酬はサーバーで算出し、契約あたりの一意性や再実行キーを DB でも保証する。基礎テーブルへの直接書込みも制限しないと専用 RPC を迂回できる。デモ台帳を Stripe の実決済証跡に流用しない現方針は維持する。

### S04【中】作成日時の UPDATE で掲載上限を回避できる（R21）

**場所：** [job_posting_limits.sql:19–25、33–34](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611080004_job_posting_limits.sql#L19)、[base_schema.sql:266–267](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611010000_base_schema.sql#L266)。

**根拠・再現：** 作成日時は INSERT 時だけサーバーが上書きする。フリー会社で1件作成後、本人の案件の `created_at` を過去月へ UPDATE し、同月の2件目の INSERT に成功した。これを繰り返せる。所有者の正規 UPDATE 権限で成立し、S02 を直すだけでは解決しない。

**修正の方向性：** `created_at` と `company_id` を UPDATE 不可にするか、サーバートリガーで変更拒否する。作成時の上書き・東京月境界・会社単位ロックは維持し、INSERT→UPDATE→INSERT の迂回を試験する。

### S05【中】掲載の権利判定がプラン名だけで、失効状態や Stripe の権利を反映しない（R21/R22）

**場所：** [job_posting_limits.sql:15–17](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611080004_job_posting_limits.sql#L15)、[job_priority.sql:16–20](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611080005_job_priority.sql#L16)、[base_schema.sql:163–171、312–313](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611010000_base_schema.sql#L163)、[app.js:385–387](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/app.js#L385)。

**根拠・再現：** トリガーは `subscriptions.plan` のみ参照し、status・trial_end_date・next_renewal_date を見ない。本人が書ける同テーブルに「プロ／解約済／過去の trial_end_date」を保存すると、優先掲載付きの追加 INSERT が成功した。デモの自己プラン切替が無料なのは既存仕様だが、サーバーで有効性を強制しているとは言えない。また Stripe モードでも掲載用には旧 `subscriptions` を読み、Webhook は `stripe_subscriptions` を更新するため、有料契約の付与・失効が掲載権利に反映されない。これは PR #27 の既知の同期制約の具体的な影響。

**修正の方向性：** デモ／Stripe の権利ソースを明示し、サーバー専用の有効プラン判定に集約する。実課金モードでは利用者が書けない Stripe 権利を採用する。期限・状態の扱い、1ユーザー1現行プランの一意性も決め、二重行から任意の plan を拾う状態を防ぐ。

### S06【中】会話の相手のメッセージを書き換えられる

**場所：** [base_schema.sql:225、268–271](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611010000_base_schema.sql#L268)、[atomic_workflow.sql:22](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611080001_atomic_workflow.sql#L22)。

**根拠・再現：** `messages_update` は会話参加者なら許可し、更新列を制限していない。会社が投稿したメッセージを、相手のクリエイターが `UPDATE messages SET body='forged' WHERE id=...` で上書きできた。RPC の許可列にも body/sender_id/kind/contract_id がある。既読更新のための権限が、相手の発言やシステム表示の偽造に広がっている。

**修正の方向性：** メッセージ本文・送信者・種別を原則不変とし、既読だけを本人 ID の追加に限定する専用 RPC へ分離する。編集を提供するなら本人の投稿に限定し、履歴を保存する。システムメッセージの生成も業務 RPC に限定する。

### S07【中】認定バッジを本人が付与できる

**場所：** [base_schema.sql:37、210、262–263、292–293](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611010000_base_schema.sql#L262)、[app.js:757–770](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/app.js#L757)。

**根拠・再現：** `toggleBadge()` の管理者チェックはフロントのみ。creator_profiles の INSERT/UPDATE は本人の行なら `certified` も変更可能。一般クリエイターで `certified=true` を指定した本人プロフィールの INSERT が成功した。UPDATE にも同じ列制限不足がある。承認済みプロフィールでは偽の認定結果が公開される。

**修正の方向性：** プロフィールの自己編集列から certified 等の運営管理値を除外し、INSERT の既定値も強制する。管理者だけが認定を変更する専用経路を用意する。

### S08【中】同秒イベントの辞書順比較が、直列取得した最新状態を捨てる（R28）

**場所：** [stripe_event_serialization.sql:54–55](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611080009_stripe_event_serialization.sql#L54)、[resource-event.ts:10–16](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/functions/_shared/resource-event.ts#L10)、[stripe-webhook/index.ts:61–99](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/functions/stripe-webhook/index.ts#L61)。

**根拠・再現：** 取得リース・期限・トークン検証は機能している。しかし同じ秒の異なるイベントを ID の辞書順で拒否すると、次が起こる。

1. `created=100, id=evt_z` を処理し、その時点の active を保存してリースを解放する。
2. 同じ秒に状態が inactive へ変化し、別イベント `created=100, id=evt_a` が届く。
3. 次のリースを正規に取得して **最新の inactive を再取得**するが、`evt_a < evt_z` のため保存は false になる。
4. ハンドラーは false をエラーとせず成功応答し、その後イベントがなければ active が残る。

この2回の SQL 呼出しを、競合や失効のない別々のリースで実行して再現した。ID の辞書順が更新の時間順だという保証はコードにない。既存テストは lower ID の拒否自体を期待し、後から再取得した値の正当性を検証していない。subscription/account/payout の全3種が同じ判定を共有する。ゲートオフでも Webhook は停止しないため、既存 Stripe 状態には影響し得る。

**修正の方向性：** 配信イベントの重複排除と、リース下で再取得した現在状態の照合を分離する。イベント ID を同秒の時間順に見立てず、直列の再照合世代や再照合キューで最新取得結果を反映する。低い ID のイベントが後続の実状態変更を通知する試験を追加する。失効リースの fence は維持する。

### S09【中・有効化前】Price の税込前提を検査していない

**場所：** [stripe-api/index.ts:134–148](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/functions/stripe-api/index.ts#L134)、[docs/stripe-integration.md:325](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/docs/stripe-integration.md#L325)。

**根拠：** API はテストモード・通貨・月次・金額を検証するが `price.tax_behavior === 'inclusive'` を検査しない。同じ unit_amount の exclusive／unspecified Price も通る一方、ドキュメントは inclusive を必須としている。現実の Price は取得しておらず、設定不備や実請求過多を確認したという意味ではない。現行リクエストは `automatic_tax` を有効にしていないので、exclusive というだけで直ちに税が加算されるとも断定しない。

**修正の方向性：** 有効化前に既存 Price の inclusive を fail-closed で検証し、税込総額と税の記録方針を一致させる。Stripe Tax を使う場合は対象地域の登録状況・課税主体・商品・所在地の設定を別途確認してから設計する。本レビューを理由に `automatic_tax` をオンにしない。

### S10【中・既知の有効化前制約】30日トライアルの起点と再申込資格を強制しない

**場所：** [checkout.ts:102–109](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/functions/_shared/checkout.ts#L102)、[stripe-api/index.ts:116–130、174](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/functions/stripe-api/index.ts#L116)、[docs/stripe-integration.md:326](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/docs/stripe-integration.md#L326)。

**根拠・シナリオ：** `trial_period_days:30` 自体は正しく渡るが、毎回無条件。登録の40日後に初めて Checkout すればさらに30日 trial が始まり、「登録から30日後に初回課金」と一致しない。また、旧契約が canceled／incomplete_expired のみなら既存契約ガードを通るので、Checkout attempt の失効後に再申込すると再び30日を付与できる。PR #27 でも未解決としている起点・再申込資格の問題で、今回新たに実課金を行って確認したものではない。

**修正の方向性：** 「登録日」か「初回有料申込日」かを確定し、サーバー管理の一度限りの資格・起算日から trial_end を計算する。再申込時の扱いを料金画面・規約と揃える。ゲートはオフを維持する。

### S11【中】DB が許容する NULL の募集締切で一覧全体が停止する

**場所：** [app.js:2188](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/app.js#L2188)、[同:3517–3528](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/app.js#L3517)、[base_schema.sql:58](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611010000_base_schema.sql#L58)。

**根拠・再現：** DB の deadline は nullable。`displayJob()` は NULL をそのまま返し、jobCard が `job.deadline.replaceAll(...)` を呼ぶ。ブラウザー fixture の公開案件1件の deadline を NULL にして `/jobs.html` を開くと、データ取得は成功するのにカタログ全体が「データを取得できませんでした。接続を確認して再試行してください。」になる。例外文字列の露出はなく、問題は描画失敗と接続エラー扱い。通常の作成フォームは必須チェックをするが、既存データや直接 API 入力はカバーしない。

**修正の方向性：** 公開案件に必須の DB 制約・サーバー検証を設け、フロントでも NULL／欠損値は表示の代替値や案件単位の隔離で扱う。1件のデータ不備で全一覧を落とさない。

### S12【低】完了済み契約があると UI から再提示できない（R30 の整合）

**場所：** [app.js:3128–3140](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/app.js#L3128)、[同:3244–3249](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/app.js#L3244)、[同:1193–1206](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/app.js#L1193)、[workflow_uniqueness.sql:11–13](https://github.com/yuki2244856-commits/reviewmatch/blob/1d29aad17b7d9658ade756a1c629a29297414aee/supabase/migrations/202611080007_workflow_uniqueness.sql#L11)。

**根拠・再現：** DB の部分一意索引と `proposeContract()` は「辞退・完了」を終端とするが、renderChat の activeContract には「完了」が残る。会社とクリエイターの会話に完了契約だけを用意して会社で開くと、会話は表示されるが `#contract-form` は0件。契約カードから状態を進めても再提示 UI は出ない。

**修正の方向性：** 有効状態の定義を UI・メソッド・SQL で揃え、完了のみの会話から新規提示ができることを検証する。

## 確認済み・問題なしの観点

「問題なし」は次の具体的な機構に限定する。上記の業務認可不足や実運用未検証まで解消済みという意味ではない。

| 観点 | 判定・確認内容 |
| --- | --- |
| workflow の原子性 | **確認済み・問題なし。** 差分は単一 RPC。途中の拒否／例外で全体をロールバックし、古い契約 status の CAS は後続の台帳作成も巻き戻す。旧 REST 複数書込みへの fallback はない。業務ルール不足は S03。 |
| 通常の二重処理防止 | **確認済み・問題なし。** 正規フローの契約 CAS、応募 `(job_id,creator_id)` 一意、有効契約の部分一意索引を SQL で確認。cron 後の古いブラウザー CAS は失敗し、再 payout を残さない。任意の台帳 INSERT 全般の一意性は S03 の範囲。 |
| PR #26 の口座列 SELECT 遮断 | **確認済み・問題なし。** 080003 はテーブル SELECT を revoke してから安全な列だけ grant。一般／匿名の `SELECT *`・口座列取得を拒否し、公開列の取得・本人の保存を保つ。 |
| `get_my_payout_account()` | **確認済み・問題なし。** 利用者 ID 引数がなく、検索条件は `auth.uid()` 本人。空 search_path、PUBLIC/anon の実行権剥奪。第三者の口座を ID 指定して取得する経路はない。 |
| R21 の INSERT 内の機構 | **確認済み・問題なし。** 東京の当月範囲、サーバー生成日時、会社単位のトランザクション advisory lock がある。UPDATE 迂回と権利ソースは S04/S05。 |
| R22 の優先フラグ不変性・表示 | **確認済み・問題なし。** 作成後の priority 変更拒否、作成時のプラン名確認、優先順・バッジ・デモ成約時の2,000円加算は接続されている。プランの正当性は S05。 |
| 自動承認の期限・再実行 | **確認済み・問題なし。** 期限 `<= now()` で期限ちょうども対象。未来の期限、預かり payment がない契約を除外。`FOR UPDATE SKIP LOCKED` と契約 CAS、既存 payout 除外がある。反復実行は0件。支払額など証跡の正当性は S03。 |
| 自動承認の締月・Stripe 分離 | **確認済み・問題なし。** 処理日でなく review_deadline の東京月を用い翌月末を計算。stripe_held_orders が紐付く契約はサーバー cron から除外。期限欠損はサーバーでは対象外で、ブラウザーの納品+48時間 fallback とは異なるが、不明な期限の自動補完を必須とは判断しなかった。 |
| cron の登録定義 | **確認済み・問題なし（静的・登録呼出し）。** 関数作成後に `0 * * * *`・`select public.auto_approve_expired_reviews();` を登録。最大約1時間の走査間隔を持つ。実 pg_cron の起動成功は未検証。 |
| 署名検証 | **確認済み・問題なし。** Billing と payout は raw body の constructEventAsync、Connect v2 は parseEventNotificationAsync。各専用署名 secret で検証してから業務処理し、テスト context／既知の account mapping を確認。`verify_jwt=false` はこの署名経路と整合する。 |
| 有効化ゲート | **確認済み・問題なし。** Billing API は `STRIPE_BILLING_ENABLED !== 'true'` で services 作成前に409。案件 Checkout／onboarding は独立して409、worker はソース定数 false で資格情報参照前に409。フロント redirect も enabled を確認する。既存 Webhook をゲートで停止しない方針は妥当。 |
| R28 のリース fence | **確認済み・問題なし。** Stripe 再取得前に claim、保存時にトークン・失効・置換をチェック。release は同じ token のみ解除。旧 reducer の service_role 直接実行権も剥奪。同秒の状態取りこぼしは S08。 |
| R29 の二重 worker・失敗時停止 | **確認済み・問題なし。** account リースを外部処理後まで保持、失効後も自動横取りせず照合待ち。注文・割当・batch・account 証跡と期限を出金前後に再確認し、Webhook の先行確定を上書きしない。外部 API と DB の間を原子的にはできず、assert 後の外部変化や結果不明を完全排除したという判定ではない。 |
| 金額の基本計算 | **確認済み・問題なし（現行デモと helper の範囲）。** 10%／SNS運用15%・0円時500円・優先2,000円のデモ列保存、JPY 安全整数、held net／reserve／割当集合の条件を確認。信頼できる実注文生成は未接続なので Stripe 実請求との一致までは保証しない。 |
| XSS・外部遷移 | **確認済み・問題なし（調査経路で実行可能な XSS は未検出）。** 案件 displayJob、チャット・プロフィール等の escapeHTML、SNS URL の http/https 制限、Stripe redirect の HTTPS＋正確な許可ホストを確認。CSP/SRI の公開前計画は既知事項として扱い、重複指摘しない。 |
| エラー・セッション | **確認済み・問題なし（既存回帰範囲）。** ログアウト中 hydrate の世代・本人照合、RPC 失敗後の再取得、接続エラー表示がある。Stripe の内部エラーをレスポンス／ログへそのまま出していない。入力欠損による描画失敗は S11。 |
| R27 の全件取得 | **確認済み・問題なし（静的データ・標準の返却上限1,000件）。** 12テーブルと別途取得する掲載プランは主キー順 range 取得。2,001件の3ページを既存ブラウザー試験で確認。複数 REST ページ間の同一スナップショットや、サーバー返却上限が1,000未満の構成までは保証されない。 |
| マイグレーションの参照整合 | **確認済み・問題なし（記録された新規環境の連続適用）。** 202611010000→070001〜003→080001〜010 の全14本を実 SQL で通過。priority の IF NOT EXISTS、080009 の旧 RPC 権限変更と新入口、080010 の関数依存を確認。認可の内容自体は S01〜S07。 |

## 検証結果と限界

| 検証 | 結果 |
| --- | --- |
| `npm run test:migrations` | **4スイート成功**。全14本の新規適用、RLS/GRANT、既存の原子性・一意性・期限・リース試験を含む。 |
| Chromium＋既存 Playwright | **82件成功**。ローカル HTTP＋実 supabase-js、Auth/REST は fixture。 |
| Deno の `_shared/*.test.ts` | **27件成功**。試験時のみローカルランタイムを用意。 |
| Edge Functions 全5入口の `deno check` | **成功**。 |
| JS 3ファイルの構文確認 | **成功**。 |
| 独立 SQL probe | **10観点確認**：自己昇格、第三者案件更新、作成日時迂回、失効プロ権利、契約改ざん、1円 payment からの不一致 payout、同秒最新状態の棄却、相手メッセージ改ざん、自己認定、期限ちょうど／未来／payment欠落／反復。 |
| 独立ブラウザー probe | **2件再現**：NULL deadline による全体エラーと、完了後の提示フォーム欠落。 |

独立 probe とログはリポジトリ外の作業領域に置き、コード変更として同梱していない。再現の対象・操作・期待結果は各指摘に記載した。

既存テストが全成功しても認可が十分とは限らない。例えば既存 SQL 試験はポリシー数や通常フローを確認するが、一般利用者による role 更新・公開案件 UPDATE・日時 UPDATE・相手の本文 UPDATE を拒否する試験はない。また、同秒の lower ID 拒否は既存の期待結果だが、直列取得した最新値を落とす問題を隠す。

PGlite は pg_cron を提供しないため、登録呼出しだけをスタブ化し、本体は実 SQL で検証した。別 DB セッション同士の実 cron 並行起動、実環境への追加分だけの適用、元 DDL との差分、実 Stripe 署名を含む通信・Price・税登録・Platform Controls・銀行着金は検証していない。既存環境にはベースラインを適用せず、元の権限や依存関数を照合してから追加分を検証する必要がある。

## 対応の優先順

1. **S01・S02 を先に閉じる。** 一般ユーザー自身が認可を変更する経路と、第三者の公開案件更新を止める。
2. **S03・S04・S06・S07 を DB の業務境界で閉じる。** 原子性に加え、列権限・不変条件・正しい遷移・一意性を保証する。
3. **S05・S08 を権利・同期の設計として直す。** 特にイベント ID の並びと最新状態の再照合を分離する。
4. S11・S12 の表示を修正し、S09・S10 と既知の注文／照合／期限監視の運用制約を解決するまで、Stripe のゲートはオフに保つ。

本レポートの PR は調査結果の共有のみを目的とし、実環境への修正適用や課金有効化を承認・実施するものではない。
