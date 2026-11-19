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
| `!<メッセージ>` | そのチャンネルのセッションへプロンプトとして送る（`!` は除かれる） |
| `!` なしのメッセージ | **何もしない**（スレッド内の会話に介入しない） |
| `/ask prompt:<text>` | 同上（スラッシュ版、`!` 不要） |
| `/new` | セッションを捨てて新規に切る |
| `/cwd <path>` | 作業ディレクトリを変更（許可ルート配下のみ） |
| `/model [model:<id>] [effort:<level>]` | モデルと推論の強さを表示・変更（autocomplete、`default` で解除） |
| `/status` | 現在の cwd / sessionId / model / effort / 実行状態 |
| `/storage` | ディスク使用量・SMART 判定・削除候補の表示（dry-run） |
| `/stop` | 実行中・待機中の処理を取り消す |
| `/usage` | 使用量・クレジットの確認先を表示 |

### 呼び出し方

通常メッセージは**先頭が `!` のときだけ**実行します。スレッド内で人間同士が会話しても bot は反応しません。添付だけ送る場合も `!` を付けてください（本文なしで `!` だけでも動きます）。

`TRIGGER_MODE=all` にすると従来どおり全メッセージに反応します。

`/model` の model / effort は候補から選択でき、文字入力で絞り込めます。モデル候補は `cmd --list-models` から取得して 10 分キャッシュします。

### 既定モデルと effort

既定は `deepseek/deepseek-v4.1-flash`（vision 対応、1M context、cache read $0.003/1M）。`--resume` で同じコンテキストを毎ターン送る使い方では cache read の単価が支配的なので、`-fast` 系（cache $0.016〜$0.07）より安く済みます。

effort の有効値は**モデルごとに違います**。bot はカタログに合わせて検証するので、存在しない値を送ってエラーになることはありません。

| モデル例 | 使える effort |
| --- | --- |
| `deepseek/deepseek-v4.1-flash` | `off` / `low` / `high` / `max` |
| `Qwen/Qwen3.8-Flash` | `low` / `medium` / `xhigh` |
| `claude-sonnet-5-5` など Claude / GPT-6 系 | `low` / `medium` / `high` / `xhigh` / `max` |
| `Qwen/Qwen3.7-Flash`、`claude-haiku-4-5` など | 非対応（effort を指定できない） |

- 非対応モデルに effort を指定すると理由付きで拒否します。
- モデルを変えて保存済み effort が合わなくなった場合は自動で解除し、応答に表示します。
- 実行時に `cmd` が effort を拒否した場合も自動で解除して、次回から再発しません。
- 表に無いモデル（BYOK など）は検証せずに `cmd` へ渡します。

### フォーラムでの使い方

フォーラムの投稿（スレッド）は、投稿ごとに独立したセッション・独立したキューになります。`MAX_CONCURRENCY`（既定 3）までは別の投稿が同時に実行され、それを超えた分だけ `待機中… (待ち N 件)` として順番待ちになります。同じ投稿の中では従来どおり直列です。

`FORUM_CWD=auto`（既定）では、投稿ごとに `<DEFAULT_CWD>/<フォーラム名>/<投稿名>` を自動作成して作業ディレクトリにします。`/cwd` で明示的に指定した場合はそちらが優先され、自動の割り当てには戻りません。`FORUM_CWD=shared` にすると全投稿で `DEFAULT_CWD` を共有します。通常のテキストチャンネルとそのスレッドは従来どおり共有です。

### スレッド間の干渉を避ける

- セッション・キュー・作業ディレクトリはスレッド（フォーラム投稿）ごとに独立しています。
- 他のスレッドが使用中のディレクトリへ `/cwd` しようとすると、既定では拒否します。意図的に共有する場合だけ `/cwd path:<path> force:true` を使ってください（`CWD_CONFLICT=warn` にすると拒否せずログだけ残します）。
- 各スレッドの作業ディレクトリには `AGENTS.md` が作られ、スレッド名・作成日・最終作業・session・model・effort が自動更新されます。**既存の `AGENTS.md` には追記せず、bot が作ったマーカーブロックがある場合だけ更新します**。

### ディスク容量の自動調整

`/srv` の使用率が `STORAGE_TARGET_PERCENT`（既定 75%）を超えると、**bot が自動作成したスレッド作業ディレクトリ**を最終作業の古い順に削除します。1 回 5 件まで、実行中のスレッドは対象外です。

- SMART が `warning` / `critical` のときは目標を `STORAGE_DEGRADED_PERCENT`（既定 60%）に強めて HDD を守ります。
- 削除前に `node_modules` / `dist` / `.discord-uploads` などの再生成可能なディレクトリを先に消します。
- `/cwd` で自分で指定したディレクトリ、`DEFAULT_CWD` 直下のファイル、シンボリックリンクは**削除しません**。
- `/storage` で使用量・SMART 判定・削除候補を確認できます（表示のみで削除はしません）。
- `STORAGE_TARGET_PERCENT=0` で自動削除を無効化できます。

## ファイルの受け渡し

