# セットアップ手順

自宅サーバー（Ubuntu Server 24.04 / Debian 12 想定）での構築手順。

## 1. OS

Ubuntu Server 24.04 LTS を SSD 128GB にインストール。HDD 250GB は `/srv` にマウントして作業用にする。

```bash
lsblk -o NAME,SIZE,TYPE,TRAN,MODEL
sudo mkfs.ext4 /dev/sdb1
echo "UUID=$(sudo blkid -s UUID -o value /dev/sdb1) /srv ext4 defaults,noatime 0 2" | sudo tee -a /etc/fstab
sudo mount -a
```

## 2. Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs build-essential
node -v   # v22.x
```

## 3. 専用ユーザー

bot と cmd を同じユーザーで動かす。作業ディレクトリだけ書き込みを許可する。

```bash
sudo useradd -m -s /bin/bash cmdbot
sudo mkdir -p /srv/work && sudo chown cmdbot:cmdbot /srv/work
sudo -iu cmdbot
```

## 4. Command Code の導入とログイン

```bash
npm i -g command-code
cmd login
```

**ここが唯一の詰まりどころ。** `cmd login` は localhost で OAuth コールバックを待つ。SSH 越しなら、表示された URL を手元ブラウザで開き、コールバックを SSH ポートフォワードで受ける。

```bash
# 手元の PC で
ssh -L 54545:localhost:54545 cmdbot@<server>
```

ポート番号は実際に表示されたものに合わせる。これが通らない場合は手順 4' へ。

### 4'. BYOK で回避する場合

`~/.commandcode/providers.json` に Provider API を直接叩く設定を書く。

```json
{
  "providers": {
    "commandcode": {
      "name": "Command Code",
      "api": "openai-completions",
      "baseURL": "https://api.commandcode.ai/provider/v1",
      "apiKey": "$CMD_API_KEY",
      "models": [{ "id": "claude-sonnet-4-6" }]
    }
  }
}
```

```bash
export CMD_API_KEY=...   # ~/.bashrc か systemd の EnvironmentFile に入れる
```

API キーは Studio (`commandcode.ai/settings/keys`) で発行する。**Go プランでは API が使えない。**

代償: `/share`、`/usage`、`web_search`、`web_fetch`、`cmd taste push/pull` が使えなくなる。

## 5. 動作確認

```bash
cd /srv/work/some-repo
cmd -p "このリポジトリの構成を3行で" --output-format json | tail -1
```

`{"type":"result","subtype":"success",...}` が返れば成功。

## 6. 権限設定

`/srv/work/.commandcode/settings.json` に置く。**`ask` ルールは書かない**（誰も答えられずハングする）。

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

## 7. Discord bot の準備

1. [discord.com/developers/applications](https://discord.com/developers/applications) でアプリ作成 → Bot 追加
2. **Message Content Intent** を ON（必須。OFF だと本文が空で届く）
3. OAuth2 → URL Generator で `bot` + `applications.commands` を選択
   権限: View Channels / Send Messages / Read Message History / Embed Links / Attach Files
4. 生成された URL でサーバーに招待
5. Bot トークンを控える
6. Discord の開発者モードを有効化し、自分のユーザー ID と使うチャンネル ID を控える

## 8. bot の配置と環境変数

```
/srv/commandcode-discordbot/
  .env          # 600, cmdbot 所有
  sessions.json
```

```bash
# .env
DISCORD_TOKEN=...
ALLOWED_USER_IDS=123456789012345678
ALLOWED_CHANNEL_IDS=123456789012345678
ALLOWED_ROOTS=/srv/work
CMD_BIN=/usr/bin/cmd
MAX_CONCURRENCY=1
```

```bash
chmod 600 /srv/commandcode-discordbot/.env
```

## 9. systemd

`/etc/systemd/system/commandcode-discordbot.service`

```ini
[Unit]
Description=Command Code Discord bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cmdbot
WorkingDirectory=/srv/commandcode-discordbot
EnvironmentFile=/srv/commandcode-discordbot/.env
ExecStart=/usr/bin/node /srv/commandcode-discordbot/dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/srv/work /srv/commandcode-discordbot

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now commandcode-discordbot
journalctl -u commandcode-discordbot -f
```

## 10. 認証切れの監視

`cmd login` のセッションは期限切れになる。終了コード 3 が返り続けたら再ログインが要る。

```bash
sudo -iu cmdbot
cmd status
```

必要なら `systemd` の `OnFailure=` で通知を飛ばす。

## トラブルシューティング

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| `command not found` | npm のグローバル bin が PATH に無い | `npm config get prefix` の `bin` を PATH に追加 |
| ログインが完了しない | OAuth コールバックが届かない | SSH ポートフォワード、または手順 4' |
| Discord で本文が空 | Message Content Intent が OFF | Developer Portal で ON |
| 応答が来ない | 誰も答えられないプロンプトで待機 | `ask` ルールを消す |
| 401 / 未認証 | セッション期限切れ | `cmd logout` → `cmd login` |
| クレジット不足 | 残高切れ | `commandcode.ai/billing` |
