# 設計

## 処理の流れ

```
Discord メッセージ
  → allowlist 判定（ユーザー ID / チャンネル ID）
  → channelId から { cwd, sessionId } を引く
  → 実行中ならキューに積む（チャンネルごとに直列）
  → spawn: cmd -p <prompt> [--resume <sessionId>] --output-format json --yolo
  → stdout の NDJSON を 1 行ずつ読む
      event  → 進捗をメッセージ編集で上書き
      result → finalText を 2000 字ずつ分割して投稿
  → result.sessionId を保存
```

## コマンド体系

| 入力 | 動作 |
| --- | --- |
| 通常のメッセージ | そのチャンネルのセッションへプロンプトとして送る |
| `/ask prompt:<text>` | 同上（スラッシュ版） |
| `/new` | セッションを捨てて新規に切る |
| `/cwd <path>` | 作業ディレクトリを変更（許可ルート配下のみ） |
| `/status` | 現在の cwd / sessionId / 実行状態 |
| `/stop` | 実行中のプロセスを kill |

## セッション管理

- `sessions.json` に `{ channelId: { cwd, sessionId, updatedAt } }` を永続化する。
- セッションは**プロジェクトスコープ**（カレントディレクトリ単位）なので、`cwd` を変えたら `/new` 相当にする。別ディレクトリのセッション ID を渡しても拾えない。
- 会話を続けるときは `--resume <sessionId>`。`--continue` は「そのディレクトリの最新 headless セッション」で、他チャンネルと衝突するため使わない。
- ヘッドレスセッションは `/resume` の picker に出ないが、ID 指定なら復元できる。

## 出力処理

- `--output-format json` は NDJSON。1 行 1 オブジェクトで、最後に必ず `{"type":"result", ...}` が来る。
- `result` は `subtype` が `success` / `error` / `max_turns`。`finalText` は常に存在し、エラー時は空文字。
- `sessionId` は早期失敗時に欠落する。**存在を仮定しない。**
- Discord の 1 メッセージ上限 2000 字。コードブロックの途中で切らないよう、分割位置はフェンスを考慮する。
- 進捗編集はレート制限があるので 1.5〜2 秒間隔に間引く。

## 権限モデル

| モード | 挙動 | bot での扱い |
| --- | --- | --- |
| `yolo` | ほぼ全許可 | **採用** |
| `accept-edits` | 編集と安全なファイル系のみ許可。任意シェルは聞く | 不採用（聞けない） |
| `default` | 変更操作は全部聞く | 不採用 |
| `plan` | 読み取り専用 | 用途別に |
| `dont-ask` | プロンプトを出さず、allowlist 外は拒否 | 代替候補 |

### yolo でも止まるもの

1. `deny` ルール（全モードで絶対）
2. `ask` ルール（yolo でもプロンプトが出る）
3. `rm -rf /` `rm -rf ~` `rm -rf $HOME` のサーキットブレーカー

**`ask` ルールは絶対に入れない。** 誰も答えられないプロンプトでプロセスがハングする。危険なものは `deny` で塞ぐ。

### settings.json の方針

```json
{
  "permissions": {
    "deny": [
      "Read(~/.ssh/**)",
      "Read(~/.commandcode/**)",
      "Edit(~/.commandcode/**)",
      "Edit(.git/**)",
      "Shell(sudo *)",
      "Shell(systemctl *)"
    ]
  }
}
```

`ask` は書かない。`allow` も書かない（yolo で全部通るので意味がない）。

## セキュリティ

- **bot は専用ユーザーで動かす。** root でもログインユーザーでもない `cmdbot` を作り、作業ディレクトリだけ書き込み可能にする。
- **許可ルートを固定する。** `/cwd` は設定ファイルの `allowedRoots` 配下のみ受け付ける。パス正規化後に前方一致で検証する。
- **Discord 側の allowlist。** 自分のユーザー ID とチャンネル ID 以外は無視する。Bot の招待リンクは他人に渡さない。
- **トークンは `.env`。** `DISCORD_TOKEN` と `ALLOWED_USER_IDS` を環境変数で渡し、リポジトリには入れない。
- **外向きポートを開けない。** Discord へは bot 側から張る WebSocket なので、自宅の NAT 設定は不要。

## 失敗時の扱い

| 終了コード | 意味 | bot の対応 |
| --- | --- | --- |
| 0 | 成功 | `finalText` を投稿 |
| 3 | 未認証 | 「要再ログイン」を管理者へ通知 |
| 4 | 権限拒否 | deny ルールに当たった旨を表示 |
| 5 | レート制限 | 待って再試行、それでも駄目なら報告 |
| 6 | ネットワーク | 回線確認を促す |
| 8 | max turns 到達 | 部分応答を投稿し、`--max-turns` 増加を案内 |
| 9 | 無応答 | エラー表示 |
| 10 | クレジット不足 | 課金ページを案内 |
| 130 | 中断 | `/stop` 由来なら黙って終了 |

## 未確認事項

1. **ヘッドレスサーバーでの `cmd login`。** OAuth コールバックが localhost で待ち受けるため、サーバー上では URL をコピーして手元ブラウザで開くか、SSH ポートフォワードが要る可能性がある。駄目なら BYOK（`providers.json` に `baseURL: https://api.commandcode.ai/provider/v1`、`apiKey: "$CMD_API_KEY"`）で回避する。ただし BYOK では `/share`・`/usage`・`web_search`・`web_fetch` が使えなくなる。
2. **長時間 `--resume` し続けたときのコンテキスト肥大。** 必要なら `--compact` 相当を定期実行するか、閾値で `/new` を促す。
3. **Discord のレート制限下での編集頻度。** 実測して間隔を決める。
