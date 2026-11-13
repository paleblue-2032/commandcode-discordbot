import { stat } from 'node:fs/promises';
import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
  type Attachment,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type MessageCreateOptions,
} from 'discord.js';
import {
  extractAttachmentMarkers,
  saveAttachments,
  type ExtractResult,
  type FileToSend,
  type SavedAttachment,
} from './attachments.js';
import type { Config } from './config.js';
import { formatDuration, splitMessage, stripAnsi, truncate } from './format.js';
import { errorMessage, logger } from './logger.js';
import { listModels, type ModelInfo } from './models.js';
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
  sendFiles(files: FileToSend[]): Promise<void>;
}

interface SendableChannel {
  send(options: MessageCreateOptions): Promise<Message>;
}

function isSendable(
  channel: Message['channel'],
): channel is Message['channel'] & SendableChannel {
  return typeof (channel as { send?: unknown }).send === 'function';
}

function attachmentBuilders(files: FileToSend[]): AttachmentBuilder[] {
  return files.map(
    (file) => new AttachmentBuilder(file.path, { name: file.name }),
  );
}

const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

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
    .setName('model')
    .setDescription('モデルと推論の強さを表示・変更する')
    .addStringOption((option) =>
      option
        .setName('model')
        .setDescription('モデル ID（入力で候補を絞り込み）')
        .setAutocomplete(true)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('effort')
        .setDescription('推論の強さ（off / low / medium / high / xhigh / max）')
        .setAutocomplete(true)
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('現在の cwd とセッション状態を表示する'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('実行中の処理を停止する'),
  new SlashCommandBuilder()
    .setName('usage')
    .setDescription('使用量・クレジットの確認先を表示する'),
].map((command) => command.toJSON());

function lastStderrLine(stderr: string): string | null {
  const lines = stripAnsi(stderr)
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length > 0 ? lines[lines.length - 1]! : null;
}

function buildPrompt(
  prompt: string,
  files: SavedAttachment[],
  errors: string[],
): string {
  const lines = [
    'If you need to return files to the user, append [[attach:relative/path]] for each file at the end of your answer. Only files under the current working directory can be returned.',
  ];

  if (files.length > 0) {
    lines.push('', 'Attached files:');
    for (const file of files) {
      lines.push(`- ${file.path} (${file.type}, ${file.size} bytes)`);
    }
  }

  if (errors.length > 0) {
    lines.push('', `Attachment errors: ${errors.join('; ')}`);
  }

  lines.push('', 'User message:', prompt === '' ? '(no text; see the attached files)' : prompt);
  return lines.join('\n');
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
  private modelCache: ModelInfo[] | null = null;
  private modelCacheAt = 0;
  private modelLoad: Promise<ModelInfo[]> | null = null;
  private modelFailureAt = 0;

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

    void this.getModels();
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
      const attachments = [...message.attachments.values()];
      if (prompt === '' && attachments.length === 0) return;

      const ui = this.messageUi(message);
      if (!ui) {
        logger.warn(`送信できないチャンネルです: ${message.channelId}`);
        return;
      }

      await this.handlePrompt(message.channelId, prompt, ui, attachments, message.id);
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
      sendFiles: async (files) => {
        for (let index = 0; index < files.length; index += 10) {
          await channel.send({
            files: attachmentBuilders(files.slice(index, index + 10)),
            allowedMentions: { parse: [] },
          });
        }
      },
    };
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      await this.onAutocomplete(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    try {
      if (!this.isAllowedUser(interaction.user.id)) {
        await interaction.reply({
          content: 'この操作は許可されていません。',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!this.isAllowedChannel(interaction.channelId)) {
        await interaction.reply({
          content: 'このチャンネルは許可されていません。',
          flags: MessageFlags.Ephemeral,
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
        case 'model':
          await this.handleModel(interaction);
          break;
        case 'usage':
          await this.handleUsage(interaction);
          break;
        default:
          break;
      }
    } catch (error) {
      logger.error(`インタラクション処理に失敗しました: ${errorMessage(error)}`);
      try {
        const content = `エラー: ${errorMessage(error)}`;
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
      } catch {
        // ignore secondary failures
      }
    }
  }

  private async onAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    try {
      if (
        !this.isAllowedUser(interaction.user.id) ||
        !this.isAllowedChannel(interaction.channelId)
      ) {
        await interaction.respond([]);
        return;
      }
      if (interaction.commandName !== 'model') {
        await interaction.respond([]);
        return;
      }

      const focused = interaction.options.getFocused(true);
      const query = String(focused.value ?? '').toLowerCase();

      if (focused.name === 'effort') {
        const record = this.sessions.get(interaction.channelId, this.config.defaultCwd);
        const current = record.effort ?? this.config.defaultEffort;
        const values = new Map<string, string>();
        if (current && current.includes(query)) {
          values.set(current, `${current} (現在)`);
        }
        if ('default'.includes(query)) {
          values.set('default', 'default (既定に戻す)');
        }
        for (const level of EFFORTS) {
          if (level.includes(query)) values.set(level, level);
        }
        await interaction.respond(
          [...values.entries()]
            .slice(0, 25)
            .map(([value, name]) => ({ name, value })),
        );
        return;
      }

      if (focused.name !== 'model') {
        await interaction.respond([]);
        return;
      }

      const record = this.sessions.get(interaction.channelId, this.config.defaultCwd);
      const current = record.model ?? this.config.defaultModel;
      const models = await this.getModelsWithTimeout();
      const choices = new Map<string, string>();

      if (current && current.toLowerCase().includes(query)) {
        choices.set(current, truncate(`${current} (現在)`, 100));
      }
      if ('default'.includes(query)) {
        choices.set('default', 'default (既定に戻す)');
      }
      for (const model of models) {
        if (!model.id.toLowerCase().includes(query)) continue;
        if (choices.has(model.id)) continue;
        choices.set(
          model.id,
          truncate(`${model.id} — ${model.description}`, 100),
        );
        if (choices.size >= 25) break;
      }

      await interaction.respond(
        [...choices.entries()]
          .slice(0, 25)
          .map(([value, name]) => ({ name, value })),
      );
    } catch (error) {
      logger.error(`autocomplete に失敗しました: ${errorMessage(error)}`);
      try {
        await interaction.respond([]);
      } catch {
        // ignore secondary failures
      }
    }
  }

  private async getModels(): Promise<ModelInfo[]> {
    const now = Date.now();
    if (this.modelCache && now - this.modelCacheAt < 10 * 60 * 1000) {
      return this.modelCache;
    }
    if (now - this.modelFailureAt < 60 * 1000) {
      return [];
    }
    if (this.modelLoad) {
      return this.modelLoad;
    }

    this.modelLoad = listModels(this.config.cmdBin, this.config.defaultCwd)
      .then((models) => {
        this.modelCache = models;
        this.modelCacheAt = Date.now();
        return models;
      })
      .catch((error: unknown) => {
        this.modelFailureAt = Date.now();
        logger.warn(`モデル一覧を取得できませんでした: ${errorMessage(error)}`);
        return [];
      })
      .finally(() => {
        this.modelLoad = null;
      });

    return this.modelLoad;
  }

  private async getModelsWithTimeout(): Promise<ModelInfo[]> {
    return Promise.race([
      this.getModels(),
      new Promise<ModelInfo[]>((resolve) => {
        const timer = setTimeout(() => resolve([]), 2400);
        timer.unref();
      }),
    ]);
  }

  private async handleAsk(interaction: ChatInputCommandInteraction): Promise<void> {
    const prompt = interaction.options.getString('prompt', true).trim();
    if (prompt === '') {
      await interaction.reply({ content: 'プロンプトが空です。', flags: MessageFlags.Ephemeral });
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
      sendFiles: async (files) => {
        for (let index = 0; index < files.length; index += 10) {
          await interaction.followUp({
            files: attachmentBuilders(files.slice(index, index + 10)),
            allowedMentions: { parse: [] },
          });
        }
      },
    };

    await this.handlePrompt(interaction.channelId, prompt, ui, [], null);
  }

  private async handleNew(interaction: ChatInputCommandInteraction): Promise<void> {
    const record = this.sessions.get(interaction.channelId, this.config.defaultCwd);
    await this.sessions.clearSession(interaction.channelId);
    await interaction.reply({
      content: `セッションをリセットしました。\ncwd: \`${record.cwd}\``,
      flags: MessageFlags.Ephemeral,
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
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await interaction.reply({
        content: `変更できません: ${errorMessage(error)}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private async handleModel(interaction: ChatInputCommandInteraction): Promise<void> {
    const modelInputRaw = interaction.options.getString('model');
    const effortInputRaw = interaction.options.getString('effort');
    const modelInput = modelInputRaw === null ? null : modelInputRaw.trim();
    const effortInput =
      effortInputRaw === null ? null : effortInputRaw.trim().toLowerCase();

    let nextModel: string | null | undefined;
    if (modelInput !== null && modelInput !== '') {
      if (modelInput === 'default' || modelInput === 'reset') {
        nextModel = null;
      } else if (!/^[A-Za-z0-9._:/-]+$/.test(modelInput)) {
        await interaction.reply({
          content: `モデル ID の形式が不正です: \`${modelInput}\``,
          flags: MessageFlags.Ephemeral,
        });
        return;
      } else {
        nextModel = modelInput;
      }
    }

    let nextEffort: string | null | undefined;
    if (effortInput !== null && effortInput !== '') {
      if (effortInput === 'default' || effortInput === 'reset') {
        nextEffort = null;
      } else if (!(EFFORTS as readonly string[]).includes(effortInput)) {
        await interaction.reply({
          content: `effort は ${EFFORTS.join(' / ')} のいずれかです。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      } else {
        nextEffort = effortInput;
      }
    }

    if (nextModel !== undefined) {
      await this.sessions.setModel(interaction.channelId, nextModel);
    }
    if (nextEffort !== undefined) {
      await this.sessions.setEffort(interaction.channelId, nextEffort);
    }

    const record = this.sessions.get(interaction.channelId, this.config.defaultCwd);
    const model = record.model ?? this.config.defaultModel;
    const effort = record.effort ?? this.config.defaultEffort;
    const changed = nextModel !== undefined || nextEffort !== undefined;
    const lines = [
      `model: ${model ? `\`${model}\`` : 'デフォルト'}`,
      `effort: ${effort ? `\`${effort}\`` : 'デフォルト'}`,
      changed
        ? '次のメッセージから適用されます。'
        : '変更するには model / effort を指定してください（候補から選択できます）。',
    ];
    await interaction.reply({
      content: lines.join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleUsage(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply({
      content:
        '使用量・クレジットは対話モードの `/usage` か https://commandcode.ai/usage で確認できます。ヘッドレス実行からは実数値を取得できません。',
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    const record = this.sessions.get(interaction.channelId, this.config.defaultCwd);
    const model = record.model ?? this.config.defaultModel;
    const effort = record.effort ?? this.config.defaultEffort;
    const running = this.active.has(interaction.channelId);
    const lines = [
      `cwd: \`${record.cwd}\``,
      `session: ${record.sessionId ? `\`${record.sessionId}\`` : 'なし'}`,
      `model: ${model ? `\`${model}\`` : 'デフォルト'}`,
      `effort: ${effort ? `\`${effort}\`` : 'デフォルト'}`,
      `状態: ${running ? '実行中' : '待機中'}`,
      `同時実行上限: ${this.config.maxConcurrency}`,
      `稼働時間: ${formatDuration(Date.now() - this.startedAt)}`,
    ];
    await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
  }

  private async handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
    const controller = this.active.get(interaction.channelId);
    if (!controller) {
      await interaction.reply({
        content: '実行中の処理はありません。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    controller.abort();
    await interaction.reply({ content: '停止しました。', flags: MessageFlags.Ephemeral });
  }

  private async handlePrompt(
    channelId: string,
    prompt: string,
    ui: PromptUi,
    attachments: Attachment[] = [],
    messageId: string | null = null,
  ): Promise<void> {
    const progressUi = await this.safeCreateProgress(ui);

    const job = this.queue.run(channelId, async () => {
      const record = this.sessions.get(channelId, this.config.defaultCwd);
      await this.ensureCwd(record.cwd);

      let saved: SavedAttachment[] = [];
      let attachmentErrors: string[] = [];
      if (attachments.length > 0 && messageId) {
        const attachmentResult = await saveAttachments(attachments, record.cwd, messageId);
        saved = attachmentResult.saved;
        attachmentErrors = attachmentResult.errors;
      }
      const effectivePrompt = buildPrompt(prompt, saved, attachmentErrors);
      const model = record.model ?? this.config.defaultModel;
      const effort = record.effort ?? this.config.defaultEffort;

      const controller = new AbortController();
      this.active.set(channelId, controller);
      const progress = new Progress(progressUi, this.config.progressIntervalMs);
      progress.start();

      try {
        logger.info(
          `実行開始 channel=${channelId} cwd=${record.cwd} resume=${record.sessionId ? 'yes' : 'no'} model=${model ?? 'default'} effort=${effort ?? 'default'} attachments=${saved.length}`,
        );
        const run = await runCmd({
          cmdBin: this.config.cmdBin,
          prompt: effectivePrompt,
          cwd: record.cwd,
          sessionId: record.sessionId,
          model,
          effort,
          maxTurns: this.config.maxTurns,
          signal: controller.signal,
          onEvent: (event) => progress.handleEvent(event),
        });
        logger.info(
          `実行終了 channel=${channelId} exit=${run.exitCode} duration=${run.durationMs}ms`,
        );
        await this.completeRun(channelId, run, ui, progress, record.cwd);
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
    cwd: string,
  ): Promise<void> {
    const result: ResultPayload | null = run.result;
    const rawText = result?.finalText?.trim() ?? '';
    const extracted: ExtractResult =
      rawText === ''
        ? { text: '', files: [], errors: [] }
        : await extractAttachmentMarkers(rawText, cwd);
    const finalText = extracted.text;
    const files = run.aborted ? [] : extracted.files;
    const fileErrors = extracted.errors;
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

    if (files.length > 0) {
      status += `\n添付: ${files.length} ファイル`;
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

    if (files.length > 0) {
      try {
        await ui.sendFiles(files);
      } catch (error) {
        logger.error(`ファイルの送信に失敗しました: ${errorMessage(error)}`);
        try {
          await ui.sendAnswer(
            truncate(`ファイル送信に失敗しました: ${errorMessage(error)}`, 1900),
          );
        } catch {
          // ignore secondary failures
        }
      }
    }

    if (fileErrors.length > 0) {
      try {
        await ui.sendAnswer(
          truncate(`添付できなかったファイル: ${fileErrors.join(', ')}`, 1900),
        );
      } catch {
        // ignore secondary failures
      }
    }
  }
}