- メッセージに添付したファイルは `<cwd>/.discord-uploads/` に保存され、cmd にパスが渡されます。`.discord-uploads/.gitignore` を自動で置くので、リポジトリの `git status` は汚れません。
- 保存した添付は `UPLOAD_TTL_HOURS`（既定 24 時間）を過ぎると削除されます。起動時と `UPLOAD_SWEEP_INTERVAL_MINUTES`（既定 60 分）ごとに、`ALLOWED_ROOTS` 配下の `.discord-uploads` を走査します。`0` を指定すると削除しません。
- cmd が回答の末尾に `[[attach:relative/path]]` を含めると、そのファイルを Discord に返します。
- 返却できるのは cwd 配下の通常ファイルのみ。`.env`、`.git`、`node_modules` などは拒否します。
- 1 ファイル 24MB、最大 10 ファイルまで。

## セキュリティ

- SSH は鍵認証のみ（パスワード認証・root ログイン無効）、ufw は 22/tcp のみ許可。
- bot は `cmdbot` で実行し、systemd の sandbox（`ProtectSystem=strict`、`NoNewPrivileges` など）で動作。
- `.env` は root 所有 600。トークンは systemd の `EnvironmentFile` 経由でのみ読み、`cmd` 子プロセスには秘密の環境変数を渡さない。
- `~/.commandcode/settings.json` の deny ルールで sudo / systemctl / 秘密ファイルの読み取りを禁止。
- さらに `PreToolUse` hook（`deploy/guard.sh`）で方針を決定論的に強制します。
  - 作業ディレクトリ（`ALLOWED_ROOTS`、既定 `/srv/work`）の中だけ読み書きできる。
  - サーバー構成ファイル（`/etc`、`/boot`、`/root`、`/sys`、`/proc`、`/var/lib`、`/var/log`、`/home/cmdbot`、`/srv/work` 以外の `/srv`）は読めない。
  - 例外として稼働状況の確認だけ許可する: `systemctl status` / `is-active` / `is-failed` / `show` / `cat` / `list-*`、`journalctl`、`sensors`、`df`、`free`、`ps`、`uptime` など。
  - `systemctl restart` などの変更操作、`sudo`、`mkfs`、`dd`、`chown`、`chmod`、ラッパー経由の実行は拒否する。
- プロンプトは `<untrusted_message nonce="…">` で区切り、作業中に読むファイル・添付・Web ページ・ツール出力は命令ではなくデータとして扱うよう明示します。リポジトリ内の `AGENTS.md` などに書かれた指示で権限設定や秘密の扱いを変えないようにしています。
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
| `ALLOWED_CHANNEL_IDS` | 許可するチャンネル ID（空なら全チャンネル）。フォーラム本体を指定すれば配下の投稿も許可される |
| `ALLOWED_ROOTS` | `/cwd` で移動できるルート（必須） |
| `CMD_BIN` | `cmd` の絶対パス |
| `MAX_CONCURRENCY` | 同時に走らせる cmd の上限（既定 3） |
| `SESSIONS_FILE` | セッション状態の保存先 |
| `FORUM_CWD` | `auto`（投稿ごとに cwd を自動作成）/ `shared`（共有） |
| `UPLOAD_TTL_HOURS` | 添付を残す時間（既定 24、0 で削除しない） |
| `UPLOAD_SWEEP_INTERVAL_MINUTES` | 添付削除の実行間隔（既定 60、最小 5） |
| `STORAGE_TARGET_PERCENT` | 作業領域の目標使用率（既定 75、0 で自動削除を無効化） |
| `STORAGE_DEGRADED_PERCENT` | SMART 劣化時の目標使用率（既定 60） |
| `STORAGE_SWEEP_INTERVAL_MINUTES` | 容量調整の実行間隔（既定 60、最小 10） |
| `SMART_FILE` | `disk-health.timer` が書く SMART スナップショットのパス |
| `WORKDIR_META` | `AGENTS.md` の自動更新範囲（`thread` / `always` / `off`） |
| `CWD_CONFLICT` | 使用中ディレクトリへの `/cwd`（`deny` / `warn`） |
| `TRIGGER_MODE` | `prefix`（`!` 必須、既定）/ `all`（全メッセージに反応） |
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

### SMART スナップショット（任意）

容量調整を HDD の健康状態に連動させるため、root の timer が 1 時間ごとに SMART を書き出す。

```bash
sudo install -o root -g root -m 755 deploy/disk-health /usr/local/sbin/disk-health
sudo install -o root -g root -m 644 deploy/disk-health.service /etc/systemd/system/
sudo install -o root -g root -m 644 deploy/disk-health.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now disk-health.timer
sudo systemctl start disk-health.service
cat /var/lib/commandcode-discordbot/smart.json
```

監視するデバイスは既定で `/dev/sdb`。変える場合は `/etc/default/disk-health` に `DISK_DEVICE=/dev/sdX` を置く。`smartctl` が使えない場合は `verdict:"unavailable"` が書かれ、bot は使用率だけで判定する。

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
