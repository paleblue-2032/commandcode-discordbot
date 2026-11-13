import { stat } from 'node:fs/promises';
import {
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
} from 'discord.js';
import type { Config } from './config.js';
import { formatDuration, splitMessage, stripAnsi, truncate } from './format.js';
import { errorMessage, logger } from './logger.js';
import { resolveDirectory } from './paths.js';
import { Progress } from './progress.js';
import { ChannelQueue } from './queue.js';
import {
  describeExitCode,
  runCmd,
  type ResultPayload,
  type RunResult,
} from './runner.js';
import type { SessionStore } from './sessions.js';

interface ProgressUi {
  edit(content: string): Promise<unknown>;
}

interface PromptUi {
  createProgress(content: string): Promise<ProgressUi>;
  sendAnswer(content: string): Promise<void>;
}

interface SendableChannel {
  send(options: {
    content: string;
    allowedMentions?: { parse: [] };
  }): Promise<Message>;
}

function isSendable(
  channel: Message['channel'],
): channel is Message['channel'] & SendableChannel {
  return typeof (channel as { send?: unknown }).send === 'function';
}

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('このチャンネルのセッションにプロンプトを送る')
    .addStringOption((option) =>
      option.setName('prompt').setDescription('送信するプロンプト').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('new')
    .setDescription('セッションを捨てて新しく始める'),
  new SlashCommandBuilder()
    .setName('cwd')
    .setDescription('作業ディレクトリを変更する')
    .addStringOption((option) =>
      option.setName('path').setDescription('許可ルート配下のパス').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('現在の cwd とセッション状態を表示する'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('実行中の処理を停止する'),
].map((command) => command.toJSON());

function lastStderrLine(stderr: string): string | null {
  const lines = stripAnsi(stderr)
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length > 0 ? lines[lines.length - 1]! : null;
}

export class Bot {
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  private readonly queue: ChannelQueue;
  private readonly active = new Map<string, AbortController>();
  private readonly startedAt = Date.now();

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionStore,
  ) {
    this.queue = new ChannelQueue(config.maxConcurrency);
    this.client.once(Events.ClientReady, (readyClient) => {
      void this.onReady(readyClient);
    });
    this.client.on(Events.MessageCreate, (message) => {
      void this.onMessage(message);
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.onInteraction(interaction);
    });
    this.client.on(Events.Error, (error) => {
      logger.error(`Discord クライアントエラー: ${errorMessage(error)}`);
    });
  }

  start(): Promise<string> {
    return this.client.login(this.config.discordToken);
  }

  async stop(): Promise<void> {
    for (const controller of this.active.values()) {
      controller.abort();
    }
    await this.client.destroy();
  }

  private async onReady(client: Client<true>): Promise<void> {
    logger.info(`Discord に接続しました: ${client.user.tag}`);
    try {
      const application = client.application;
      if (!application) {
        logger.warn('application が取得できないためコマンドを登録できません。');
        return;
      }
      if (this.config.guildId) {
        await application.commands.set(COMMANDS, this.config.guildId);
      } else {
        await application.commands.set(COMMANDS);
      }
      logger.info(`スラッシュコマンドを登録しました: ${COMMANDS.length} 件`);
    } catch (error) {
      logger.error(`スラッシュコマンドの登録に失敗しました: ${errorMessage(error)}`);
    }
  }

  private isAllowedUser(userId: string): boolean {
    return this.config.allowedUserIds.has(userId);
  }

  private isAllowedChannel(channelId: string): boolean {
    return (
      this.config.allowedChannelIds.size === 0 ||
      this.config.allowedChannelIds.has(channelId)
    );
  }

  private async onMessage(message: Message): Promise<void> {
    try {
      if (message.author.bot || message.system) return;
      if (!this.isAllowedUser(message.author.id)) return;
      if (!this.isAllowedChannel(message.channelId)) return;

      const prompt = message.content.trim();
      if (prompt === '') return;

      const ui = this.messageUi(message);
      if (!ui) {
        logger.warn(`送信できないチャンネルです: ${message.channelId}`);
        return;
      }

      await this.handlePrompt(message.channelId, prompt, ui);
    } catch (error) {
      logger.error(`メッセージ処理に失敗しました: ${errorMessage(error)}`);
    }
  }

  private messageUi(message: Message): PromptUi | null {
    const channel = message.channel;
    if (!isSendable(channel)) return null;

    return {
      createProgress: async (content) => {
        const sent = await channel.send({
          content,
          allowedMentions: { parse: [] },
        });
        return {
          edit: (next) =>
            sent.edit({
              content: next,
              allowedMentions: { parse: [] },
            }),
        };
      },
      sendAnswer: async (content) => {
        await channel.send({
          content,
          allowedMentions: { parse: [] },
        });
      },
    };
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    try {
      if (!this.isAllowedUser(interaction.user.id)) {
        await interaction.reply({
          content: 'この操作は許可されていません。',
          ephemeral: true,
        });
        return;
      }
      if (!this.isAllowedChannel(interaction.channelId)) {
        await interaction.reply({
          content: 'このチャンネルは許可されていません。',
          ephemeral: true,
        });
        return;
      }

      switch (interaction.commandName) {
        case 'ask':
          await this.handleAsk(interaction);
          break;
        case 'new':
          await this.handleNew(interaction);
          break;
        case 'cwd':
          await this.handleCwd(interaction);
          break;
        case 'status':
          await this.handleStatus(interaction);
          break;
        case 'stop':
          await this.handleStop(interaction);
          break;
        default:
          break;
      }
    } catch (error) {
      logger.error(`インタラクション処理に失敗しました: ${errorMessage(error)}`);
      try {
        const content = `エラー: ${errorMessage(error)}`;
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content, ephemeral: true });
        } else {
          await interaction.reply({ content, ephemeral: true });
        }
      } catch {
        // ignore secondary failures
      }
    }
  }

  private async handleAsk(interaction: ChatInputCommandInteraction): Promise<void> {
    const prompt = interaction.options.getString('prompt', true).trim();
    if (prompt === '') {
      await interaction.reply({ content: 'プロンプトが空です。', ephemeral: true });
      return;
    }

    await interaction.deferReply();
    const ui: PromptUi = {
      createProgress: async (content) => {
        await interaction.editReply({
          content,
          allowedMentions: { parse: [] },
        });
        return {
          edit: (next) =>
            interaction.editReply({
              content: next,
              allowedMentions: { parse: [] },
            }),
        };
      },
      sendAnswer: async (content) => {
        await interaction.followUp({
          content,
          allowedMentions: { parse: [] },
        });
      },
    };

    await this.handlePrompt(interaction.channelId, prompt, ui);
  }

  private async handleNew(interaction: ChatInputCommandInteraction): Promise<void> {
    const record = this.sessions.get(interaction.channelId, this.config.defaultCwd);
    await this.sessions.clearSession(interaction.channelId);
    await interaction.reply({
      content: `セッションをリセットしました。\ncwd: \`${record.cwd}\``,
      ephemeral: true,
    });
  }

  private async handleCwd(interaction: ChatInputCommandInteraction): Promise<void> {
    const input = interaction.options.getString('path', true);
    const record = this.sessions.get(interaction.channelId, this.config.defaultCwd);
    try {
      const target = await resolveDirectory(input, this.config.allowedRoots, record.cwd);
      await this.sessions.setCwd(interaction.channelId, target);
      await interaction.reply({
        content: `cwd を変更しました: \`${target}\`\nセッションはリセットされました。`,
        ephemeral: true,
      });
    } catch (error) {
      await interaction.reply({
        content: `変更できません: ${errorMessage(error)}`,
        ephemeral: true,
      });
    }
  }

  private async handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    const record = this.sessions.get(interaction.channelId, this.config.defaultCwd);
    const running = this.active.has(interaction.channelId);
    const lines = [
      `cwd: \`${record.cwd}\``,
      `session: ${record.sessionId ? `\`${record.sessionId}\`` : 'なし'}`,
      `状態: ${running ? '実行中' : '待機中'}`,
      `同時実行上限: ${this.config.maxConcurrency}`,
      `稼働時間: ${formatDuration(Date.now() - this.startedAt)}`,
    ];
    await interaction.reply({ content: lines.join('\n'), ephemeral: true });
  }

  private async handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
    const controller = this.active.get(interaction.channelId);
    if (!controller) {
      await interaction.reply({
        content: '実行中の処理はありません。',
        ephemeral: true,
      });
      return;
    }
    controller.abort();
    await interaction.reply({ content: '停止しました。', ephemeral: true });
  }

  private async handlePrompt(
    channelId: string,
    prompt: string,
    ui: PromptUi,
  ): Promise<void> {
    const progressUi = await this.safeCreateProgress(ui);

    const job = this.queue.run(channelId, async () => {
      const record = this.sessions.get(channelId, this.config.defaultCwd);
      await this.ensureCwd(record.cwd);

      const controller = new AbortController();
      this.active.set(channelId, controller);
      const progress = new Progress(progressUi, this.config.progressIntervalMs);
      progress.start();

      try {
        logger.info(
          `実行開始 channel=${channelId} cwd=${record.cwd} resume=${record.sessionId ? 'yes' : 'no'}`,
        );
        const run = await runCmd({
          cmdBin: this.config.cmdBin,
          prompt,
          cwd: record.cwd,
          sessionId: record.sessionId,
          maxTurns: this.config.maxTurns,
          signal: controller.signal,
          onEvent: (event) => progress.handleEvent(event),
        });
        logger.info(
          `実行終了 channel=${channelId} exit=${run.exitCode} duration=${run.durationMs}ms`,
        );
        await this.completeRun(channelId, run, ui, progress);
      } finally {
        if (this.active.get(channelId) === controller) {
          this.active.delete(channelId);
        }
      }
    });

    try {
      await job;
    } catch (error) {
      logger.error(`実行に失敗しました: ${errorMessage(error)}`);
      try {
        await progressUi.edit(truncate(`失敗: ${errorMessage(error)}`, 1900));
      } catch {
        // ignore secondary failures
      }
    }
  }

  private async safeCreateProgress(ui: PromptUi): Promise<ProgressUi> {
    try {
      return await ui.createProgress('待機中…');
    } catch (error) {
      logger.warn(`進捗メッセージを作成できませんでした: ${errorMessage(error)}`);
      return {
        edit: async () => undefined,
      };
    }
  }

  private async ensureCwd(cwd: string): Promise<void> {
    let info;
    try {
      info = await stat(cwd);
    } catch {
      throw new Error(`cwd が存在しません: ${cwd}\n/cwd で変更してください。`);
    }
    if (!info.isDirectory()) {
      throw new Error(`cwd がディレクトリではありません: ${cwd}`);
    }
  }

  private async completeRun(
    channelId: string,
    run: RunResult,
    ui: PromptUi,
    progress: Progress,
  ): Promise<void> {
    const result: ResultPayload | null = run.result;
    const finalText = result?.finalText?.trim() ?? '';
    let answer: string | null = null;
    let status: string;

    if (run.aborted) {
      status = '停止しました。';
    } else if (run.spawnError) {
      status = `cmd を起動できませんでした: ${truncate(run.spawnError, 500)}`;
    } else if (run.exitCode === 0 && result?.subtype === 'success') {
      status = `完了 (${formatDuration(run.durationMs)})`;
      answer = finalText === '' ? null : finalText;
      if (!answer) status += '\n応答は空でした。';
    } else if (run.exitCode === 0 && result?.subtype === 'max_turns') {
      status = `最大ターン数に達しました (${formatDuration(run.durationMs)})\nプロンプトを分割するか、CMD_MAX_TURNS を増やしてください。`;
      answer = finalText === '' ? null : finalText;
    } else {
      status = `失敗: ${describeExitCode(run.exitCode)} (${formatDuration(run.durationMs)})`;
      const detail = result?.error ?? lastStderrLine(run.stderr);
      if (detail) status += `\n${truncate(detail, 500)}`;
      answer = finalText === '' ? null : finalText;

      if (run.exitCode === 3) {
        status += '\nサーバーで `cmd login` を実行してください。';
      } else if (run.exitCode === 4) {
        status += '\n`.commandcode/settings.json` の deny ルールを確認してください。';
      } else if (run.exitCode === 5) {
        status += '\n少し待ってから再試行してください。';
      } else if (run.exitCode === 6) {
        status += '\nネットワーク接続を確認してください。';
      } else if (run.exitCode === 10) {
        status += '\nhttps://commandcode.ai/billing を確認してください。';
      }
    }

    await progress.finish(truncate(status, 1900));

    if (result?.error?.includes('No session') && !run.sessionId) {
      await this.sessions.clearSession(channelId);
    } else if (run.sessionId) {
      await this.sessions.setSessionId(channelId, run.sessionId);
    }

    if (answer) {
      const chunks = splitMessage(answer, 2000);
      for (const chunk of chunks) {
        try {
          await ui.sendAnswer(chunk);
        } catch (error) {
          logger.error(`応答の投稿に失敗しました: ${errorMessage(error)}`);
          break;
        }
      }
    }
  }
}
