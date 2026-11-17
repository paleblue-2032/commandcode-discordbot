# commandcode-discordbot

自宅サーバーで Command Code を常駐させ、Discord から呼び出すための bot。

## 目次

- [現在の状態](#現在の状態)
- [方針](#方針)
- [全体像](#全体像)
- [コマンド](#コマンド)
- [ファイルの受け渡し](#ファイルの受け渡し)
- [セキュリティ](#セキュリティ)
- [他のギルドへの導入](#他のギルドへの導入)
- [環境変数](#環境変数)
- [ディレクトリ](#ディレクトリ)
- [開発](#開発)
- [デプロイ](#デプロイ)
- [トラブルシューティング](#トラブルシューティング)
- [次のステップ](#次のステップ)

## 現在の状態

- `kanon-server`（i5-3570 / 8GB / SSD 128GB + HDD 250GB）に Ubuntu Server 24.04.5 を構築済み。
- bot は TypeScript + discord.js で実装済み。ユニットテスト 33 件が通る。
- Nix flake で開発環境と実行パッケージを管理。サーバーでは `nix build` の成果物を systemd から起動する。
- `cmd` 1.88.5 を `cmdbot` ユーザーに導入し、ヘッドレスログインと `cmd -p` の動作を確認済み。
- `kanon-server` 上で systemd サービスとして稼働中。Discord に接続し、7 コマンドを登録済み。
- スラッシュコマンドはグローバル登録。`ALLOWED_USER_IDS` が空なら、参加している全ギルドの全ユーザーが利用できる。
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
- `sudo` は運用コマンドのみ NOPASSWD。全権限 sudo はパスワードが必要。運用は `botctl` に一本化している。
- `dis.txt` などのトークン控えは削除する。
- `cmd` は `--yolo` で動くため、招待するギルドと渡すリポジトリ/プロンプトを信頼できるものに限る。既定では参加ギルドの全ユーザーが実行できるので、必要なら `ALLOWED_USER_IDS` / `ALLOWED_CHANNEL_IDS` で制限する。

## 他のギルドへの導入

1. Discord Developer Portal の Bot 設定で **Message Content Intent** を ON にする。
2. OAuth2 URL Generator で `bot` と `applications.commands` を選び、次の権限を付けて招待する。
   - チャンネルを見る
   - メッセージを送信
   - ファイルを添付
   - メッセージ履歴を読む
3. 招待後は追加設定不要。スラッシュコマンドはグローバル登録されるため、どのギルドでもそのまま使える（初回反映まで数分かかることがある）。
4. `ALLOWED_USER_IDS` を空にすると、参加しているギルドの全ユーザーが利用できる。制限したい場合だけ ID をカンマ区切りで設定する。
5. cwd / セッション / model はチャンネル単位で保持され、同じチャンネルを使うユーザー間で共有される。`/cwd` の許可ルートはホスト側の `ALLOWED_ROOTS` に従う。

招待 URL の例（`<APPLICATION_ID>` を置き換える）:

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&permissions=101376&scope=bot%20applications.commands
```

`101376` は「チャンネルを見る」「メッセージを送信」「ファイルを添付」「メッセージ履歴を読む」の合計。

## 環境変数

`.env.example` を参照。主なものは次のとおり。

| 変数 | 内容 |
| --- | --- |
| `DISCORD_TOKEN` | Bot トークン（必須） |
| `ALLOWED_USER_IDS` | 許可する Discord ユーザー ID（カンマ区切り、任意）。空なら参加ギルドの全ユーザーを許可 |
| `ALLOWED_CHANNEL_IDS` | 許可するチャンネル ID（空なら全チャンネル） |
| `ALLOWED_ROOTS` | `/cwd` で移動できるルート（必須） |
| `CMD_BIN` | `cmd` の絶対パス |
| `MAX_CONCURRENCY` | 同時に走らせる cmd の上限 |
| `SESSIONS_FILE` | セッション状態の保存先 |
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
sudo botctl deploy commandcode
```

`botctl` が `git pull` → `nix build` → `systemctl restart` をまとめて実行する。

```bash
sudo botctl deploy commandcode   # pull + nix build + restart
sudo botctl restart commandcode
sudo botctl status commandcode
sudo botctl logs commandcode
sudo botctl follow commandcode   # ログを流し見
```

- `.env` は `/srv/commandcode-discordbot/.env`（600、root 所有）。編集は `sudo nano`。
- systemd unit は `deploy/commandcode-discordbot.service`。
- `sessions.json` は `/srv/commandcode-discordbot/sessions.json`。
- 実行中のツール進捗は journald にも出力される。`sudo botctl follow commandcode` で流し見できる（`adm` グループなら `journalctl -fu commandcode-discordbot` でも可）。
- `botctl` は `/usr/local/sbin/botctl`（root 所有 755）。toyamakosen-bus-bot と共用で、`commandcode` / `kosen` を切り替える。

### sudoers

`/etc/sudoers.d/90-cmd-maintenance` は次の 1 行だけ。`env` / `bash` / `nix` / `git` を個別に NOPASSWD で開けると `sudo bash` で実質 root になるため、その形は廃止した。

```
paleblue_2032 ALL=(root) NOPASSWD: /usr/local/sbin/botctl
```

- 全権限 sudo は従来どおりパスワード必須。
- `botctl` の引数は `deploy|restart|status|logs` と `commandcode|kosen` の固定リストのみ。
- `git` / `nix` はリポジトリの所有者（`cmdbot`）として実行されるので root 所有ファイルはできない。
- 旧設定は `/root/90-cmd-maintenance.bak.<日時>` に退避済み。

## トラブルシューティング

| 症状 | 確認 |
| --- | --- |
| bot が反応しない | Message Content Intent、`ALLOWED_USER_IDS` / `ALLOWED_CHANNEL_IDS`、`journalctl -u commandcode-discordbot` |
| 別ギルドでコマンドが出ない | グローバルコマンドの反映待ち（数分〜最大 1 時間）。`journalctl` で登録ログを確認 |
| 認証エラー | `sudo botctl logs commandcode` で確認。`cmd status` は `sudo -iu cmdbot` で直接実行する |
| モデルがエラー | `/model` で現在値を確認。モデルが effort に対応しているか確認 |
| 添付が返らない | cwd 配下か、`.env` / `.git` / `node_modules` ではないか、24MB 以下か |
| ファンが回らない | `sensors`、`systemctl status fan-quiet`、`journalctl -u fan-quiet` |
| 温度が高い | `sensors` で package / core を確認。80°C で CPU ファンが段階的に上がる |

## 次のステップ

1. 招待するギルドを信頼できるものだけに限定する（必要なら `ALLOWED_USER_IDS` でユーザーも制限）
2. 定期的に `sudo botctl deploy commandcode` で更新する
3. 必要なら CPU クーラーや PSU ファンの交換でさらに静音化する
