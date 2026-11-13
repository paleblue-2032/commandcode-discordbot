# commandcode-discordbot

自宅サーバーで Command Code を常駐させ、Discord からいつでも呼び出すための構成。

## 方針

- **自作 Discord bot を採用する。** 公式の `/rc` は tmux 常駐 + セッション生存が前提で、プロセスが死ぬと切れる。自作なら 1 メッセージ = 1 プロセスで、常駐は bot だけで済む。
- **bot は `cmd -p`（ヘッドレス）を子プロセスとして叩く。** 対話 UI を持たないのでサーバー上で TTY を維持する必要がない。
- **推論はクラウド側。** 自宅サーバーは Node.js を動かして HTTP を待つだけなので、非力なマシンで足りる。
- **権限は `--yolo` を基本に、`deny` ルールで危険なものだけ潰す。** `ask` ルールは入れない（誰も答えられずハングする）。

## 全体像

```
 スマホ (Discord)
      │  メッセージ / スラッシュコマンド
      ▼
 ┌───────────────────────────────┐
 │ 自宅サーバー (i5-3570 / 8GB)  │
 │                               │
 │  discord-bot (Node 22)        │
 │    │ channelId → cwd/session  │
 │    │ spawn                  │
 │    ▼                          │
 │  cmd -p "..." --yolo          │
 │    --output-format json       │
 │    │  NDJSON (進捗 + 結果)    │
 │    ▼                          │
 │  Discord にストリーム表示      │
 └───────────────┬───────────────┘
                 │ HTTPS
                 ▼
        api.commandcode.ai
```

## ディレクトリ

| パス | 内容 |
| --- | --- |
| `docs/hardware.md` | 自宅サーバーのスペック可否判断 |
| `docs/setup.md` | OS から systemd 登録までの手順 |
| `docs/design.md` | bot の仕様・権限モデル・セッション管理・未確認事項 |
| `AGENTS.md` | エージェント向け引き継ぎ（git 管理外） |

## 次のステップ

1. `docs/setup.md` に沿ってサーバーを構築
2. `docs/design.md` の仕様で bot を実装（未着手）
3. 動作確認後、systemd で自動起動を有効化
