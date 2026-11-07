# ReviewMatch

静的 HTML / CSS / JavaScript の ReviewMatch プロトタイプです。HTTP サーバーで配信してください。

```sh
python3 -m http.server 4173
```

フェーズ2 ステップ2aでは、全ページが CDN の supabase-js v2 を使用します。接続設定は app.js 冒頭にあります。公開 anon key のみを使用し、アクセス権は適用済みの RLS に委ねます。

- Supabase: Auth、profiles、company_profiles、creator_profiles、jobs、subscriptions。
- ブラウザー内: applications、conversations/messages、contracts、payments/payouts、reviews、notifications、出金口座のデモ情報（口座番号は下4桁のみ）。
- 旧 reviewmatch_store_v1 は、残る取引データを維持しながら、旧 users・パスワードハッシュ・疑似セッション・プロフィール・カタログを除去します。既存レコードの旧デモIDを実アカウントへ自動で割り当てることはしません。今後作成するレコードには Supabase の UUID を記録します。
- localStorage が使えない場合はメモリへ切り替えて通知します。その場合、ページを閉じる・再読み込みするまでの動作です。

## 回帰テスト

```sh
npm ci
npx playwright install chromium
npm test
```

既存の Chromium を使う場合:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm test
```

テストでは実際の supabase-js と Chromium を使い、Auth / REST 応答のみをテスト用データに置き換えます。全11画面、認証、登録、プロフィール、案件管理・審査、UUIDを使うローカル取引フロー、接続エラー、メモリへの切替を確認します。実 DB を変更しません。

**実接続の検証状況:** この実装環境では環境プロキシが Supabase ホストへの通信を 403 で遮断するため、実接続テストは未実施です。依頼文のテーブル・列情報をもとに実装しています。実プロジェクトでの列定義、RLS、Auth トリガー、デモアカウントとの互換性は接続可能な環境で確認してください。特に subscriptions は user_id、plan、next_renewal_date、status、trial_used、trial_ends_at を使用します。
