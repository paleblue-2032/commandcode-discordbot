# commandcode-discordbot

自宅サーバーで Command Code を常駐させ、Discord から呼び出すための bot。

## 目次

- [現在の状態](#現在の状態)
- [方針](#方針)
- [全体像](#全体像)
- [コマンド](#コマンド)
- [ファイルの受け渡し](#ファイルの受け渡し)
- [セキュリティ](#セキュリティ)
- [環境変数](#環境変数)
- [ディレクトリ](#ディレクトリ)
- [開発](#開発)
- [デプロイ](#デプロイ)
- [トラブルシューティング](#トラブルシューティング)
- [次のステップ](#次のステップ)

## 現在の状態

- `kanon-server`（i5-3570 / 8GB / SSD 128GB + HDD 250GB）に Ubuntu Server 24.04.5 を構築済み。
- bot は TypeScript + discord.js で実装済み。ユニットテスト 31 件が通る。
- Nix flake で開発環境と実行パッケージを管理。サーバーでは `nix build` の成果物を systemd から起動する。
- `cmd` 1.88.5 を `cmdbot` ユーザーに導入し、ヘッドレスログインと `cmd -p` の動作を確認済み。
- `kanon-server` 上で systemd サービスとして稼働中。Discord に接続し、7 コマンドを登録済み。
- Radeon HD 6450 を取り外し、ケースファン停止 + CPU ファン温度カーブで静音化済み。
- `.env` は root 所有 600、root SSH ログイン無効、ufw は 22/tcp のみ、sudo は運用コマンドのみ NOPASSWD。

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
 │    │ spawn                    │
 │    ▼                          │
 │  cmd -p "..." --yolo          │
 │    --output-format json       │
 │    │  NDJSON (進捗 + 結果)    │
 │    ▼                          │
 │  Discord に表示               │
 └───────────────┬───────────────┘
                 │ HTTPS
                 ▼
        api.commandcode.ai
```

## コマンド

| 入力 | 動作 |
| --- | --- |
| 通常のメッセージ | そのチャンネルのセッションへプロンプトとして送る |
| `/ask prompt:<text>` | 同上（スラッシュ版） |
| `/new` | セッションを捨てて新規に切る |
| `/cwd <path>` | 作業ディレクトリを変更（許可ルート配下のみ） |
| `/model [model:<id>] [effort:<level>]` | モデルと推論の強さを表示・変更（autocomplete、`default` で解除） |
| `/status` | 現在の cwd / sessionId / model / effort / 実行状態 |
| `/stop` | 実行中のプロセスを kill |
| `/usage` | 使用量・クレジットの確認先を表示 |

`/model` の model / effort は候補から選択でき、文字入力で絞り込めます。モデル候補は `cmd --list-models` から取得して 10 分キャッシュします。推論強度は `off` / `low` / `medium` / `high` / `xhigh` / `max` で、モデルが対応している値のみ有効です。

## ファイルの受け渡し

- メッセージに添付したファイルは `<cwd>/.discord-uploads/` に保存され、cmd にパスが渡されます。
- cmd が回答の末尾に `[[attach:relative/path]]` を含めると、そのファイルを Discord に返します。
- 返却できるのは cwd 配下の通常ファイルのみ。`.env`、`.git`、`node_modules` などは拒否します。
- 1 ファイル 24MB、最大 10 ファイルまで。

## セキュリティ

- SSH は鍵認証のみ（パスワード認証・root ログイン無効）、ufw は 22/tcp のみ許可。
- bot は `cmdbot` で実行し、systemd の sandbox（`ProtectSystem=strict`、`NoNewPrivileges` など）で動作。
- `.env` は root 所有 600。トークンは systemd の `EnvironmentFile` 経由でのみ読み、`cmd` 子プロセスには秘密の環境変数を渡さない。
- `~/.commandcode/settings.json` の deny ルールで sudo / systemctl / 秘密ファイルの読み取りを禁止。
- `sudo` は運用コマンドのみ NOPASSWD。全権限 sudo はパスワードが必要。
- `dis.txt` などのトークン控えは削除する。
- `cmd` は `--yolo` で動くため、信頼できるリポジトリとプロンプトだけを渡す。許可ユーザー/チャンネルを限定し、必要なら別ユーザー・別アカウントに分離する。

## 環境変数

`.env.example` を参照。主なものは次のとおり。

| 変数 | 内容 |
| --- | --- |
| `DISCORD_TOKEN` | Bot トークン（必須） |
| `ALLOWED_USER_IDS` | 許可する Discord ユーザー ID（カンマ区切り、必須） |
| `ALLOWED_CHANNEL_IDS` | 許可するチャンネル ID（空なら全チャンネル） |
| `ALLOWED_ROOTS` | `/cwd` で移動できるルート（必須） |
| `CMD_BIN` | `cmd` の絶対パス |
| `MAX_CONCURRENCY` | 同時に走らせる cmd の上限 |
| `SESSIONS_FILE` | セッション状態の保存先 |
| `DISCORD_GUILD_ID` | スラッシュコマンドを即時登録するギルド ID |
| `CMD_MODEL` | 既定モデル（`/model` でチャンネルごとに上書き可能） |
| `CMD_EFFORT` | 既定の推論強度（`/model effort:<level>` で上書き可能） |

## ディレクトリ

| パス | 内容 |
| --- | --- |
| `src/` | bot 本体（Discord ハンドラ、cmd ランナー、キュー、セッション、添付処理） |
| `test/` | ユニットテスト |
| `deploy/` | systemd unit |
| `flake.nix` / `flake.lock` | Nix 開発環境・実行パッケージ |
| `.env.example` | 環境変数のテンプレート |

設計・構築メモはローカルの `docs/` に置いています（git 管理外）。

## 開発

```bash
nix develop
npm ci --include=dev
npm test
npm run typecheck
npm run build
```

## デプロイ

```bash
sudo -u cmdbot -H git -C /srv/commandcode-discordbot pull --ff-only
sudo -u cmdbot -H env PATH=/nix/var/nix/profiles/default/bin:/usr/local/bin:/usr/bin:/bin \
  bash -c 'cd /srv/commandcode-discordbot && nix build .# --print-build-logs'
sudo systemctl restart commandcode-discordbot
```

- `.env` は `/srv/commandcode-discordbot/.env`（600、root 所有）。編集は `sudo nano`。
- systemd unit は `deploy/commandcode-discordbot.service`。
- `sessions.json` は `/srv/commandcode-discordbot/sessions.json`。

## トラブルシューティング

| 症状 | 確認 |
| --- | --- |
| bot が反応しない | Message Content Intent、`ALLOWED_USER_IDS` / `ALLOWED_CHANNEL_IDS`、`journalctl -u commandcode-discordbot` |
| 認証エラー | `sudo -u cmdbot -H env HOME=/home/cmdbot PATH=/home/cmdbot/.npm-global/bin:/home/cmdbot/.nix-profile/bin:/usr/bin:/bin cmd status` |
| モデルがエラー | `/model` で現在値を確認。モデルが effort に対応しているか確認 |
| 添付が返らない | cwd 配下か、`.env` / `.git` / `node_modules` ではないか、24MB 以下か |
| ファンが回らない | `sensors`、`systemctl status fan-quiet`、`journalctl -u fan-quiet` |
| 温度が高い | `sensors` で package / core を確認。80°C で CPU ファンが段階的に上がる |

## 次のステップ

1. Discord の bot ロールを `agent` チャンネルだけに制限する
2. 定期的に `git pull` / `nix build` / `systemctl restart` で更新する
3. 必要なら CPU クーラーや PSU ファンの交換でさらに静音化する
