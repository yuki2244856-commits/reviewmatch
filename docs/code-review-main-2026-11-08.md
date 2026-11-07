# ReviewMatch main 全体レビュー（2026-11-08 JST）

対象は main `b642e24fe54c706773a909a309fd0bc2e7e8a95f`（PR #24 まで）。開始時の `eadb344` からレビュー中に追加された法務ページを含めて再確認した。場所のリンクはこの固定コミットを指すため、修正後の行番号とは異なる。

高4件・中27件・低2件の計33件。R01–R18 は PR でコード修正、R19–R33 は仕様・スキーマ・運用設計の確認が必要なため指摘に留める。高のうち公開認証情報はコードから除去しても過去に知られた値を失効できないため、実アカウントが存在する場合の運用対応が残る。

範囲: app.js 全体、Stripe フロント2ファイル、5 Edge Function と _shared、3既存 migration、全13 HTML（追加の terms/privacy を含む）、style.css、既存 tests/ と supabase/tests/。Stripe/Supabase の実運用データ・設定・適用済み RLS を検証したものではない。実口座の操作、公開済み認証情報によるログイン、決済/返金/出金、リモート migration 適用、デプロイ、マージは行っていない。

## PR で修正した指摘

| ID | 重要度 | 場所（レビュー対象 main の行） | 内容 | 根拠 | 修正案・状況 |
|---|---|---|---|---|---|
| R01 | 高 | [app.js:2608](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L2608) | 管理者を含む公開デモ認証情報 | ログイン画面にパスワードを埋め込み、実 Supabase Auth へ送信する。実アカウントの存在・有効性は未確認。 | 公開アカウント一覧・自動入力・埋込み値を削除。テストは専用の偽認証情報へ変更。既存の実アカウントがあれば別途失効・ローテーションが必要。 |
| R02 | 高 | [app.js:863](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L863) | workflow が部分的に確定し、再実行もできない | contracts → payments/payouts → messages を個別 REST で更新。決済挿入失敗後も契約は支払済、報酬挿入失敗後も完了になる。既存テストもこの状態を期待していた。 | SECURITY INVOKER の apply_reviewmatch_workflow RPC で差分全体を単一トランザクション化。テーブル・列を許可リスト化し、契約状態 CAS と既存 RLS を維持。失敗・CAS 不一致・RLS 拒否時のロールバックを SQL で検証。 |
| R03 | 高 | [app.js:1311](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L1311) | 未決済でも報酬を作成できる | completeDelivery は預かり中の payment が見つからなくても契約を完了にして payout を作成する。部分更新で生じた不整合も増幅する。 | 預かり中の payment を必須化し、欠落時は契約・報酬とも変更しない。デモ payment は実 Stripe 支払いの証明には使用しない。 |
| R04 | 高 | [tokusho.html:244](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/tokusho.html#L244) | 法務ページ経由で Stripe モードを迂回 | tokusho と、新規追加された terms/privacy は config/client を読み込まず app.js だけを実行。Stripe 有効でも runAutoApprovals がデモモードとして契約・報酬を書き込む。 | 3 法務ページにも共通 Stripe スクリプトを追加。各ページで Stripe モード・自動検収停止を回帰テスト。 |
| R05 | 中 | [stripe-client.js:9](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/stripe-client.js#L9) | 無効化が UI の呼出し元だけに依存 | redirect 自体は enabled を確認しない。stripe-api にもフロントの enabled:false に対応するサーバー停止条件がなく、直接 POST で Billing に到達する。 | redirect 内でも停止。API はサーバーの STRIPE_BILLING_ENABLED=true がない限り、資格情報を読む前に 409。署名済み Webhook は停止対象から除外し、既存状態の同期を維持。 |
| R06 | 中 | [app.js:1267](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L1267) | Stripe モードでデモの納品・差戻しが残る | pay/complete は停止するが deliverContract と reviewDelivery(false) は旧 contracts を変更でき、UI もデモ操作を表示する。 | 納品・検収の入口と UI を Stripe モードでは停止。案件課金・onboarding・payout の既存停止は維持。 |
| R07 | 中 | [app.js:1316](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L1316) | 遅延した自動検収で支払月が遅れる | 自動承認の締月を処理時刻 new Date() から算出。9月末の48時間期限を11月に処理すると12月末払いになる。 | 自動承認は reviewDeadline（欠落時は納品+48時間）の実効時刻から東京の締月を算出。月跨ぎのテストを追加。 |
| R08 | 中 | [supabase/migrations/202611070003_held_project_payouts.sql:124](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/supabase/migrations/202611070003_held_project_payouts.sql#L124) | 出金額と割当注文の集合が異なる | 合計計算は not revision_requested だが割当 INSERT は修正依頼中を除外しない。承認後の修正依頼で余計な注文が予約され、ワーカーは金額不一致で停止する。現在ワーカーは無効。 | 追加 migration で両方の抽出条件を一致させ、ワーカー側も revision_requested を拒否。承認済み+修正依頼中の注文が割り当てられない SQL テストを追加。 |
| R09 | 中 | [supabase/functions/stripe-payout-worker/index.ts:133](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/supabase/functions/stripe-payout-worker/index.ts#L133) | Webhook の結果をワーカーが巻き戻す | Payout 作成中に Webhook が paid/uncertain を記録しても、後続の UPDATE が無条件で submitted、catch が uncertain に上書きする。現在は実行停止中。 | ワーカーの更新を state=reserved に限定。応答にも再取得した実際の DB 状態を返す。 |
| R10 | 中 | [supabase/migrations/202611070002_stripe_merchant_accounts.sql:21](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/supabase/migrations/202611070002_stripe_merchant_accounts.sql#L21) | アカウント変更後も出金権限の検証証跡が残る | merchant イベントは capability だけを書き換える。closure/設定変更を受けても exclusive_payout_controls_verified_until と funds_reconciled_at を無効化しない。 | 追加 migration で受理したアカウント更新時に両証跡を破棄し、再検証・再照合を必須にする。SQL テストを追加。 |
| R11 | 中 | [app.js:864](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L864) | 同期中のログアウト・別同期で古い状態を使う | hydrate は世代やユーザーが変わると無言で return するが、workflow は成功扱いで load と差分保存に進む。キューにも依頼時のユーザーを固定しない。 | hydrate が採用可否を返し、workflow が依頼時ユーザーと同期結果を検証。同期途中でのログアウトをブラウザで再現し、書込みがないことを検証。 |
| R12 | 中 | [app.js:771](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L771) | 会社プロフィールが欠落すると未定義参照 | 登録途中のプロフィール書込み失敗は回復対象だが、案件作成では company.companyName / company.industry を無条件参照する。 | プロフィール欠落時はアカウント表示名・未登録へフォールバック。回帰テストを追加。 |
| R13 | 中 | [app.js:758](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L758) | 存在しない日付を案件作成が受け入れる | Date.parse("2026-02-30") は有効な3月の日付へ正規化されるため、有限値判定だけでは通過する。契約提示側には往復チェックがある。 | ISO 日付へ戻した結果と入力の一致を検証し、契約提示と揃える。2月30日の拒否をテスト。 |
| R14 | 中 | [app.js:3865](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L3865) | 応募だけ保存された会話欠落ケースで UI が落ちる | 既応募なら thread.id を無条件参照する。以前の非原子的な応募保存や既存の不整合データでは thread がない。 | 会話がない場合はチャット一覧へ案内し、例外を防止。新しい部分保存は原子 RPC で防ぐ。 |
| R15 | 中 | [app.js:1243](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L1243) | 無料プランでも優先掲載料を購入できる | 料金画面はスタンダード・プロ限定だが、payContract と支払フォームにプラン判定がない。 | デモ決済処理にプラン確認を追加し、無料プランのチェックボックスを無効化。直接メソッド呼出しの拒否もテスト。実際の掲載効果は別項。 |
| R16 | 中 | [app.js:1183](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L1183) | 停止済みユーザーの操作チェックが不揃い | respondToContract は creator role のみ、runAutoApprovals は company role のみを確認し、approved を必須にする他の契約操作と揃っていない。 | 契約回答と自動検収に approved を追加。最終的な権限制約はサーバー RLS/業務 API でも必要。 |
| R17 | 中 | [app.js:1653](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L1653) | 外部送信しないという説明が実装と逆 | FAQ・応募画面・マイページはブラウザ内保存または無送信と説明する一方、認証・応募・プロフィールは Supabase に送る。新規法務ページ追加後も登録同意リンクは FAQ のまま。 | 送信先・保存先の説明を実装に合わせ、同意リンクを terms/privacy へ変更。privacy の「暗号化」は Supabase Auth によるハッシュ化と表現を修正。 |
| R18 | 中 | [supabase/functions/stripe-api/index.ts:111](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/supabase/functions/stripe-api/index.ts#L111) | 古い有効契約を見落として重複契約を作れる | subscriptions.list(limit:100,status:all) の最初のページだけを確認。直近に終了済み契約が多数あると、それより古い有効・未払い契約を見落とす。 | Stripe SDK の自動ページングを最後まで走査する共通ガードへ変更。100件の終了済みの後に有効契約があるケースを Deno で検証。 |

## 判断・確認が必要な指摘（コード変更を保留）

| ID | 重要度 | 場所（レビュー対象 main の行） | 内容 | 根拠 | 修正案・状況 |
|---|---|---|---|---|---|
| R19 | 中 | [app.js:349](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L349) | 基盤テーブルのスキーマ・RLS を再現・検証できない | リポジトリの migration は stripe_* のみ。profiles・jobs・contracts・payments 等の定義、権限、Auth トリガーはなく、tests の RLS は JavaScript による模擬。README の trial_ends_at とコードの trial_end_date も不一致。 | 適用済みスキーマを取得して migration とポリシー試験を追加。role/status 自己昇格、金額・他人 ID の改ざんを実 SQL で拒否できるか確認。実環境の脆弱性が確認済みという意味ではないため、推測した RLS は追加していない。 |
| R20 | 中 | [app.js:349](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L349) | 公開プロフィールと銀行情報が同じ行にある | creator_profiles を * で取得し、同じ行に payout_bank/branch/holder/last4 を保存する。承認済み行を一般公開する RLS なら列も公開される。fixture はその行公開を模擬するが、本番ポリシーは不明。 | 銀行情報を所有者専用テーブル/API に分離するか、非公開ベーステーブルと安全な公開ビューへ分離。フロントの列選択だけでは REST 直叩きを防げない。スキーマ・公開範囲の判断待ち。 |
| R21 | 中 | [app.js:740](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L740) | 有料プランの案件掲載上限が機能しない | plans.limit は料金シミュレーターのみに使われ、createJob は月間件数や有効プランを判定しない。1件/月・10件/月の広告と一致しない。 | 月のタイムゾーン、審査中/再掲載/非公開を数える基準を定義し、公開操作を含めサーバーで原子的に上限を判定。ブラウザだけの判定は迂回可能なので追加していない。 |
| R22 | 中 | [app.js:1243](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L1243) | 優先掲載料は記録するが掲載効果に結び付かない | priorityFee は payments の記録・表示に使うだけで、jobs の優先フラグ・掲載期間・検索順には反映されない。支払タイミングも案件の契約後。 | 優先対象、開始/終了、検索表示順、契約前に購入するのかを定義して掲載機能と結び付ける。未実装なら販売を停止する。現状はデモ料金記録で、実 Stripe 課金経路は無効。 |
| R23 | 中 | [app.js:1371](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L1371) | デモ自動承認が企業のページ訪問に依存 | runAutoApprovals は企業ユーザーの bootstrap 時にしか処理しない。企業が訪問しなければ48時間経過しても完了・報酬が確定しない。Stripe 用 auto_approve_held_orders も無効ワーカー以外にスケジュールがない。 | 納品・修正状態を信頼できるサーバーで管理し、定期ジョブを設計・配備する。配備先・時計・再試行・運用権限が必要なため、この PR では有効化していない。 |
| R24 | 中 | [terms.html:125](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/terms.html#L125) | クリエイター受取額と Stripe 手数料・税込表示の前提が違う | 規約第10条は Stripe 手数料をクリエイター負担とし、台帳 net_jpy も processing_fee を控除する。一方デモは契約額全額を受取額・payout に使い、完全無料と宣伝する。規約は成約料・オプションも税込だが、実 Stripe Price の tax_behavior/税設定は未検証。 | デモと実運用の差、手数料負担、税込総額・端数処理を確定して表示と信頼できるサーバー計算を一本化する。Stripe Tax を使う場合も登録状況の確認が先。料金・税設定は変更していない。 |
| R25 | 中 | [terms.html:117](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/terms.html#L117) | 法務ページの無料トライアルと Stripe 実装が矛盾 | 規約は30日無料と初回申込み時課金を併記。Stripe Checkout は trial 設定なし、Stripe モードの料金/FAQ は無料トライアルなしと明記。 | 無料期間の有無・起算日・初回課金日を確定して規約・特商法・画面・Stripe を揃える。約款と課金条件の判断を伴うため、自動では変更しない。 |
| R26 | 中 | [terms.html:140](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/terms.html#L140) | 90日期限・翌月末入金の運用が約束を満たさない | 規約は90日経過時に支払実行または返金とするが、コードは期限到達で出金を止めるだけで救済サービスがない。docs は API の月末実行が銀行の月末着金を保証しないと説明するが、規約は翌月末払い。 | 未検収の期限切れを自動支払しない方針と、返金/例外処理・休日/銀行締切を明文化し、監視・運用を実装する。資金移動・法務判断が必要なので現状の hard-disable を維持。 |
| R27 | 中 | [app.js:349](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L349) | 全件 select にページングがない | 12 テーブルを select(*) で読み切った前提。Supabase の返却上限を超えると、案件・会話・決済・報酬履歴が欠落し、重複判定や管理画面集計も不正確になる。 | カタログ/会話/履歴ごとにサーバーページングと件数 API を設計する。単に全件をブラウザへ読み込む変更は、個人情報の最小化や性能の要件を満たさないため保留。 |
| R28 | 中 | [supabase/migrations/202611070001_stripe_foundation.sql:37](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/supabase/migrations/202611070001_stripe_foundation.sql#L37) | 同じ秒の Webhook が古いスナップショットで上書きできる | イベント ID 重複は除外するが event_created <= なので同一秒は両方通る。Stripe からの再取得と DB 書込みが別処理のため、古い状態を取得したハンドラーが後から保存すると entitled/plan が戻る。 | ユーザー/リソース単位の再照合キューで取得と反映を直列化し、同一秒の並行処理を試験する。単純に < に変えると正当な同一秒イベントを欠落させるため変更しない。 |
| R29 | 中 | [supabase/functions/stripe-payout-worker/index.ts:74](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/supabase/functions/stripe-payout-worker/index.ts#L74) | 予約 RPC のロックは実際の Stripe 出金まで維持されない | reserve_held_payout の advisory lock は RPC 終了時に解放され、Stripe API 呼出しはその後。間に証跡無効化・blocked・照合結果更新があっても、ワーカーは予約前に取った creator と reconciled:true を使う。現在は source gate=false。 | 口座ごとのワーカー実行リースと停止/返金/リスク更新のプロトコルを設計し、外部 API 直前/直後の再照合・中断を試験する。有効化前必須。単なる再読込では最後の競合窓を閉じないので対処済みとはしていない。 |
| R30 | 中 | [app.js:989](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/app.js#L989) | 別タブの重複応募・契約提示はフロントキューで防げない | 重複確認は事前の hydrate/配列検索で、workflowQueue は1ページ内だけ。原子 RPC でも2タブが同じ未存在状態から別 UUID を INSERT することはあり得る。DB の UNIQUE/部分 UNIQUE はリポジトリで確認できない。 | 応募は(job_id,creator_id)、契約は会話ごとの有効契約に DB 制約を設ける。既存重複データ、辞退後再応募、契約の有効状態集合を確認して migration を作る必要がある。 |
| R31 | 中 | [tokusho.html:154](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/tokusho.html#L154) | 支払時期の説明が画面フローと一致しない | 特商法は成約時課金、規約は契約に係る支払時の課金、flow は納品後の決済。一方デモ契約は先払いしなければ納品へ進めない。 | 企業の課金・検収確定・クリエイター銀行出金を分けて、同じ時系列で表示する。どの契約条件を採用するかは運用判断として保留。 |
| R32 | 低 | [README.md:11](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/README.md#L11) | 保存先・実装段階の説明が古い | README は applications/messages/contracts/payments 等をブラウザ内データと記載するが、main は Supabase に移行済み。trial 列名や「全11画面」も現状を反映していない。 | 現行スキーマ・移行手順・現在の画面数に更新する。実スキーマを確認してから確定させる。 |
| R33 | 低 | [index.html:27](https://github.com/yuki2244856-commits/reviewmatch/blob/b642e24fe54c706773a909a309fd0bc2e7e8a95f/index.html#L27) | 外部 JavaScript の更新・CSP 方針が固定されていない | 全ページが Tailwind 実行時 CDN と supabase-js@2 の可変配布を直接実行し、CSP/SRI はない。今回調べたユーザー入力表示では HTML escape と URL scheme 制限を確認したが、CDN の変更・侵害は別の経路になる。 | ビルド済み CSS/固定 SDK の配布と CSP を検討。inline handler・style を含め段階的に移行し、Checkout 等の許可先も確認する。 |

## 金額の突合せ

| 項目 | 画面/デモ保存 | Stripe/台帳 | 判断 |
|---|---|---|---|
| フリー | 0円 | Checkout 対象外 | 一致 |
| スタンダード | 月額9,800円・税込 | 固定 Price ID。JPY/月/9,800 を API で検証 | 数値は一致。実 Price の税設定は未検証 |
| プロ | 月額29,800円・税込 | 固定 Price ID。JPY/月/29,800 を API で検証 | 数値は一致。同上 |
| 制作案件成約料 | Math.round(報酬×10%)、企業加算 | directChargeCheckout は信頼済み applicationFeeJpy を受け取るだけ | 真の注文生成サービスが未実装のため Stripe までの一致は証明できない |
| SNS運用成約料 | Math.round(報酬×15%)、企業加算 | 同上 | 同上 |
| 報酬0円の案件 | 固定500円 | 現在は案件課金自体が無効 | 税/端数/商品提供の意味づけは確定が必要 |
| 優先掲載 | 2,000円を企業合計へ加算 | Stripe への本番注文連携なし | 数値表示・デモ保存は一致。購入資格を修正。掲載効果は未実装 |
| クリエイター受取 | デモは契約額そのまま | gross−application_fee−processing_fee | 表示と実手取の差を要確認 |

## 有効化とセキュリティの確認

- `HELD_PROJECT_PAYMENTS_ENABLED=false` は引き続きワーカーの最初で評価され、資格情報/Stripe 呼出しより前に停止する。API の案件 Checkout と新規 onboarding も独立して 409。export された helper はリクエストを組み立てるだけで、単独では Stripe を呼ばない。
- 新しい Billing のサーバーゲートは既定で無効。フロントの `enabled:false` だけをアクセス制御として扱わない。署名済み Webhook は既存リソースを照合し続ける必要があるので、このゲートでは止めない。
- `stripe_*` の既存 RLS は利用者の SELECT を自分の account/subscription/held order に限定し、service 所有テーブルのクライアント書込みと強い RPC を revoke している。今回の新しい workflow RPC は SECURITY INVOKER であり、基盤テーブルの権限を昇格しない。
- HTML へ出す案件/会社/チャット/プロフィールの主要経路には escape があり、SNS リンクは http/https に限定する。Stripe リダイレクトは HTTPS と正確なホスト名の許可リスト。今回、実行可能な入力由来 XSS は確認していない。
- Stripe secret/service-role key のリテラルは対象ソースで確認していない。公開 anon key、publishable key、Price/account ID は秘密鍵ではない。公開デモパスワードは別問題として R01 に扱った。

## 修正の適用順と残る制約

1. 実環境の基盤テーブル定義/RLS をステージングで確認する。
2. 新規 migration `202611080001_atomic_workflow.sql`、`202611080002_held_payout_safety.sql` を適用する。
3. その後で新しい app.js / HTML を配信する。RPC がない状態で旧非原子 REST に戻す fallback は設けていない。
4. 既に部分保存されたデータは監査して修復する。この PR は既存データを推測して埋めたり、支払済み扱いにしたりしない。
5. Billing/Connect/案件課金/出金の有効化は行わない。新しいサーバー環境変数は未設定のままにする。実在する公開デモアカウントは失効またはローテーションする。

既存の3 migration は書き換えず、追加 migration で関数を修正する。外部 Stripe API と DB 間の競合、銀行休日、期限切れ救済、基盤スキーマ不足は未解決であり、この PR を本番課金準備完了の根拠にはできない。

## テスト結果

- 修正前: `tests/` **65件成功**、Deno **19件成功**、既存 `supabase/tests/held-ledger.mjs` 成功。
- 修正後: **76件成功**。法務3ページ、無効リダイレクト、未決済検収、遅延自動検収の東京締月、無料プランの優先掲載拒否、プロフィール欠落/不正日付、同期中ログアウトを追加。
- `npm run test:migrations`: 既存3本+追加2本を読み込み、検収・修正・出金集合・再送・失敗・RPC/RLS制限を検証して成功。新しい `atomic-workflow.mjs` も成功（途中失敗ロールバック、古い状態の CAS、呼出者 RLS、列/テーブル許可リスト、匿名拒否）。
- Deno: 最終 **20件成功**。Edge Function **5入口の型チェック成功**。
- JavaScript 3ファイルの構文チェック、`git diff --check` 成功。
- ローカル Edge API へ、Stripe 資格情報も Billing 有効化変数も与えず直接 POST し **HTTP 409** を確認。

ブラウザ試験は Chromium と実 supabase-js を使い Auth/REST を interception する。SQL は隔離 PGlite 上の試験であり、workflow 用には最小テストスキーマを使用する。実プロジェクトの RLS/トリガー、Stripe の既存 Price、Dashboard/Platform Controls、Webhook 配備、銀行着金は未検証。
