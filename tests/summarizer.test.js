import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, loadConfig } from '../src/config.js';
import {
  DiscordChannelType,
  determineForumPostAnswered,
  discordRestGet,
  fetchChannelMessagesRest,
  fetchForumPostsRest,
  fetchForumThreadsRest,
  fetchGuildChannels,
  fetchUserGuilds,
  snowflakeToTimestamp,
  timestampToSnowflake,
} from '../src/services/discordUserClient.js';
import { normalizeMessage, buildTranscriptAndStats, fetchChannelMessages } from '../src/services/messageFetcher.js';
import {
  GENERAL_CHAT_SYSTEM_PROMPT,
  QA_SYSTEM_PROMPT,
  buildForumTranscript,
  callOpenAICompatibleLLM,
  clipTextCleanly,
  collectKnownAuthors,
  compressOversizedDigestWithLLM,
  enforceConciseDigest,
  extractQuestionsAndDoubts,
  extractTopKeywords,
  redactParticipantNames,
  summarizeMessages,
} from '../src/services/summarizer.js';
import {
  classifyChannelType,
  exportGuildHistory,
  listGuildChannels,
} from '../src/services/serverExporter.js';
import {
  buildChannelMarkdownReport,
  chunkForumPosts,
  chunkMessages,
  generateServerSupportReport,
  matchMasterSectionHeading,
  reduceSummariesBounded,
  summarizeChannelHistory,
} from '../src/services/serverReportGenerator.js';
import { runAnalyzeServerCli } from '../src/analyze-server-cli.js';
import { SAMPLE_SUPPORT_SERVER_EXPORT, runDemo } from '../src/demo-cli.js';

test('CLI validates missing credentials in Phase 1 modes and runs --list-channels, --export, --report, and full mode cleanly', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'discord-cli-test-'));
  const cliPath = fileURLToPath(new URL('../src/analyze-server-cli.js', import.meta.url));
  const runCliSubprocess = (args, extraEnv = {}) =>
    spawnSync(process.execPath, [cliPath, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        DISCORD_USER_TOKEN: '',
        DISCORD_TOKEN: '',
        DISCORD_GUILD_ID: '',
        ...extraEnv,
      },
    });

  try {
    // 1. Missing token validation across Phase 1 modes (--list-channels, --export, default full run)
    for (const args of [['--list-channels'], ['--export'], []]) {
      const missingTokenRes = runCliSubprocess(args, {
        DISCORD_USER_TOKEN: 'your_discord_user_token_here',
        DISCORD_GUILD_ID: 'guild-123',
      });
      assert.equal(missingTokenRes.status, 1, missingTokenRes.stderr);
      assert.match(missingTokenRes.stderr, /Missing DISCORD_USER_TOKEN/);
      assert.doesNotMatch(missingTokenRes.stderr, /discord\.js|Gateway|client\.login/i);
    }

    // 2. Missing guildId validation when token is present
    for (const args of [['--list-channels'], ['--export'], []]) {
      const missingGuildRes = runCliSubprocess(args, {
        DISCORD_USER_TOKEN: 'user-tok-valid',
        DISCORD_GUILD_ID: '',
      });
      assert.equal(missingGuildRes.status, 1, missingGuildRes.stderr);
      assert.match(missingGuildRes.stderr, /Missing DISCORD_GUILD_ID/);
    }

    // 2b. Disallowed Bot/Bearer prefix on DISCORD_USER_TOKEN is rejected cleanly
    for (const prefixedToken of ['Bot abc123', 'Bearer xyz789']) {
      const prefixedTokenRes = runCliSubprocess(['--list-channels'], {
        DISCORD_USER_TOKEN: prefixedToken,
        DISCORD_GUILD_ID: 'guild-123',
      });
      assert.equal(prefixedTokenRes.status, 1, prefixedTokenRes.stderr);
      assert.match(prefixedTokenRes.stderr, /without a "Bot " or "Bearer " prefix/);
    }

    // 3. --report fails cleanly when server-export.json is missing (without needing DISCORD_USER_TOKEN)
    const missingExportRes = runCliSubprocess(['--report'], {
      DISCORD_USER_TOKEN: '',
      DISCORD_GUILD_ID: '',
    });
    assert.equal(missingExportRes.status, 1, missingExportRes.stderr);
    assert.match(missingExportRes.stderr, /Could not find an existing export/);
    assert.doesNotMatch(missingExportRes.stderr, /DISCORD_USER_TOKEN|discord\.js/i);

    // 3b. --report distinguishes corrupted JSON and non-ENOENT IO errors from missing file (ENOENT)
    const corruptExportDir = path.join(dataDir, 'corrupt-case');
    mkdirSync(path.join(corruptExportDir, 'exports'), { recursive: true });
    writeFileSync(
      path.join(corruptExportDir, 'exports', 'server-export.json'),
      '{ "guildId": "123", "channels": [ INVALID JSON ',
      'utf8'
    );
    const corruptExportRes = runCliSubprocess(['--report'], {
      DATA_DIR: corruptExportDir,
      DISCORD_USER_TOKEN: '',
      DISCORD_GUILD_ID: '',
    });
    assert.equal(corruptExportRes.status, 1, corruptExportRes.stderr);
    assert.match(corruptExportRes.stderr, /Invalid or corrupted JSON/);
    assert.doesNotMatch(corruptExportRes.stderr, /Could not find an existing export/);

    const ioErrorDir = path.join(dataDir, 'io-error-case');
    mkdirSync(path.join(ioErrorDir, 'exports', 'server-export.json'), { recursive: true });
    const ioErrorRes = runCliSubprocess(['--report'], {
      DATA_DIR: ioErrorDir,
      DISCORD_USER_TOKEN: '',
      DISCORD_GUILD_ID: '',
    });
    assert.equal(ioErrorRes.status, 1, ioErrorRes.stderr);
    assert.match(ioErrorRes.stderr, /Failed to read export file/);
    assert.doesNotMatch(ioErrorRes.stderr, /Could not find an existing export/);

    // Prepare mock fetch supporting both Discord REST v10 and DeepSeek chat completions
    const recentIso = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    const recentSnowflake = timestampToSnowflake(Date.parse(recentIso));
    const discordCalls = [];
    const llmCalls = [];

    const mockFetch = async (url, init = {}) => {
      const urlStr = String(url);
      if (urlStr.startsWith('https://discord.com/api/v10')) {
        discordCalls.push(urlStr);
        if (urlStr.endsWith('/guilds/guild-123')) {
          return new Response(JSON.stringify({ id: 'guild-123', name: 'CLI Test Server' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (urlStr.endsWith('/guilds/guild-123/channels')) {
          return new Response(
            JSON.stringify([
              { id: 'cat-1', name: 'Junie', type: 4 },
              { id: '111', name: '💬-chat', type: DiscordChannelType.GuildText, parent_id: 'cat-1' },
              { id: '222', name: '🆘-support', type: DiscordChannelType.GuildForum, parent_id: 'cat-1' },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (urlStr.includes('/channels/111/messages')) {
          return new Response(
            JSON.stringify([
              {
                id: recentSnowflake,
                content: 'Testing Junie CLI workflow in WebStorm and IntelliJ IDEA!',
                timestamp: recentIso,
                author: { id: 'u1', username: 'alice', bot: false },
                attachments: [],
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (urlStr.endsWith('/guilds/guild-123/threads/active')) {
          return new Response(
            JSON.stringify({
              threads: [
                {
                  id: recentSnowflake,
                  name: 'How to configure DEEPSEEK_API_KEY?',
                  parent_id: '222',
                  type: DiscordChannelType.PublicThread,
                  thread_metadata: { create_timestamp: recentIso },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (urlStr.includes('/channels/222/threads/archived/public') || urlStr.includes('/channels/222/threads/search')) {
          return new Response(JSON.stringify({ threads: [], has_more: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (urlStr.includes(`/channels/${recentSnowflake}/messages`)) {
          return new Response(
            JSON.stringify([
              {
                id: String(BigInt(recentSnowflake) + 10n),
                content: 'That fixed it, thank you!',
                timestamp: recentIso,
                author: { id: 'u2', username: 'bob', bot: false },
                attachments: [],
              },
              {
                id: String(BigInt(recentSnowflake) + 5n),
                content: 'Set DEEPSEEK_API_KEY in your .env file.',
                timestamp: recentIso,
                author: { id: 'u3', username: 'helper', bot: false },
                attachments: [],
              },
              {
                id: recentSnowflake,
                content: 'How do I configure DEEPSEEK_API_KEY for Phase 2?',
                timestamp: recentIso,
                author: { id: 'u2', username: 'bob', bot: false },
                attachments: [],
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected Discord URL: ${urlStr}`);
      }

      if (urlStr.includes('/chat/completions')) {
        const body = JSON.parse(init.body || '{}');
        llmCalls.push({ url: urlStr, model: body.model });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '### 1. Executive Summary\nMock DeepSeek synthesis.\n\n### 2. Forum & Q&A Channels — Most Frequent Questions & Common Doubts (FAQ)\nMock FAQ.\n\n### 3. General Chat Channels — Main Discussion Topics & Community Vibe\nMock Chat.\n\n### 4. Most Frequently Used Keywords & Technical Terms (Server-wide & Per-Channel)\nMock Keywords.\n\n### 5. Channel-by-Channel Breakdown\nMock Breakdown.\n\n### 6. Meeting Talking Points & Action Items\nMock Action Items.',
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL: ${urlStr}`);
    };

    const silentLogger = { log: () => {}, error: () => {}, warn: () => {} };
    const exportFilePath = path.join(dataDir, 'exports', 'server-export.json');
    const reportFilePath = path.join(dataDir, 'reports', 'support-report-3months.md');

    // 3c. Unknown or conflicting CLI flags fail safely with exitCode 1 and make ZERO Discord or LLM calls
    const initialProcessExitCode = process.exitCode;
    for (const badArgs of [['--repot'], ['--unknown-flag'], ['--list-channels', '--export'], ['--list-channels', '--report']]) {
      discordCalls.length = 0;
      llmCalls.length = 0;
      const errLogs = [];
      const badFlagRes = await runAnalyzeServerCli(badArgs, {
        env: {
          DATA_DIR: dataDir,
          DISCORD_USER_TOKEN: 'user-tok-123',
          DISCORD_GUILD_ID: 'guild-123',
          DEEPSEEK_API_KEY: 'sk-deepseek-test',
        },
        fetchImpl: mockFetch,
        logger: { log: () => {}, warn: () => {}, error: (msg) => errLogs.push(msg) },
        printReport: false,
      });
      assert.equal(badFlagRes.exitCode, 1);
      assert.equal(badFlagRes.mode, 'invalid-args');
      assert.equal(discordCalls.length, 0, `Unknown/conflicting flags (${badArgs.join(' ')}) must not call Discord`);
      assert.equal(llmCalls.length, 0, `Unknown/conflicting flags (${badArgs.join(' ')}) must not call LLM`);
      assert.match(errLogs.join('\n'), /Usage:/);
      assert.equal(process.exitCode, initialProcessExitCode, 'runAnalyzeServerCli must not mutate the process exit code');
    }

    // 4. --list-channels: lists channels via Discord REST, NO export files written, NO AI calls
    discordCalls.length = 0;
    llmCalls.length = 0;
    const listRes = await runAnalyzeServerCli(['--list-channels'], {
      env: {
        DATA_DIR: dataDir,
        DISCORD_USER_TOKEN: 'user-tok-123',
        DISCORD_GUILD_ID: 'guild-123',
        DEEPSEEK_API_KEY: 'sk-deepseek-test',
      },
      fetchImpl: mockFetch,
      logger: silentLogger,
      printReport: false,
    });
    assert.equal(listRes.exitCode, 0);
    assert.equal(listRes.mode, 'list-channels');
    assert.equal(listRes.channels.length, 2);
    assert.ok(discordCalls.length > 0);
    assert.equal(llmCalls.length, 0);
    assert.equal(existsSync(exportFilePath), false);
    assert.equal(existsSync(reportFilePath), false);

    // 5. --export: exports to data/exports/server-export.json, NO AI calls and NO report written
    discordCalls.length = 0;
    llmCalls.length = 0;
    const exportRes = await runAnalyzeServerCli(['--export'], {
      env: {
        DATA_DIR: dataDir,
        DISCORD_USER_TOKEN: 'user-tok-123',
        DISCORD_GUILD_ID: 'guild-123',
        DISCORD_REQUEST_DELAY_MS: '0',
        DEEPSEEK_API_KEY: 'sk-deepseek-test',
      },
      fetchImpl: mockFetch,
      logger: silentLogger,
      printReport: false,
    });
    assert.equal(exportRes.exitCode, 0);
    assert.equal(exportRes.mode, 'export');
    assert.ok(discordCalls.length > 0);
    assert.equal(llmCalls.length, 0);
    assert.equal(existsSync(exportFilePath), true);
    assert.equal(existsSync(reportFilePath), false);

    // 6. --report: runs offline WITHOUT DISCORD_USER_TOKEN or DISCORD_GUILD_ID, ZERO Discord calls, DeepSeek enabled by key
    discordCalls.length = 0;
    llmCalls.length = 0;
    const reportRes = await runAnalyzeServerCli(['--report'], {
      env: {
        DATA_DIR: dataDir,
        DISCORD_USER_TOKEN: '',
        DISCORD_GUILD_ID: '',
        LLM_PROVIDER: 'deepseek',
        DEEPSEEK_API_KEY: 'sk-deepseek-test',
        LLM_MODEL: 'deepseek-flash',
      },
      fetchImpl: mockFetch,
      logger: silentLogger,
      printReport: false,
    });
    assert.equal(reportRes.exitCode, 0);
    assert.equal(reportRes.mode, 'report');
    assert.equal(discordCalls.length, 0, '--report must never make Discord API calls');
    assert.ok(llmCalls.length > 0, '--report must invoke DeepSeek when DEEPSEEK_API_KEY is configured');
    assert.equal(existsSync(reportFilePath), true);
    assert.equal(existsSync(path.join(dataDir, 'reports', 'channels', 'chat.md')), true);
    assert.equal(existsSync(path.join(dataDir, 'reports', 'channels', 'support.md')), true);

    // 7. Default mode (no flags): runs both Phase 1 (export) and Phase 2 (report)
    const fullDataDir = path.join(dataDir, 'full-run');
    discordCalls.length = 0;
    llmCalls.length = 0;
    const fullRes = await runAnalyzeServerCli([], {
      env: {
        DATA_DIR: fullDataDir,
        DISCORD_USER_TOKEN: 'user-tok-123',
        DISCORD_GUILD_ID: 'guild-123',
        DISCORD_REQUEST_DELAY_MS: '0',
        LLM_PROVIDER: 'deepseek',
        DEEPSEEK_API_KEY: 'sk-deepseek-test',
      },
      fetchImpl: mockFetch,
      logger: silentLogger,
      printReport: false,
    });
    assert.equal(fullRes.exitCode, 0);
    assert.equal(fullRes.mode, 'full');
    assert.ok(discordCalls.length > 0);
    assert.ok(llmCalls.length > 0);
    assert.equal(existsSync(path.join(fullDataDir, 'exports', 'server-export.json')), true);
    assert.equal(existsSync(path.join(fullDataDir, 'reports', 'support-report-3months.md')), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('1-Chat + 1-Forum Demo (src/demo-cli.js) generates per-channel reports and demo-support-report-3months.md', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'discord-demo-test-'));
  try {
    assert.equal(SAMPLE_SUPPORT_SERVER_EXPORT.totalChannels, 2);
    assert.equal(SAMPLE_SUPPORT_SERVER_EXPORT.channels.length, 2);

    const chatChannel = SAMPLE_SUPPORT_SERVER_EXPORT.channels.find((c) => c.channelType === 'chat');
    const forumChannel = SAMPLE_SUPPORT_SERVER_EXPORT.channels.find((c) => c.channelType === 'forum');
    assert.ok(chatChannel, 'Demo export must include 1 chat channel');
    assert.ok(forumChannel, 'Demo export must include 1 forum channel');
    assert.equal(chatChannel.channelName, '💬-chat');
    assert.equal(forumChannel.channelName, '🆘-support');
    assert.ok(Array.isArray(forumChannel.posts) && forumChannel.posts.length >= 2);

    const silentLogger = { log: () => {}, error: () => {}, warn: () => {} };
    const demoResult = await runDemo({
      env: {
        DATA_DIR: dataDir,
        LLM_PROVIDER: 'fallback',
      },
      logger: silentLogger,
      printReport: false,
    });

    const expectedMasterPath = path.join(dataDir, 'reports', 'demo-support-report-3months.md');
    const expectedChatPath = path.join(dataDir, 'reports', 'channels', 'demo-chat.md');
    const expectedSupportPath = path.join(dataDir, 'reports', 'channels', 'demo-support.md');

    assert.equal(demoResult.reportPath, expectedMasterPath);
    assert.equal(demoResult.providerUsed, 'local-fallback');
    assert.equal(existsSync(expectedMasterPath), true);
    assert.equal(existsSync(expectedChatPath), true);
    assert.equal(existsSync(expectedSupportPath), true);
    // Ensure live non-prefixed channel paths are not touched by demo
    assert.equal(existsSync(path.join(dataDir, 'reports', 'channels', 'chat.md')), false);
    assert.equal(existsSync(path.join(dataDir, 'reports', 'channels', 'support.md')), false);

    const masterMd = readFileSync(expectedMasterPath, 'utf8');
    assert.match(masterMd, /### 1\. Executive Summary/);
    assert.match(masterMd, /### 2\. Forum & Q&A Channels — Most Frequent Questions & Common Doubts \(FAQ\)/);
    assert.match(masterMd, /### 3\. General Chat Channels — Main Discussion Topics & Community Vibe/);
    assert.match(masterMd, /### 4\. Most Frequently Used Keywords & Technical Terms \(Server-wide & Per-Channel\)/);
    assert.match(masterMd, /💬-chat/);
    assert.match(masterMd, /🆘-support/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('default demo settings stay offline even when environment credentials are loaded', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'discord-demo-default-test-'));
  const originalDataDir = config.report.dataDir;
  let fetchAttempts = 0;
  const blockedFetch = async () => {
    fetchAttempts += 1;
    throw new Error('Unexpected network request in default offline demo');
  };

  try {
    config.report.dataDir = dataDir;
    const result = await runDemo({
      fetchImpl: blockedFetch,
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      printReport: false,
    });

    assert.equal(result.providerUsed, 'local-fallback');
    assert.equal(fetchAttempts, 0, 'default demo must not make DeepSeek or Discord network requests');
    assert.equal(existsSync(path.join(dataDir, 'reports', 'demo-support-report-3months.md')), true);
    assert.equal(existsSync(path.join(dataDir, 'reports', 'channels', 'demo-chat.md')), true);
    assert.equal(existsSync(path.join(dataDir, 'reports', 'channels', 'demo-support.md')), true);
  } finally {
    config.report.dataDir = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('loadConfig supports DISCORD_USER_TOKEN with fallback to DISCORD_TOKEN and parses report & DeepSeek settings', () => {
  const cfgPrimary = loadConfig({
    DISCORD_USER_TOKEN: 'user-tok-123',
    DISCORD_TOKEN: 'legacy-tok-456',
    DISCORD_GUILD_ID: 'guild-999',
    DISCORD_REQUEST_DELAY_MS: '500',
    DEEPSEEK_API_KEY: 'sk-deepseek-key',
    REPORT_LOOKBACK_DAYS: '90',
    REPORT_INCLUDE_CHANNELS: '💬-chat, 🆘-support',
    REPORT_EXCLUDE_CHANNELS: 'off-topic, memes',
  });

  assert.equal(cfgPrimary.discord.userToken, 'user-tok-123');
  assert.equal(cfgPrimary.discord.token, 'user-tok-123');
  assert.equal(cfgPrimary.discord.guildId, 'guild-999');
  assert.equal(cfgPrimary.discord.requestDelayMs, 500);
  assert.equal(cfgPrimary.llm.provider, 'deepseek');
  assert.equal(cfgPrimary.llm.apiKey, 'sk-deepseek-key');
  assert.equal(cfgPrimary.llm.model, 'deepseek-flash');
  assert.equal(cfgPrimary.report.lookbackDays, 90);
  assert.deepEqual(cfgPrimary.report.includeChannels, ['💬-chat', '🆘-support']);
  assert.deepEqual(cfgPrimary.report.excludeChannels, ['off-topic', 'memes']);
  assert.equal(cfgPrimary.limits, undefined);

  const cfgFallback = loadConfig({
    DISCORD_TOKEN: 'fallback-tok-789',
    DISCORD_REQUEST_DELAY_MS: '0',
    REPORT_MAX_MESSAGES_PER_CHANNEL: '0',
  });
  assert.equal(cfgFallback.discord.userToken, 'fallback-tok-789');
  assert.equal(cfgFallback.discord.token, 'fallback-tok-789');
  assert.equal(cfgFallback.discord.requestDelayMs, 0);
  assert.equal(cfgFallback.report.maxMessagesPerChannel, 0);

  const cfgDefault = loadConfig({});
  assert.equal(cfgDefault.discord.requestDelayMs, 350);
  assert.equal(cfgDefault.report.maxMessagesPerChannel, 5000);
});

test('normalizeMessage filters out bot messages and empty messages', () => {
  const botMsg = {
    id: '1',
    author: { username: 'bot_user', bot: true },
    content: 'Automated message',
    createdTimestamp: 1700000000000,
  };
  assert.equal(normalizeMessage(botMsg), null);

  const emptyMsg = {
    id: '2',
    author: { username: 'alice', bot: false },
    content: '   ',
    attachments: [],
    createdTimestamp: 1700000000000,
  };
  assert.equal(normalizeMessage(emptyMsg), null);

  const validMsg = {
    id: '3',
    author: { username: 'alice', globalName: 'Alice Smith', bot: false },
    content: 'Hello world!',
    createdTimestamp: 1700000000000,
  };
  const normalized = normalizeMessage(validMsg);
  assert.ok(normalized);
  assert.equal(normalized.author, 'Alice Smith');
  assert.equal(normalized.content, 'Hello world!');
});

test('buildTranscriptAndStats orders chronologically and counts participants', () => {
  const messages = [
    {
      id: '2',
      author: 'Bob',
      content: 'Second message',
      attachments: [],
      timestamp: new Date('2026-10-20T10:05:00Z'),
    },
    {
      id: '1',
      author: 'Alice',
      content: 'First message',
      attachments: ['diagram.png'],
      timestamp: new Date('2026-10-20T10:00:00Z'),
    },
    {
      id: '3',
      author: 'Alice',
      content: 'Third message',
      attachments: [],
      timestamp: new Date('2026-10-20T10:10:00Z'),
    },
  ];

  const { transcript, stats } = buildTranscriptAndStats(messages);

  assert.equal(stats.totalMessages, 3);
  assert.deepEqual(stats.participants, [
    { author: 'Alice', count: 2 },
    { author: 'Bob', count: 1 },
  ]);

  const lines = transcript.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /Alice: First message \[Attachments: diagram\.png\]/);
  assert.match(lines[1], /Bob: Second message/);
  assert.match(lines[2], /Alice: Third message/);
});

test('summarizeMessages uses DeepSeek provider with deepseek-flash and falls back cleanly when needed', async () => {
  const sampleMessages = [
    {
      id: '1',
      author: 'Alice',
      content: 'Should we migrate the database to PostgreSQL 17 this week?',
      attachments: [],
      timestamp: new Date('2026-10-20T12:00:00Z'),
    },
    {
      id: '2',
      author: 'Bob',
      content: 'Yes, benchmarks show a 20% improvement on JSONB queries.',
      attachments: [],
      timestamp: new Date('2026-10-20T12:02:00Z'),
    },
  ];

  // 1. Mocked successful DeepSeek response with deepseek-flash
  const mockFetchSuccess = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: '**Overview**\nAlice and Bob agreed to migrate to PostgreSQL 17.',
          },
        },
      ],
    }),
  });

  const aiResult = await summarizeMessages(sampleMessages, {
    channelName: 'database',
    llmConfig: {
      provider: 'deepseek',
      apiKey: 'sk-deepseek-test-key',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
    },
    fetchImpl: mockFetchSuccess,
  });

  assert.equal(aiResult.providerUsed, 'deepseek (deepseek-flash)');
  assert.match(aiResult.summary, /PostgreSQL 17/);

  // 2. Automatic model retry from deepseek-flash to deepseek-chat if endpoint returns 400
  const requestedModels = [];
  const mockFetchRetryModel = async (_url, options) => {
    const body = JSON.parse(options.body);
    requestedModels.push(body.model);
    if (body.model === 'deepseek-flash') {
      return {
        ok: false,
        status: 400,
        text: async () => 'Model Not Exist',
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '**Overview**\nRetried with deepseek-chat successfully.',
            },
          },
        ],
      }),
    };
  };

  const retryResult = await summarizeMessages(sampleMessages, {
    channelName: 'database',
    llmConfig: {
      provider: 'deepseek',
      apiKey: 'sk-deepseek-test-key',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
    },
    fetchImpl: mockFetchRetryModel,
  });

  assert.deepEqual(requestedModels, ['deepseek-flash', 'deepseek-chat']);
  assert.match(retryResult.summary, /Retried with deepseek-chat/);

  // 3. Fallback when no API key is provided
  const fallbackResult = await summarizeMessages(sampleMessages, {
    channelName: 'database',
    llmConfig: {
      provider: 'fallback',
      apiKey: '',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
    },
  });

  assert.equal(fallbackResult.providerUsed, 'local-fallback');
  assert.match(fallbackResult.summary, /\*\*Overview\*\*/);
  assert.match(fallbackResult.summary, /PostgreSQL 17/);
  assert.doesNotMatch(fallbackResult.summary, /\bAlice\b|\bBob\b/);
});

test('fetchChannelMessages respects lookback hours and topic filter', async () => {
  const now = Date.now();
  const rawBatch = new Map([
    [
      '103',
      {
        id: '103',
        author: { username: 'alice', bot: false },
        content: 'Talking about Kubernetes deployment',
        createdTimestamp: now - 10 * 60 * 1000, // 10 mins ago
      },
    ],
    [
      '102',
      {
        id: '102',
        author: { username: 'bob', bot: false },
        content: 'Random coffee chat',
        createdTimestamp: now - 20 * 60 * 1000, // 20 mins ago
      },
    ],
    [
      '101',
      {
        id: '101',
        author: { username: 'charlie', bot: false },
        content: 'Old Kubernetes message from 2 days ago',
        createdTimestamp: now - 48 * 3600 * 1000, // 48 hours ago
      },
    ],
  ]);

  const fakeChannel = {
    messages: {
      fetch: async () => ({
        size: rawBatch.size,
        values: () => rawBatch.values(),
        last: () => ({ id: '101' }),
      }),
    },
  };

  const results = await fetchChannelMessages(fakeChannel, {
    hours: 2,
    maxMessages: 50,
    topicFilter: 'kubernetes',
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].id, '103');
});

test('exportGuildHistory exports multiple channels over 90 days (3 months) and generateServerSupportReport produces a full executive report', async () => {
  const now = Date.now();
  const DAY_MS = 24 * 3600 * 1000;

  const mockDiscordRestFetch = async (url) => {
    if (url.endsWith('/guilds/guild-1')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'guild-1', name: 'Test Support Server' }),
      };
    }
    if (url.endsWith('/guilds/guild-1/channels')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'cat-sup', name: 'Support', type: DiscordChannelType.GuildCategory },
          { id: 'ch1', name: 'support-general', parent_id: 'cat-sup', type: DiscordChannelType.GuildText },
          { id: 'ch2', name: 'bug-reports', parent_id: 'cat-sup', type: DiscordChannelType.GuildText },
        ],
      };
    }
    if (url.includes('/channels/ch1/messages')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: timestampToSnowflake(now - 60 * DAY_MS + 60000),
            author: { username: 'staff_elena', bot: false },
            content: 'Set DEEPSEEK_API_KEY in your .env file and select deepseek-flash.',
            timestamp: new Date(now - 60 * DAY_MS + 60000).toISOString(),
          },
          {
            id: timestampToSnowflake(now - 60 * DAY_MS),
            author: { username: 'user_a', bot: false },
            content: 'How do I configure the DeepSeek API key in the plugin?',
            timestamp: new Date(now - 60 * DAY_MS).toISOString(),
          },
          {
            id: timestampToSnowflake(now - 180 * DAY_MS),
            author: { username: 'ancient_user', bot: false },
            content: 'Message from 6 months ago that should be excluded by 90-day cutoff',
            timestamp: new Date(now - 180 * DAY_MS).toISOString(),
          },
        ],
      };
    }
    if (url.includes('/channels/ch2/messages')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: timestampToSnowflake(now - 15 * DAY_MS),
            author: { username: 'user_b', bot: false },
            content: 'Getting a 429 rate limit error when exporting large servers.',
            timestamp: new Date(now - 15 * DAY_MS).toISOString(),
          },
        ],
      };
    }
    throw new Error(`Unexpected REST URL in test #7: ${url}`);
  };

  const exportBundle = await exportGuildHistory('guild-1', {
    token: 'user-tok-test',
    days: 90,
    maxMessagesPerChannel: 1000,
    requestDelayMs: 0,
    outputDir: '', // skip disk write in unit test
    fetchImpl: mockDiscordRestFetch,
  });

  assert.equal(exportBundle.totalChannels, 2);
  assert.equal(exportBundle.totalMessages, 3); // m_old (180 days ago) excluded by 90-day window
  assert.equal(exportBundle.channels[0].truncated, false);

  // Verify Map-Reduce chunking helper
  assert.equal(chunkMessages([1, 2, 3, 4, 5], 2).length, 3);

  // Verify full report generation with mocked DeepSeek API
  const mockDeepSeekFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content:
              '### 1. Executive Summary\nSupport activity focused on DeepSeek configuration and rate-limit handling.',
          },
        },
      ],
    }),
  });

  const reportResult = await generateServerSupportReport(exportBundle, {
    chunkSize: 2,
    reportOutputPath: '', // skip disk write in unit test
    llmConfig: {
      provider: 'deepseek',
      apiKey: 'sk-deepseek-test',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
    },
    fetchImpl: mockDeepSeekFetch,
  });

  assert.equal(reportResult.channelDigests.length, 2);
  assert.equal(reportResult.globalStats.totalMessages, 3);
  assert.equal(reportResult.providerUsed, 'deepseek (deepseek-flash)');
  assert.match(reportResult.markdownReport, /Discord Support Server Retrospective Report \(90-Day Analysis\)/);
  assert.match(reportResult.markdownReport, /Executive Summary/);
});

test('discordRestGet handles Authorization header, Retry-After cap & body/header, transient 5xx/network retries, and URL safety', async () => {
  const sleepCalls = [];
  let attemptCount = 0;

  const mockFetch = async (url, options) => {
    attemptCount++;
    assert.equal(options.headers.Authorization, 'user-secret-token');
    assert.match(url, /https:\/\/discord\.com\/api\/v10\/users\/@me\/guilds$/);

    if (attemptCount === 1) {
      // Rate limit via Retry-After header
      return {
        ok: false,
        status: 429,
        headers: {
          get: (name) => (name.toLowerCase() === 'retry-after' ? '1.5' : null),
        },
        json: async () => ({ message: 'Rate limited' }),
      };
    }
    if (attemptCount === 2) {
      // Rate limit via JSON body retry_after
      return {
        ok: false,
        status: 429,
        headers: {},
        json: async () => ({ message: 'Rate limited', retry_after: 0.25 }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => [{ id: 'g1', name: 'Junie Discord' }],
    };
  };

  const guilds = await fetchUserGuilds({
    token: 'user-secret-token',
    fetchImpl: mockFetch,
    maxRetries: 3,
    sleepImpl: async (ms) => {
      sleepCalls.push(ms);
    },
  });

  assert.equal(attemptCount, 3);
  assert.deepEqual(sleepCalls, [1500, 250]);
  assert.deepEqual(guilds, [{ id: 'g1', name: 'Junie Discord' }]);

  // Verify bounded retries throws when HTTP 429 persists past maxRetries
  let boundedCalls = 0;
  await assert.rejects(
    () =>
      discordRestGet('/guilds/g1/channels', {
        token: 'user-secret-token',
        maxRetries: 2,
        sleepImpl: async () => {},
        fetchImpl: async () => {
          boundedCalls++;
          return {
            ok: false,
            status: 429,
            headers: { 'retry-after': '0.1' },
            json: async () => ({ retry_after: 0.1 }),
          };
        },
      }),
    /rate limit exceeded \(HTTP 429\).*after 2 retries/i
  );
  assert.equal(boundedCalls, 3); // 1 initial + 2 retries

  // Verify excessive retry_after (e.g. 86400s / 24h) fails immediately without sleeping
  const capSlept = [];
  await assert.rejects(
    () =>
      discordRestGet('/guilds/g1/channels', {
        token: 'user-secret-token',
        maxRetries: 3,
        maxRetryAfterMs: 60_000,
        sleepImpl: async (ms) => {
          capSlept.push(ms);
        },
        fetchImpl: async () => ({
          ok: false,
          status: 429,
          headers: { 'retry-after': '86400', 'x-ratelimit-global': 'true' },
          json: async () => ({ message: 'Global rate limit', retry_after: 86400, global: true }),
        }),
      }),
    /exceeds maximum allowed wait/i
  );
  assert.deepEqual(capSlept, [], 'Must not sleep when retry_after exceeds maxRetryAfterMs');

  // Verify transient network error and 502/503 retries with exponential backoff
  const transientSleeps = [];
  let transientAttempt = 0;
  const recovered = await discordRestGet('/guilds/g1', {
    token: 'user-secret-token',
    maxRetries: 3,
    retryBaseDelayMs: 100,
    sleepImpl: async (ms) => {
      transientSleeps.push(ms);
    },
    fetchImpl: async () => {
      transientAttempt++;
      if (transientAttempt === 1) {
        throw new Error('read ECONNRESET');
      }
      if (transientAttempt === 2) {
        return {
          ok: false,
          status: 502,
          text: async () => 'Bad Gateway',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'g1', name: 'Recovered Guild' }),
      };
    },
  });
  assert.equal(transientAttempt, 3);
  assert.deepEqual(transientSleeps, [100, 200]);
  assert.equal(recovered.name, 'Recovered Guild');

  // Verify non-Discord external URLs are rejected so token is never leaked
  await assert.rejects(
    () =>
      discordRestGet('https://evil.example.com/api/v10/steal', {
        token: 'user-secret-token',
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      }),
    /Refusing to send Discord user token to non-Discord API URL/i
  );
});

test('fetchChannelMessagesRest paginates 100 messages per batch with Snowflake cutoffs, polite pacing, maxMessages=0, and truncation flag', async () => {
  const now = Date.now();
  const DAY_MS = 24 * 3600 * 1000;

  // Verify Snowflake round-trip conversion
  const sampleTs = now - 10 * DAY_MS;
  const sampleSf = timestampToSnowflake(sampleTs);
  assert.equal(snowflakeToTimestamp(sampleSf), Math.floor(sampleTs));

  // Page 1: 100 messages from 5 days ago (only Snowflake IDs, no explicit timestamp property, to test Snowflake decoding)
  const page1 = Array.from({ length: 100 }, (_, i) => {
    const ts = now - 5 * DAY_MS - i * 1000;
    return {
      id: timestampToSnowflake(ts),
      author: { username: 'alice', global_name: 'Alice', bot: false },
      content: `Page 1 message #${i + 1}`,
      attachments: i === 0 ? [{ filename: 'trace.log' }] : [],
    };
  });

  // Page 2: 1 recent message (20 days ago) and 1 message older than 90-day cutoff (120 days ago)
  const validPage2Ts = now - 20 * DAY_MS;
  const oldPage2Ts = now - 120 * DAY_MS;
  const page2 = [
    {
      id: timestampToSnowflake(validPage2Ts),
      author: { username: 'bob', bot: false },
      content: 'Page 2 valid message within 90 days',
    },
    {
      id: timestampToSnowflake(oldPage2Ts),
      author: { username: 'bob', bot: false },
      content: 'Page 2 ancient message beyond 90-day cutoff',
    },
  ];

  const requestedUrls = [];
  const pacingDelays = [];

  const mockFetch = async (url) => {
    requestedUrls.push(url);
    if (!url.includes('before=')) {
      return { ok: true, status: 200, json: async () => page1 };
    }
    return { ok: true, status: 200, json: async () => page2 };
  };

  const messages = await fetchChannelMessagesRest('ch-chat-1', {
    token: 'user-tok',
    hours: 90 * 24,
    maxMessages: 0, // 0 = unlimited within lookback window
    requestDelayMs: 350,
    fetchImpl: mockFetch,
    sleepImpl: async (ms) => {
      pacingDelays.push(ms);
    },
  });

  assert.equal(requestedUrls.length, 2);
  assert.match(requestedUrls[0], /\/channels\/ch-chat-1\/messages\?limit=100$/);
  assert.match(
    requestedUrls[1],
    new RegExp(`/channels/ch-chat-1/messages\\?limit=100&before=${page1[99].id}$`)
  );
  assert.deepEqual(pacingDelays, [350]);
  assert.equal(messages.length, 101);
  assert.equal(messages.truncated, false);
  // Chronological order: oldest (page 2 message from 20 days ago) first
  assert.equal(messages[0].content, 'Page 2 valid message within 90 days');
  assert.deepEqual(messages[messages.length - 1].attachments, ['trace.log']);

  // Verify truncation flag is set when maxMessages caps in-window messages
  const truncatedMessages = await fetchChannelMessagesRest('ch-chat-1', {
    token: 'user-tok',
    hours: 90 * 24,
    maxMessages: 10,
    requestDelayMs: 0,
    fetchImpl: mockFetch,
  });
  assert.equal(truncatedMessages.length, 10);
  assert.equal(truncatedMessages.truncated, true);
});

test('fetchForumThreadsRest and fetchForumPostsRest support user-token thread search, fail visibly on search failure, recover old starters (>100 msgs) via after=threadId-1, and compute accurate answered/truncation state', async () => {
  const now = Date.now();
  const DAY_MS = 24 * 3600 * 1000;

  // 1. Direct unit checks for determineForumPostAnswered (including negation, bare nouns, & "same here / me too")
  assert.equal(
    determineForumPostAnswered(
      { id: 't1', name: 'Unanswered self-bump' },
      [
        { author: 'bob', content: 'How do I fix this error?' },
        { author: 'bob', content: 'Bump, anyone experiencing this too?' },
      ]
    ),
    false,
    'Self-bump by the original poster should not mark post as answered'
  );

  assert.equal(
    determineForumPostAnswered(
      { id: 't_negated', name: 'Crash on startup' },
      [
        { author: 'bob', content: 'App crashes on launch' },
        { author: 'bob', content: 'Still not resolved after restarting.' },
      ]
    ),
    false,
    'Negated resolution ("Still not resolved") must not mark post as answered'
  );

  assert.equal(
    determineForumPostAnswered(
      { id: 't_metoo', name: 'Plugin crash' },
      [
        { author: 'bob', content: 'Plugin crashes when clicking export' },
        { author: 'charlie', content: 'Same here, also crashing on Windows 11.' },
        { author: 'dave', content: '+1 having the same issue' },
      ]
    ),
    false,
    '"Same here / +1" replies from other users must not mark post as answered'
  );

  assert.equal(
    determineForumPostAnswered(
      { id: 't_bare_noun', name: 'Config issue' },
      [
        { author: 'bob', content: 'How do I set up the custom endpoint?' },
        { author: 'charlie', content: 'I need this too for my config.' },
      ]
    ),
    false,
    'Reply mentioning bare technical noun ("I need this too for my config.") must not mark post as answered'
  );

  assert.equal(
    determineForumPostAnswered(
      { id: 't_does_not_work_either', name: 'Install failure' },
      [
        { author: 'bob', content: 'Extension fails to load after update' },
        { author: 'charlie', content: 'I tried reinstalling, it does not work either.' },
        { author: 'dave', content: 'I tried reinstalling. It does not work either.' },
      ]
    ),
    false,
    'Reply reporting failure ("I tried reinstalling, it does not work either.") must not mark post as answered'
  );

  assert.equal(
    determineForumPostAnswered(
      { id: 't2', name: 'Only another user asking a question' },
      [
        { author: 'bob', content: 'Plugin crashes on launch' },
        { author: 'charlie', content: 'Are you on macOS or Windows?' },
      ]
    ),
    false,
    'Clarifying question without solution or confirmation should not mark post as answered'
  );

  assert.equal(
    determineForumPostAnswered(
      { id: 't3', name: 'Answered by support' },
      [
        { author: 'bob', content: 'How to configure DeepSeek API key?' },
        { author: 'elena_support', content: 'Set DEEPSEEK_API_KEY in your .env file.' },
      ]
    ),
    true
  );

  // 2. Verify user-account `/channels/{id}/threads/search` pagination, HTTP 202 retry,
  // archived pagination, and old thread starter preservation when thread has 150 old messages + 3 recent replies
  const activeThreadId = timestampToSnowflake(now - 5 * DAY_MS);
  const oldThreadId = timestampToSnowflake(now - 200 * DAY_MS); // Created 200 days ago (before 90d cutoff)
  const oldThreadAfterId = String(BigInt(oldThreadId) - 1n);
  const archivedThreadId = timestampToSnowflake(now - 30 * DAY_MS);
  const ancientArchivedThreadId = timestampToSnowflake(now - 120 * DAY_MS);

  const archiveCursor1 = new Date(now - 30 * DAY_MS).toISOString();
  const archiveCursorOld = new Date(now - 120 * DAY_MS).toISOString();
  let searchAttempts = 0;
  let starterAfterCallCount = 0;

  // Build 3 recent replies (4 days ago) + 150 old messages (100 to 199 days ago) for oldThreadId
  const oldThreadRecentReplies = [
    {
      id: timestampToSnowflake(now - 4 * DAY_MS + 120000),
      author: { id: 'u_orig', username: 'original_asker', bot: false },
      content: 'Thanks, upgrading fixed it!',
      timestamp: new Date(now - 4 * DAY_MS + 120000).toISOString(),
    },
    {
      id: timestampToSnowflake(now - 4 * DAY_MS + 60000),
      author: { id: 'u_helper', username: 'helper', bot: false },
      content: 'Try upgrading to the latest plugin version.',
      timestamp: new Date(now - 4 * DAY_MS + 60000).toISOString(),
    },
    {
      id: timestampToSnowflake(now - 4 * DAY_MS),
      author: { id: 'u_other', username: 'other_member', bot: false },
      content: 'I tried reinstalling, it does not work either.',
      timestamp: new Date(now - 4 * DAY_MS).toISOString(),
    },
  ];
  const oldThread150OldMessages = Array.from({ length: 150 }, (_, idx) => {
    const msgTime = now - (100 + idx * 0.5) * DAY_MS;
    return {
      id: timestampToSnowflake(msgTime),
      author: { id: `u_old_${idx}`, username: `old_user_${idx}`, bot: false },
      content: `Old discussion message #${idx + 1}`,
      timestamp: new Date(msgTime).toISOString(),
    };
  });
  const oldThreadStarterMsg = {
    id: oldThreadId,
    author: { id: 'u_orig', username: 'original_asker', bot: false },
    content: 'My IDE freezes when opening large projects.',
    timestamp: new Date(now - 200 * DAY_MS).toISOString(),
  };
  // Full descending message list in oldThreadId (154 total: 3 recent + 150 old + 1 starter)
  const oldThreadAllDescending = [
    ...oldThreadRecentReplies,
    ...oldThread150OldMessages,
    oldThreadStarterMsg,
  ];

  const mockFetch = async (url) => {
    if (url.endsWith('/guilds/g1/threads/active')) {
      // User accounts cannot call /guilds/{id}/threads/active
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ code: 20001, message: 'Users cannot use this endpoint' }),
      };
    }

    // Single-message endpoint `GET /channels/{id}/messages/{msgId}` is NOT usable by user accounts
    if (/\/channels\/[^/]+\/messages\/[^/?]+$/.test(url)) {
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ code: 20001, message: 'Users cannot use this endpoint' }),
      };
    }

    if (url.includes('/channels/forum-222/threads/search')) {
      searchAttempts++;
      if (searchAttempts === 1) {
        // Simulate HTTP 202 "Index not yet available" on first attempt
        return {
          ok: false,
          status: 202,
          json: async () => ({
            message: 'Index not yet available. Try again later',
            code: 110000,
            retry_after: 0.01,
          }),
        };
      }
      if (url.includes('offset=0')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            threads: [
              {
                id: activeThreadId,
                parent_id: 'forum-222',
                owner_id: 'u_bob',
                name: 'How to configure DeepSeek API key?',
                last_message_id: timestampToSnowflake(now - 5 * DAY_MS + 60000),
                thread_metadata: { create_timestamp: new Date(now - 5 * DAY_MS).toISOString() },
              },
            ],
            has_more: true,
            total_results: 2,
          }),
        };
      }
      if (url.includes('offset=1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            threads: [
              // Created 200 days ago, with 150 old messages and 3 recent replies (4 days ago)
              {
                id: oldThreadId,
                parent_id: 'forum-222',
                owner_id: 'u_orig',
                name: 'Old thread still active with recent solution',
                last_message_id: oldThreadRecentReplies[0].id,
                thread_metadata: { create_timestamp: new Date(now - 200 * DAY_MS).toISOString() },
              },
            ],
            has_more: false,
            total_results: 2,
          }),
        };
      }
    }

    if (url.includes('/channels/forum-222/threads/archived/public')) {
      if (!url.includes('before=')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            threads: [
              {
                id: archivedThreadId,
                parent_id: 'forum-222',
                owner_id: 'u_carlos',
                name: 'Rate limit 429 when exporting large server',
                thread_metadata: { archive_timestamp: archiveCursor1 },
              },
            ],
            has_more: true,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          threads: [
            {
              id: ancientArchivedThreadId,
              parent_id: 'forum-222',
              owner_id: 'u_ancient',
              name: 'Ancient archived thread from 4 months ago',
              thread_metadata: { archive_timestamp: archiveCursorOld },
            },
          ],
          has_more: false,
        }),
      };
    }

    // Active Thread 1 messages (within 90d cutoff)
    if (url.includes(`/channels/${activeThreadId}/messages?`)) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: timestampToSnowflake(now - 5 * DAY_MS + 60000),
            author: { id: 'u_alice', username: 'alice_helper', bot: false },
            content: 'Add DEEPSEEK_API_KEY to your .env file and run npm run generate-report.',
            timestamp: new Date(now - 5 * DAY_MS + 60000).toISOString(),
          },
          {
            id: activeThreadId,
            author: { id: 'u_bob', username: 'bob_asker', bot: false },
            content: 'Where do I put my DeepSeek key?',
            timestamp: new Date(now - 5 * DAY_MS).toISOString(),
          },
        ],
      };
    }

    // Old Thread starter recovery via user-usable list endpoint `?after={threadId-1}&limit=1`
    if (url.includes(`/channels/${oldThreadId}/messages?after=${oldThreadAfterId}&limit=1`)) {
      starterAfterCallCount++;
      return {
        ok: true,
        status: 200,
        json: async () => [oldThreadStarterMsg],
      };
    }

    // Old Thread (created 200d ago): Page 1 `?limit=100` returns 3 recent replies + 97 old messages (starter is at index 153!)
    if (url.includes(`/channels/${oldThreadId}/messages?limit=100`)) {
      return {
        ok: true,
        status: 200,
        json: async () => oldThreadAllDescending.slice(0, 100),
      };
    }

    // Archived Thread messages (only self-bump + "same here" -> unanswered!)
    if (url.includes(`/channels/${archivedThreadId}/messages?`)) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: timestampToSnowflake(now - 30 * DAY_MS + 180000),
            author: { id: 'u_other2', username: 'other_user', bot: false },
            content: 'Same here, also getting 429.',
            timestamp: new Date(now - 30 * DAY_MS + 180000).toISOString(),
          },
          {
            id: timestampToSnowflake(now - 30 * DAY_MS + 120000),
            author: { id: 'u_carlos', username: 'carlos_dev', bot: false },
            content: 'Still not resolved, any updates?',
            timestamp: new Date(now - 30 * DAY_MS + 120000).toISOString(),
          },
          {
            id: archivedThreadId,
            author: { id: 'u_carlos', username: 'carlos_dev', bot: false },
            content: 'Getting 429 rate limit during export.',
            timestamp: new Date(now - 30 * DAY_MS).toISOString(),
          },
        ],
      };
    }

    throw new Error(`Unexpected URL in forum test: ${url}`);
  };

  const { posts, messages, truncated, inaccessibleThreadCount, budgetSkippedThreadCount } = await fetchForumPostsRest(
    'g1',
    { id: 'forum-222', name: '🆘-support', type: DiscordChannelType.GuildForum },
    {
      token: 'user-tok',
      hours: 90 * 24,
      requestDelayMs: 0,
      fetchImpl: mockFetch,
      sleepImpl: async () => {},
    }
  );

  assert.equal(starterAfterCallCount, 1, 'Must recover starter via ?after={threadId-1}&limit=1');
  assert.equal(posts.length, 3);
  // Window-only messages: the 200-day-old starter is excluded from channel-level messages
  assert.equal(messages.length, 8);
  assert.equal(messages.some((m) => m.id === oldThreadId), false);
  assert.equal(truncated, false);
  assert.equal(inaccessibleThreadCount, 0);
  assert.equal(budgetSkippedThreadCount, 0);

  // Post 0: Old thread created 200 days ago with 150 old messages + 3 recent replies preserves original_asker, starter question, createdAt, replyCount=3, answered=true
  assert.equal(posts[0].postId, oldThreadId);
  assert.equal(posts[0].author, 'original_asker');
  assert.equal(posts[0].starterQuestion, 'My IDE freezes when opening large projects.');
  assert.equal(posts[0].createdAt, new Date(now - 200 * DAY_MS).toISOString());
  assert.equal(posts[0].replyCount, 3);
  assert.equal(posts[0].messageCount, 4);
  assert.equal(posts[0].answered, true);
  // Old starter is retained as post context, marked contextOnly, and is not counted as in-window
  assert.equal(posts[0].messages[0].id, oldThreadId);
  assert.equal(posts[0].messages[0].contextOnly, true);
  assert.equal(posts[0].messages[1].contextOnly, undefined);

  // Post 1: Archived thread (30 days ago) with self-bump + "Same here" is NOT marked answered
  assert.equal(posts[1].title, 'Rate limit 429 when exporting large server');
  assert.equal(posts[1].replyCount, 2);
  assert.equal(posts[1].answered, false);

  // Post 2: Active thread (5 days ago) answered by alice_helper
  assert.equal(posts[2].title, 'How to configure DeepSeek API key?');
  assert.equal(posts[2].starterQuestion, 'Where do I put my DeepSeek key?');
  assert.equal(posts[2].replyCount, 1);
  assert.equal(posts[2].answered, true);

  // 3. Verify owner_id fallback when starter message was deleted (so ?after={threadId-1}&limit=1 returns empty [])
  const deletedStarterPosts = await fetchForumPostsRest(
    'g1',
    { id: 'forum-222', name: '🆘-support', type: DiscordChannelType.GuildForum },
    {
      token: 'user-tok',
      hours: 90 * 24,
      requestDelayMs: 0,
      fetchImpl: async (url) => {
        if (url.includes(`/channels/${oldThreadId}/messages?after=${oldThreadAfterId}&limit=1`)) {
          return { ok: true, status: 200, json: async () => [] };
        }
        return mockFetch(url);
      },
      sleepImpl: async () => {},
    }
  );
  // Even when starter message is deleted, owner_id ('u_orig') resolves from known thread participants to 'original_asker'!
  assert.equal(deletedStarterPosts.posts[0].author, 'original_asker');
  assert.equal(deletedStarterPosts.posts[0].replyCount, 3);

  // 4. Verify active thread search failure after bounded retries FAILS visibly (never silently drops active posts!)
  await assert.rejects(
    () =>
      fetchForumThreadsRest('forum-222', 'g1', {
        token: 'user-tok',
        hours: 90 * 24,
        requestDelayMs: 0,
        maxRetries: 2,
        sleepImpl: async () => {},
        fetchImpl: async (url) => {
          if (url.includes('/threads/search')) {
            return {
              ok: false,
              status: 202,
              json: async () => ({
                message: 'Index not yet available',
                retry_after: 0.01,
              }),
            };
          }
          return mockFetch(url);
        },
      }),
    /Discord API search index not ready \(HTTP 202\)/
  );

  // 5. Verify forum truncation metadata when maxMessagesPerChannel budget runs out
  const truncatedForum = await fetchForumPostsRest(
    'g1',
    { id: 'forum-222', name: '🆘-support', type: DiscordChannelType.GuildForum },
    {
      token: 'user-tok',
      hours: 90 * 24,
      maxMessagesPerChannel: 2, // Only enough budget for the first thread
      requestDelayMs: 0,
      fetchImpl: mockFetch,
      sleepImpl: async () => {},
    }
  );
  assert.equal(truncatedForum.truncated, true);
  assert.equal(truncatedForum.posts.length, 1);
  assert.equal(truncatedForum.budgetSkippedThreadCount, 2);
  assert.equal(truncatedForum.inaccessibleThreadCount, 0);
});

test('exportGuildHistory via REST v10 skips hidden 403 channels, preserves pre-existing export on fatal 5xx error, and writes files atomically', async () => {
  const now = Date.now();
  const DAY_MS = 24 * 3600 * 1000;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'discord-export-rest-test-'));

  const threadId = timestampToSnowflake(now - 10 * DAY_MS);

  const createRestMock = ({ failForum500 = false, failForum202 = false } = {}) => async (url) => {
    if (url.endsWith('/guilds/guild-junie')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'guild-junie', name: 'Junie Discord' }),
      };
    }
    if (url.endsWith('/guilds/guild-junie/channels')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'cat-1', name: 'Junie', type: DiscordChannelType.GuildCategory },
          { id: '111', name: '💬-chat', parent_id: 'cat-1', type: DiscordChannelType.GuildText },
          { id: '999', name: '🔒-staff-only', parent_id: 'cat-1', type: DiscordChannelType.GuildText },
          { id: '222', name: '🆘-support', parent_id: 'cat-1', type: DiscordChannelType.GuildForum },
          { id: '333', name: '💡-feature-requests', parent_id: 'cat-1', type: DiscordChannelType.GuildForum },
        ],
      };
    }
    if (url.includes('/channels/111/messages')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: timestampToSnowflake(now - 2 * DAY_MS),
            author: { username: 'dev_anna', bot: false },
            content: 'Loving the new Junie CLI exporter workflow!',
            timestamp: new Date(now - 2 * DAY_MS).toISOString(),
          },
        ],
      };
    }
    if (url.includes('/channels/999/messages')) {
      // Hidden channel that user account cannot access (403 Missing Access, code 50001)
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ message: 'Missing Access', code: 50001 }),
      };
    }
    if (url.includes('/channels/222/threads/search')) {
      if (failForum500) {
        return {
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error on forum search',
        };
      }
      if (failForum202) {
        return {
          ok: false,
          status: 202,
          json: async () => ({ message: 'Index not yet available', retry_after: 0.01 }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          threads: [
            {
              id: threadId,
              parent_id: '222',
              name: 'How to run Phase 2 report offline?',
              thread_metadata: { create_timestamp: new Date(now - 10 * DAY_MS).toISOString() },
            },
          ],
          has_more: false,
          total_results: 1,
        }),
      };
    }
    if (url.includes('/channels/222/threads/archived/public')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ threads: [], has_more: false }),
      };
    }
    if (url.includes('/channels/333/threads/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ threads: [], has_more: false, total_results: 0 }),
      };
    }
    if (url.includes('/channels/333/threads/archived/public')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ threads: [], has_more: false }),
      };
    }
    if (url.includes(`/channels/${threadId}/messages`)) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: timestampToSnowflake(now - 10 * DAY_MS + 30000),
            author: { username: 'ambassador_leo', bot: false },
            content: 'Run npm run generate-report to analyze data/exports/server-export.json.',
            timestamp: new Date(now - 10 * DAY_MS + 30000).toISOString(),
          },
          {
            id: threadId,
            author: { username: 'new_member', bot: false },
            content: 'Can I re-run DeepSeek analysis without re-downloading from Discord?',
            timestamp: new Date(now - 10 * DAY_MS).toISOString(),
          },
        ],
      };
    }
    throw new Error(`Unhandled mock URL: ${url}`);
  };

  try {
    // 1. Verify channel listing & classification (`chat`, `qa`, `forum`)
    assert.equal(classifyChannelType({ name: '💬-chat', type: 0 }), 'chat');
    assert.equal(classifyChannelType({ name: '❓-questions', type: 0 }), 'qa');
    assert.equal(classifyChannelType({ name: '🆘-support', type: 15 }), 'forum');

    const listed = await listGuildChannels('guild-junie', {
      token: 'user-tok',
      fetchImpl: createRestMock(),
    });
    assert.equal(listed.length, 4);

    // 2. Verify fatal 500 or exhausted 202 error during export does NOT overwrite a pre-existing server-export.json
    const failOutputDir = path.join(tempDir, 'failed-run');
    const preExistingMasterPath = path.join(failOutputDir, 'server-export.json');
    const staleChannelPath = path.join(failOutputDir, 'old-channel-000.json');
    const unrelatedJsonPath = path.join(failOutputDir, 'unrelated-notes.json');
    mkdirSync(failOutputDir, { recursive: true });
    const previousGoodContent = JSON.stringify({ guildId: 'previous-good-export', totalMessages: 42 });
    writeFileSync(preExistingMasterPath, previousGoodContent, 'utf8');
    writeFileSync(staleChannelPath, JSON.stringify({ channelId: '000' }), 'utf8');
    writeFileSync(unrelatedJsonPath, JSON.stringify({ keep: true }), 'utf8');

    await assert.rejects(
      () =>
        exportGuildHistory('guild-junie', {
          token: 'user-tok',
          days: 90,
          requestDelayMs: 0,
          maxRetries: 1,
          outputDir: failOutputDir,
          fetchImpl: createRestMock({ failForum500: true }),
        }),
      /Discord REST API error 500/
    );
    await assert.rejects(
      () =>
        exportGuildHistory('guild-junie', {
          token: 'user-tok',
          days: 90,
          requestDelayMs: 0,
          maxRetries: 1,
          outputDir: failOutputDir,
          fetchImpl: createRestMock({ failForum202: true }),
        }),
      /Discord API search index not ready \(HTTP 202\)/
    );
    assert.equal(
      readFileSync(preExistingMasterPath, 'utf8'),
      previousGoodContent,
      'Pre-existing server-export.json must survive a failed export run intact'
    );

    // 3. Verify successful export skips 403 channel, records empty forum, writes files atomically, and only deletes owned stale channel files
    const bundle = await exportGuildHistory('guild-junie', {
      token: 'user-tok',
      days: 90,
      requestDelayMs: 0,
      outputDir: failOutputDir,
      fetchImpl: createRestMock({ failForum500: false }),
    });

    assert.equal(bundle.guildId, 'guild-junie');
    assert.equal(bundle.guildName, 'Junie Discord');
    assert.equal(bundle.totalChannels, 3);
    assert.equal(bundle.totalMessages, 3);
    assert.equal(bundle.skippedChannels.length, 1);
    assert.equal(bundle.skippedChannels[0].channelId, '999');
    assert.equal(bundle.skippedChannels[0].status, 403);
    assert.equal(bundle.skippedChannels[0].code, 50001);

    const chatFile = path.join(failOutputDir, 'chat-111.json');
    const forumFile = path.join(failOutputDir, 'support-222.json');
    const emptyForumFile = path.join(failOutputDir, 'feature-requests-333.json');
    const masterFile = path.join(failOutputDir, 'server-export.json');

    assert.equal(existsSync(chatFile), true);
    assert.equal(existsSync(forumFile), true);
    assert.equal(existsSync(emptyForumFile), true);
    assert.equal(existsSync(masterFile), true);
    assert.equal(
      existsSync(staleChannelPath),
      false,
      'Stale owned per-channel JSON file from previous run should be cleaned up'
    );
    assert.equal(
      existsSync(unrelatedJsonPath),
      true,
      'Unrelated JSON files in outputDir must NOT be deleted'
    );

    const savedForum = JSON.parse(readFileSync(forumFile, 'utf8'));
    assert.equal(savedForum.channelType, 'forum');
    assert.equal(savedForum.postCount, 1);
    assert.equal(savedForum.truncated, false);
    assert.equal(savedForum.inaccessibleThreadCount, 0);
    assert.equal(savedForum.budgetSkippedThreadCount, 0);
    assert.equal(savedForum.posts[0].title, 'How to run Phase 2 report offline?');
    assert.equal(savedForum.posts[0].answered, true);

    const savedEmptyForum = JSON.parse(readFileSync(emptyForumFile, 'utf8'));
    assert.equal(savedEmptyForum.channelType, 'forum');
    assert.equal(savedEmptyForum.postCount, 0);
    assert.equal(savedEmptyForum.messageCount, 0);
    assert.deepEqual(savedEmptyForum.posts, []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('exportGuildHistory records empty chat channels with messageCount 0 and fails fast on route-level 404 search errors', async () => {
  const emptyChat = { id: 'c-empty', name: '💬-empty-chat', type: DiscordChannelType.GuildText };
  const emptyChatFetch = async (url) => {
    if (url.includes('/channels/c-empty/messages')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const bundle = await exportGuildHistory(
    { id: 'g2', name: 'Mini Server', channels: [emptyChat] },
    { token: 'user-tok', days: 90, requestDelayMs: 0, outputDir: null, fetchImpl: emptyChatFetch }
  );
  assert.equal(bundle.totalChannels, 1);
  assert.equal(bundle.channels[0].channelName, '💬-empty-chat');
  assert.equal(bundle.channels[0].messageCount, 0);
  assert.equal(bundle.channels[0].timeframeStart, null);
  assert.equal(bundle.skippedChannels.length, 0);

  const forum = { id: 'f-forum', name: '🆘-support', type: DiscordChannelType.GuildForum };
  const route404Fetch = async (url) => {
    if (url.includes('/channels/f-forum/threads/search')) {
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ message: '404: Not Found', code: 0 }),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  await assert.rejects(
    () =>
      exportGuildHistory(
        { id: 'g2', name: 'Mini Server', channels: [forum] },
        { token: 'user-tok', days: 90, requestDelayMs: 0, maxRetries: 0, outputDir: null, fetchImpl: route404Fetch }
      ),
    /Discord REST API error 404/
  );
});

test('fetchForumPostsRest separates inaccessible post skips from budget truncation and warns visibly', async () => {
  const now = Date.now();
  const DAY_MS = 24 * 3600 * 1000;
  const postAId = timestampToSnowflake(now - 3 * DAY_MS);
  const postBId = timestampToSnowflake(now - 2 * DAY_MS);

  const mockFetch = async (url) => {
    if (url.includes('/channels/f-forum/threads/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          threads: [
            {
              id: postAId,
              parent_id: 'f-forum',
              name: 'Hidden post',
              thread_metadata: { create_timestamp: new Date(now - 3 * DAY_MS).toISOString() },
            },
            {
              id: postBId,
              parent_id: 'f-forum',
              name: 'Visible post',
              thread_metadata: { create_timestamp: new Date(now - 2 * DAY_MS).toISOString() },
            },
          ],
          has_more: false,
          total_results: 2,
        }),
      };
    }
    if (url.includes('/channels/f-forum/threads/archived/public')) {
      return { ok: true, status: 200, json: async () => ({ threads: [], has_more: false }) };
    }
    if (url.includes(`/channels/${postAId}/messages`)) {
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ message: 'Missing Access', code: 50001 }),
      };
    }
    if (url.includes(`/channels/${postBId}/messages`)) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: postBId,
            author: { id: 'u1', username: 'asker', bot: false },
            content: 'Where is the config?',
            timestamp: new Date(now - 2 * DAY_MS).toISOString(),
          },
        ],
      };
    }
    throw new Error(`Unexpected URL in inaccessible-post test: ${url}`);
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const result = await fetchForumPostsRest(
      'g2',
      { id: 'f-forum', name: '🆘-support', type: DiscordChannelType.GuildForum },
      { token: 'user-tok', hours: 90 * 24, requestDelayMs: 0, maxRetries: 0, fetchImpl: mockFetch, sleepImpl: async () => {} }
    );

    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0].postId, postBId);
    assert.equal(result.inaccessibleThreadCount, 1);
    assert.equal(result.budgetSkippedThreadCount, 0);
    assert.equal(result.truncated, false);
    assert.equal(
      warnings.some((w) => w.includes('Skipping inaccessible post "Hidden post"') && w.includes('#🆘-support')),
      true,
      'Inaccessible post skip must emit a visible warning'
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('extractTopKeywords ranks exact word and message frequencies, filters EN/ES stop words, and excludes contextOnly starters', () => {
  const messages = [
    {
      id: 'm0',
      author: 'old_author',
      content: '[Forum Post: "Legacy setup"] legacytoken legacytoken legacytoken',
      contextOnly: true,
      timestamp: '2026-01-01T00:00:00Z',
    },
    {
      id: 'm1',
      author: 'alice',
      content: 'The DeepSeek API and MCP server work great with deepseek-flash! Hola gracias para todos <@123456> https://example.com/deepseek',
      timestamp: '2026-10-01T10:00:00Z',
    },
    {
      id: 'm2',
      author: 'bob',
      content: 'Yes, DeepSeek and MCP configuration in WSL is fast. [Attached: deepseek.png]',
      timestamp: '2026-10-01T10:05:00Z',
    },
    {
      id: 'm3',
      author: 'charlie',
      content: 'DeepSeek API key setup in .env',
      timestamp: '2026-10-01T10:10:00Z',
    },
  ];

  const keywords = extractTopKeywords(messages, { limit: 10 });
  const words = keywords.map((k) => k.word);

  // Out-of-window contextOnly starter must be excluded from window keyword counts
  assert.equal(words.includes('legacytoken'), false);

  // Stop words (English & Spanish) and attachment/URL noise must be excluded
  for (const stop of ['the', 'and', 'with', 'hola', 'gracias', 'para', 'todos', 'attached']) {
    assert.equal(words.includes(stop), false, `Stop word "${stop}" should be filtered`);
  }

  // Exact counts for top technical terms (including short terms like api, mcp, wsl, env)
  const deepseekEntry = keywords.find((k) => k.word === 'deepseek');
  assert.deepEqual(deepseekEntry, { word: 'deepseek', count: 3, messageCount: 3 });

  const mcpEntry = keywords.find((k) => k.word === 'mcp');
  assert.deepEqual(mcpEntry, { word: 'mcp', count: 2, messageCount: 2 });

  const apiEntry = keywords.find((k) => k.word === 'api');
  assert.deepEqual(apiEntry, { word: 'api', count: 2, messageCount: 2 });

  assert.equal(words.includes('wsl'), true);
  assert.equal(words.includes('env'), true);
});

test('extractQuestionsAndDoubts and summarizeMessages handle out-of-window contextOnly starters, deleted starters, and confirmed vs heuristic answers without false confirmed claims', async () => {
  const forumPosts = [
    // Post 1: Out-of-window starter (contextOnly: true) + heuristic guidance reply (unconfirmed by author)
    {
      postId: 'p-old-heuristic',
      title: 'How to configure custom base URL?',
      author: 'carlos',
      createdAt: '2026-03-01T10:00:00.000Z',
      starterQuestion: 'Where do I set a custom LLM base URL for the proxy?',
      replyCount: 1,
      answered: true,
      messages: [
        {
          id: 'p-old-heuristic',
          author: 'carlos',
          content: '[Forum Post: "How to configure custom base URL?"] Where do I set a custom LLM base URL for the proxy?',
          timestamp: '2026-03-01T10:00:00.000Z',
          contextOnly: true,
        },
        {
          id: 'r-old-1',
          author: 'staff_elena',
          content: 'Set LLM_BASE_URL in your .env file to point to your proxy.',
          timestamp: '2026-10-05T12:00:00.000Z',
        },
      ],
    },
    // Post 2: Explicitly confirmed resolution (author confirms "That fixed it immediately, thank you!")
    {
      postId: 'p-confirmed',
      title: 'WSL2 Docker socket issue',
      author: 'dana',
      createdAt: '2026-10-06T09:00:00.000Z',
      starterQuestion: 'WSL2 Docker fails to connect on Windows 11.',
      replyCount: 2,
      answered: true,
      messages: [
        {
          id: 'p-confirmed',
          author: 'dana',
          content: '[Forum Post: "WSL2 Docker socket issue"] WSL2 Docker fails to connect on Windows 11.',
          timestamp: '2026-10-06T09:00:00.000Z',
        },
        {
          id: 'r-conf-1',
          author: 'staff_elena',
          content: 'Enable "Use WSLg socket" in Docker settings.',
          timestamp: '2026-10-06T09:10:00.000Z',
        },
        {
          id: 'r-conf-2',
          author: 'dana',
          content: 'That fixed it immediately, thank you!',
          timestamp: '2026-10-06T09:20:00.000Z',
        },
      ],
    },
    // Post 3: Deleted/missing starter message (all messages in post.messages are replies, replyCount === messages.length)
    {
      postId: 'p-missing-starter',
      title: 'JetBrains Gateway SSH timeout after 60s',
      author: 'user:998877',
      createdAt: '2026-10-07T08:00:00.000Z',
      starterQuestion: 'JetBrains Gateway SSH timeout after 60s',
      replyCount: 1,
      answered: false,
      messages: [
        {
          id: 'r-miss-1',
          author: 'other_user',
          content: 'I need this too for my config.',
          timestamp: '2026-10-07T08:30:00.000Z',
        },
      ],
    },
  ];

  // Window messages exclude the contextOnly starter from Post 1 (5 in-window messages total)
  const windowMessages = forumPosts.flatMap((p) => p.messages.filter((m) => !m.contextOnly));
  assert.equal(windowMessages.length, 5);

  const qaStats = extractQuestionsAndDoubts(windowMessages, forumPosts);
  assert.equal(qaStats.totalQuestions, 3);
  assert.equal(qaStats.answeredCount, 2);
  assert.equal(qaStats.confirmedCount, 1);
  assert.equal(qaStats.heuristicAnsweredCount, 1);
  assert.equal(qaStats.unansweredCount, 1);
  assert.equal(qaStats.outOfWindowStarterCount, 1);
  assert.equal(qaStats.missingStarterCount, 1);

  // Post 1: recovered starterQuestion from contextOnly starter, marked heuristic (not confirmed)
  const q1 = qaStats.questions.find((q) => q.id === 'p-old-heuristic');
  assert.equal(q1.question, 'Where do I set a custom LLM base URL for the proxy?');
  assert.equal(q1.starterContextOnly, true);
  assert.equal(q1.answered, true);
  assert.equal(q1.confirmed, false);
  assert.equal(q1.resolutionStatus, 'heuristic');
  assert.match(q1.answerPreview, /^Set LLM_BASE_URL/);
  assert.doesNotMatch(q1.answerPreview, /staff_elena/);

  // Post 2: confirmed by author follow-up
  const q2 = qaStats.questions.find((q) => q.id === 'p-confirmed');
  assert.equal(q2.answered, true);
  assert.equal(q2.confirmed, true);
  assert.equal(q2.resolutionStatus, 'confirmed');

  // Post 3: missing starter uses starterQuestion/title (NOT messages[0] reply) as question
  const q3 = qaStats.questions.find((q) => q.id === 'p-missing-starter');
  assert.equal(q3.missingStarter, true);
  assert.equal(q3.question, 'JetBrains Gateway SSH timeout after 60s');
  assert.equal(q3.answered, false);
  assert.equal(q3.confirmed, false);

  // Verify local fallback summary distinguishes Confirmed Resolution from Heuristic / Unconfirmed Reply
  const localForumResult = await summarizeMessages(windowMessages, {
    channelName: '🆘-support',
    channelType: 'forum',
    posts: forumPosts,
    llmConfig: { provider: 'fallback', apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  });
  assert.equal(localForumResult.stats.totalMessages, 5); // excludes contextOnly starter
  assert.equal(localForumResult.stats.participants.some((p) => p.author === 'carlos'), false); // carlos only had out-of-window starter
  assert.match(localForumResult.summary, /1\*\* confirmed resolved, \*\*1\*\* with heuristic\/unconfirmed answer replies, \*\*1\*\* unanswered/);
  assert.match(localForumResult.summary, /\*\*\[Confirmed Resolution\]\*\* \*\*WSL2 Docker socket issue\*\*/);
  assert.match(
    localForumResult.summary,
    /\*\*\[Suggested Answer \/ Unconfirmed Reply \(Heuristic\)\]\*\* \*\*How to configure custom base URL\?\*\*/
  );

  // Verify DeepSeek LLM call receives QA_SYSTEM_PROMPT and structured Forum Post units for Forum channels,
  // and GENERAL_CHAT_SYSTEM_PROMPT with exact keyword counts for Chat channels
  const capturedCalls = [];
  const mockLlmFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    capturedCalls.push(body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '**Support & Q&A Overview**\nMocked LLM summary.' } }],
      }),
    };
  };

  await summarizeMessages(windowMessages, {
    channelName: '🆘-support',
    channelType: 'forum',
    posts: forumPosts,
    llmConfig: {
      provider: 'deepseek',
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
    },
    fetchImpl: mockLlmFetch,
  });

  assert.equal(capturedCalls.length, 1);
  assert.equal(capturedCalls[0].messages[0].content, QA_SYSTEM_PROMPT);
  assert.match(capturedCalls[0].messages[1].content, /Structured Forum Posts \(Question \+ Replies Units\):/);
  assert.match(capturedCalls[0].messages[1].content, /=== Forum Post #1: "How to configure custom base URL\?"/);
  assert.match(capturedCalls[0].messages[1].content, /created prior to lookback window — retained for question context only/);
  assert.match(capturedCalls[0].messages[1].content, /original starter message deleted; inferred from thread title/);

  await summarizeMessages(
    [
      { id: 'c1', author: 'alice', content: 'Testing the Junie plugin with DeepSeek models today!', timestamp: '2026-10-08T10:00:00Z' },
      { id: 'c2', author: 'bob', content: 'Junie plugin works great on TypeScript projects.', timestamp: '2026-10-08T10:02:00Z' },
    ],
    {
      channelName: '💬-chat',
      channelType: 'chat',
      llmConfig: {
        provider: 'deepseek',
        apiKey: 'sk-test-key',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
      },
      fetchImpl: mockLlmFetch,
    }
  );

  assert.equal(capturedCalls.length, 2);
  assert.equal(capturedCalls[1].messages[0].content, GENERAL_CHAT_SYSTEM_PROMPT);
  assert.match(capturedCalls[1].messages[1].content, /Top Measured Keywords \(exact in-window frequency\):.*junie \(2 occurrences across 2 messages\)/);
});

test('chunkForumPosts preserves forum thread units across chunks including oversized posts, and Map-Reduce is bounded at both channel and master levels', async () => {
  // 1. Oversized post (1 starter + 4 replies = 5 messages) + normal post (2 messages) with chunkSize = 2
  const oversizedPost = {
    postId: 'post-big',
    title: 'Mega thread on memory spikes',
    author: 'alice',
    createdAt: '2026-10-01T00:00:00.000Z',
    starterQuestion: 'Why does indexing use 4GB RAM?',
    replyCount: 4,
    answered: true,
    messages: [
      { id: 'post-big', author: 'alice', content: '[Forum Post: "Mega thread on memory spikes"] Why does indexing use 4GB RAM?', timestamp: '2026-10-01T00:00:00.000Z' },
      { id: 'r1', author: 'bob', content: 'Reply 1 about heap size', timestamp: '2026-10-01T00:01:00.000Z' },
      { id: 'r2', author: 'charlie', content: 'Reply 2 about GC flags', timestamp: '2026-10-01T00:02:00.000Z' },
      { id: 'r3', author: 'dave', content: 'Reply 3 about worker threads', timestamp: '2026-10-01T00:03:00.000Z' },
      { id: 'r4', author: 'alice', content: 'Reply 4 that fixed it immediately, thank you!', timestamp: '2026-10-01T00:04:00.000Z' },
    ],
  };

  const normalPost = {
    postId: 'post-small',
    title: 'Quick question on CLI',
    author: 'eve',
    createdAt: '2026-10-02T00:00:00.000Z',
    starterQuestion: 'How do I run export-server?',
    replyCount: 1,
    answered: true,
    messages: [
      { id: 'post-small', author: 'eve', content: '[Forum Post: "Quick question on CLI"] How do I run export-server?', timestamp: '2026-10-02T00:00:00.000Z' },
      { id: 'r5', author: 'bob', content: 'Run npm run export-server in terminal.', timestamp: '2026-10-02T00:01:00.000Z' },
    ],
  };

  const forumChunks = chunkForumPosts([oversizedPost, normalPost], 2);
  // Oversized post (4 replies with max 1 reply + 1 starter per chunk of size 2) -> 4 parts, plus 1 chunk for normalPost -> 5 chunks
  assert.equal(forumChunks.length, 5);

  for (let i = 0; i < 4; i++) {
    const chunk = forumChunks[i];
    assert.equal(chunk.posts.length, 1);
    const partPost = chunk.posts[0];
    assert.equal(partPost.postId, 'post-big');
    assert.equal(partPost.title, 'Mega thread on memory spikes');
    assert.equal(partPost.starterQuestion, 'Why does indexing use 4GB RAM?');
    assert.equal(partPost.partIndex, i + 1);
    assert.equal(partPost.partCount, 4);
    assert.equal(partPost.messages.length, 2); // starter + 1 reply <= chunkSize (2)
    if (i > 0) {
      // Continuation parts mark starter as contextOnly so window messages are never double-counted
      assert.equal(partPost.messages[0].contextOnly, true);
    }
    const transcript = buildForumTranscript(chunk.posts, chunk.messages);
    assert.match(transcript, /Mega thread on memory spikes.*\[Part \d\/4\]/);
    assert.match(transcript, /Why does indexing use 4GB RAM\?/);
  }

  // Total in-window messages across all 5 chunks must equal the exact 7 messages (no duplication!)
  const totalWindowMsgsAcrossChunks = forumChunks.reduce((sum, c) => sum + c.messages.length, 0);
  assert.equal(totalWindowMsgsAcrossChunks, 7);

  // 2. Verify hierarchical bounded reduction at both Channel and Master levels (maxReduceBatchSize = 2)
  const llmPrompts = [];
  const mockBoundedLlmFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    llmPrompts.push(body.messages[1].content);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '### 1. Executive Summary\nConsolidated summary output.' } }],
      }),
    };
  };

  const allForumMsgs = [...oversizedPost.messages, ...normalPost.messages];
  const forumDigest = await summarizeChannelHistory(
    {
      channelId: 'f-1',
      channelName: '🆘-support',
      categoryName: 'Support',
      channelType: 'forum',
      posts: [oversizedPost, normalPost],
      messages: allForumMsgs,
    },
    {
      chunkSize: 2,
      maxReduceBatchSize: 2,
      llmConfig: {
        provider: 'deepseek',
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
      },
      fetchImpl: mockBoundedLlmFetch,
    }
  );

  assert.equal(forumDigest.chunkCount, 5);
  assert.equal(forumDigest.messageCount, 7);
  assert.equal(forumDigest.postCount, 2);
  assert.equal(forumDigest.qaStats.totalQuestions, 2); // Not inflated by oversized post parts

  // Every map call for the 5 forum chunks must have received Structured Forum Posts
  const mapPrompts = llmPrompts.slice(0, 5);
  for (const p of mapPrompts) {
    assert.match(p, /Structured Forum Posts \(Question \+ Replies Units\):/);
  }
  // And none of the reduction prompts (after the 5 map calls) may contain more than 2 "#### Segment" headers at once
  const reducePrompts = llmPrompts.slice(5);
  assert.ok(reducePrompts.length >= 3, '5 segments with maxReduceBatchSize=2 must take multiple hierarchical reduction calls');
  for (const rp of reducePrompts) {
    const segMatches = rp.match(/#### Segment \d+/g) || [];
    assert.ok(segMatches.length <= 2, `Reduction call exceeded maxReduceBatchSize=2 (got ${segMatches.length})`);
  }

  // 3. Verify Master level hierarchical reduction when server has 5 channels and maxReduceBatchSize = 2
  const masterPrompts = [];
  const fiveChannelBundle = {
    guildId: 'g-5',
    guildName: 'Five Channel Server',
    lookbackDays: 90,
    channels: Array.from({ length: 5 }, (_, idx) => ({
      channelId: `ch-${idx + 1}`,
      channelName: `chat-${idx + 1}`,
      categoryName: 'General',
      channelType: 'chat',
      messages: [
        {
          id: `m-${idx + 1}`,
          author: 'alice',
          content: `Discussion in channel ${idx + 1} about DeepSeek workflow`,
          timestamp: '2026-10-10T10:00:00.000Z',
        },
      ],
    })),
  };

  await generateServerSupportReport(fiveChannelBundle, {
    reportOutputPath: '',
    maxReduceBatchSize: 2,
    llmConfig: {
      provider: 'deepseek',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      masterPrompts.push(body.messages[1].content);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '### 1. Executive Summary\nBounded master synthesis.' } }],
        }),
      };
    },
  });

  // First 5 calls are per-channel map calls; subsequent calls are master hierarchical reduction calls
  const masterReduceCalls = masterPrompts.slice(5);
  assert.ok(masterReduceCalls.length >= 3, '5 channels with maxReduceBatchSize=2 must use multi-stage master reduction');
  for (const mp of masterReduceCalls) {
    const channelHeaders = mp.match(/## Channel: #/g) || [];
    assert.ok(channelHeaders.length <= 2, `Master reduction call exceeded maxReduceBatchSize=2 (got ${channelHeaders.length})`);
  }
});

test('generateServerSupportReport writes per-channel and master Markdown reports with FAQ, Chat Topics, Top Keywords, and coverage counters without contacting Discord', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'discord-report-step3-'));
  const masterReportPath = path.join(tmpDir, 'reports', 'support-report-3months.md');

  const exportBundle = {
    guildId: 'g-step3',
    guildName: 'Junie Ambassador Test Server',
    lookbackDays: 90,
    timeframeStart: '2026-07-22T00:00:00.000Z',
    timeframeEnd: '2026-10-20T00:00:00.000Z',
    skippedChannels: [
      { channelId: '999', channelName: '🔒-private-mod', categoryName: 'Staff', channelType: 'chat', status: 403, code: 50001 },
    ],
    channels: [
      {
        channelId: '111',
        channelName: '💬-chat',
        categoryName: 'Community',
        channelType: 'chat',
        truncated: false,
        messages: [
          {
            id: 'c1',
            author: 'alice',
            content: 'We are testing the new DeepSeek integration in JetBrains WebStorm and IntelliJ!',
            timestamp: '2026-10-10T10:00:00.000Z',
          },
          {
            id: 'c2',
            author: 'bob',
            content: 'DeepSeek responses in WebStorm are super fast and accurate.',
            timestamp: '2026-10-10T10:05:00.000Z',
          },
        ],
      },
      {
        channelId: '222',
        channelName: '🆘-support',
        categoryName: 'Support',
        channelType: 'forum',
        truncated: true,
        inaccessibleThreadCount: 1,
        budgetSkippedThreadCount: 2,
        posts: [
          {
            postId: 'p1',
            title: 'How to configure DeepSeek API key?',
            author: 'carlos',
            createdAt: '2026-05-01T00:00:00.000Z',
            starterQuestion: 'Where do I put DEEPSEEK_API_KEY?',
            replyCount: 1,
            answered: true,
            messages: [
              {
                id: 'p1',
                author: 'carlos',
                content: '[Forum Post: "How to configure DeepSeek API key?"] Where do I put DEEPSEEK_API_KEY?',
                timestamp: '2026-05-01T00:00:00.000Z',
                contextOnly: true,
              },
              {
                id: 'p1-r1',
                author: 'elena_staff',
                content: 'Add DEEPSEEK_API_KEY to your .env file in the project root.',
                timestamp: '2026-10-12T12:00:00.000Z',
              },
            ],
          },
        ],
        messages: [
          {
            id: 'p1-r1',
            author: 'elena_staff',
            content: 'Add DEEPSEEK_API_KEY to your .env file in the project root.',
            timestamp: '2026-10-12T12:00:00.000Z',
          },
        ],
      },
    ],
  };

  try {
    let networkCalled = false;
    const offlineFetchGuard = async (url) => {
      networkCalled = true;
      throw new Error(`Offline report must not make network calls (attempted: ${url})`);
    };

    const result = await generateServerSupportReport(exportBundle, {
      reportOutputPath: masterReportPath,
      llmConfig: {
        provider: 'fallback',
        apiKey: '',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
      },
      fetchImpl: offlineFetchGuard,
    });

    assert.equal(networkCalled, false, 'Offline report generation must not call fetch');
    assert.equal(result.reportPath, masterReportPath);
    assert.equal(existsSync(masterReportPath), true);
    assert.equal(result.channelReportPaths.length, 2);

    const chatReportPath = path.join(tmpDir, 'reports', 'channels', 'chat.md');
    const supportReportPath = path.join(tmpDir, 'reports', 'channels', 'support.md');
    assert.equal(existsSync(chatReportPath), true);
    assert.equal(existsSync(supportReportPath), true);

    // Exact deterministic window metrics (2 chat msgs + 1 in-window forum reply = 3 messages; out-of-window starter excluded)
    assert.equal(result.globalStats.totalMessages, 3);
    assert.equal(result.qaSummary.totalQuestions, 1);
    assert.equal(result.qaSummary.confirmedCount, 0);
    assert.equal(result.qaSummary.heuristicAnsweredCount, 1);
    assert.equal(result.qaSummary.outOfWindowStarterCount, 1);
    assert.equal(result.qaSummary.inaccessibleThreadCount, 1);
    assert.equal(result.qaSummary.budgetSkippedThreadCount, 2);

    const masterMd = readFileSync(masterReportPath, 'utf8');
    assert.match(masterMd, /### 1\. Executive Summary/);
    assert.match(masterMd, /### 2\. Forum & Q&A Channels — Most Frequent Questions & Common Doubts \(FAQ\)/);
    assert.match(masterMd, /### 3\. General Chat Channels — Main Discussion Topics & Community Vibe/);
    assert.match(masterMd, /### 4\. Most Frequently Used Keywords & Technical Terms \(Server-wide & Per-Channel\)/);
    assert.match(masterMd, /### 5\. Channel-by-Channel Breakdown/);
    assert.match(masterMd, /### 6\. Meeting Talking Points & Action Items/);
    assert.doesNotMatch(masterMd, /Key Contributors|Top Active Contributors|asked by/i);
    assert.match(masterMd, /Skipped Inaccessible Channels\*\*: 1 \(#🔒-private-mod\)/);
    assert.match(masterMd, /1 truncated channel\(s\), 1 inaccessible forum thread\(s\) skipped, 2 budget-skipped forum thread\(s\)/);
    assert.match(masterMd, /Where do I put DEEPSEEK_API_KEY\?/);
    assert.match(masterMd, /\[Suggested Answer \/ Unconfirmed Reply \(Heuristic\)\]/);

    const supportMd = readFileSync(supportReportPath, 'utf8');
    assert.match(supportMd, /# Channel Report: #🆘-support/);
    assert.match(supportMd, /### Data Coverage & Export Notes/);
    assert.match(supportMd, /1 forum post\(s\)\/thread\(s\) were skipped due to missing Discord channel\/thread access/);
    assert.match(supportMd, /2 forum post\(s\)\/thread\(s\) were not exported because the channel message budget was reached/);
    assert.match(supportMd, /1 forum post starter\(s\) were created prior to the 90-day window/);

    const chatMd = readFileSync(chatReportPath, 'utf8');
    assert.match(chatMd, /# Channel Report: #💬-chat/);
    assert.match(chatMd, /`deepseek`/);
    assert.match(chatMd, /`webstorm`/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('single-channel master synthesis, missing-starter oversized continuation, huge post/reply prompt bounds without truncation, collision-free filenames, and exported forum tag confirmation', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'discord-step3-edgecases-'));

  try {
    // 1. Exported Forum Applied Tag Resolution (available_tags + applied_tags IDs -> post.tags: ['Solved'] -> confirmed)
    const now = Date.now();
    const DAY_MS = 24 * 3600 * 1000;
    const tagThreadId = timestampToSnowflake(now - 3 * DAY_MS);

    const taggedExport = await fetchForumPostsRest(
      'g-tag',
      {
        id: 'forum-tag',
        name: '🆘-support',
        type: DiscordChannelType.GuildForum,
        available_tags: [
          { id: 'tag_solved_99', name: 'Solved' },
          { id: 'tag_bug_11', name: 'Bug Report' },
        ],
      },
      {
        token: 'user-tok',
        hours: 90 * 24,
        requestDelayMs: 0,
        sleepImpl: async () => {},
        fetchImpl: async (url) => {
          if (url.includes('/threads/search')) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                threads: [
                  {
                    id: tagThreadId,
                    parent_id: 'forum-tag',
                    name: 'How to set custom timeout in CLI?',
                    owner_id: 'u_asker',
                    applied_tags: ['tag_solved_99', 'tag_bug_11'],
                    thread_metadata: {
                      archived: false,
                      create_timestamp: new Date(now - 3 * DAY_MS).toISOString(),
                    },
                  },
                ],
                has_more: false,
              }),
            };
          }
          if (url.includes('/threads/archived/public')) {
            return { ok: true, status: 200, json: async () => ({ threads: [], has_more: false }) };
          }
          if (url.includes(`/channels/${tagThreadId}/messages`)) {
            return {
              ok: true,
              status: 200,
              json: async () => [
                {
                  id: timestampToSnowflake(now - 3 * DAY_MS + 60000),
                  author: { id: 'u_mod', username: 'mod_helper', bot: false },
                  content: 'Pass DISCORD_REQUEST_DELAY_MS in .env.',
                  timestamp: new Date(now - 3 * DAY_MS + 60000).toISOString(),
                },
                {
                  id: tagThreadId,
                  author: { id: 'u_asker', username: 'dana_dev', bot: false },
                  content: 'How can I change the request delay?',
                  timestamp: new Date(now - 3 * DAY_MS).toISOString(),
                },
              ],
            };
          }
          throw new Error(`Unexpected URL in tag test: ${url}`);
        },
      }
    );

    assert.equal(taggedExport.posts.length, 1);
    assert.deepEqual(taggedExport.posts[0].tags, ['Solved', 'Bug Report']);
    assert.deepEqual(taggedExport.posts[0].appliedTags, ['tag_solved_99', 'tag_bug_11']);
    assert.equal(taggedExport.posts[0].answered, true);

    // 2. Single-channel server master synthesis & authoritative deterministic FAQ/Keyword sections even when LLM repeats headings
    const singleChannelPrompts = [];
    const singleChannelBundle = {
      guildId: 'g-single',
      guildName: 'Single Forum Server',
      lookbackDays: 90,
      channels: [
        {
          channelId: '222',
          channelName: '🆘-support',
          categoryName: 'Support',
          channelType: 'forum',
          posts: taggedExport.posts,
          messages: taggedExport.messages,
        },
      ],
    };

    const singleChannelReport = await generateServerSupportReport(singleChannelBundle, {
      reportOutputPath: '',
      llmConfig: {
        provider: 'deepseek',
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
      },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        const userPrompt = body.messages[1].content;
        singleChannelPrompts.push(userPrompt);
        if (singleChannelPrompts.length === 1) {
          // Map call returns a channel summary containing "**Most Frequent Questions & Common Doubts (FAQ)**"
          return {
            ok: true,
            json: async () => ({
              choices: [
                {
                  message: {
                    content:
                      '**Support & Q&A Overview**\n1 thread analyzed.\n\n**Most Frequent Questions & Common Doubts (FAQ)**\n- Custom timeout question.',
                  },
                },
              ],
            }),
          };
        }
        // Master synthesis call repeats Section 2 & Section 4 headings in prose without the exact deterministic tables
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content:
                    '### 2. Forum & Q&A Channels — Most Frequent Questions & Common Doubts (FAQ)\nHigh-level narrative only.\n\n### 4. Most Frequently Used Keywords & Technical Terms (Server-wide & Per-Channel)\nHigh-level keyword narrative only.',
                },
              },
            ],
          }),
        };
      },
    });

    // Must run BOTH the map call and the master synthesis call (2 calls total, not 1)
    assert.equal(singleChannelPrompts.length, 2, 'Single-channel server must still run master synthesis LLM call');
    assert.equal(singleChannelReport.qaSummary.confirmedCount, 1);
    assert.equal(singleChannelReport.qaSummary.heuristicAnsweredCount, 0);
    // Section 1 (Executive Summary) must be present even if omitted by LLM
    assert.match(singleChannelReport.markdownReport, /### 1\. Executive Summary/);
    // Authoritative deterministic FAQ breakdown (with Confirmed Resolution + Tags: Solved) and Keyword tables must still be included
    assert.match(singleChannelReport.markdownReport, /How to set custom timeout in CLI\?.*\[Confirmed Resolution\].*\(Tags: Solved, Bug Report\)/);
    assert.match(singleChannelReport.markdownReport, /#### Server-Wide Top Keywords \(In-Window Exact Counts\)/);
    assert.match(singleChannelReport.markdownReport, /#### Per-Channel Keyword Rankings/);

    // 3. Oversized post with deleted starter (missingStarter) preserves ALL replies and Created date across split parts
    const missingStarterOversizedPost = {
      postId: 'p-missing-big',
      title: 'Deleted starter mega thread',
      author: 'original_owner',
      createdAt: '2026-08-15T09:30:00.000Z',
      starterQuestion: 'Deleted starter mega thread',
      replyCount: 4,
      answered: true,
      messages: [
        { id: 'rep-1', author: 'helper_1', content: 'REPLY_1 first diagnostic step', timestamp: '2026-10-01T10:00:00.000Z' },
        { id: 'rep-2', author: 'helper_2', content: 'REPLY_2 second diagnostic step', timestamp: '2026-10-01T10:05:00.000Z' },
        { id: 'rep-3', author: 'helper_3', content: 'REPLY_3 third diagnostic step', timestamp: '2026-10-01T10:10:00.000Z' },
        { id: 'rep-4', author: 'helper_4', content: 'REPLY_4 fourth diagnostic step', timestamp: '2026-10-01T10:15:00.000Z' },
      ],
    };

    const missingStarterChunks = chunkForumPosts([missingStarterOversizedPost], 2);
    assert.equal(missingStarterChunks.length, 2);
    const msTranscript1 = buildForumTranscript(missingStarterChunks[0].posts, missingStarterChunks[0].messages);
    const msTranscript2 = buildForumTranscript(missingStarterChunks[1].posts, missingStarterChunks[1].messages);
    assert.match(msTranscript1, /REPLY_1 first diagnostic step/);
    assert.match(msTranscript1, /REPLY_2 second diagnostic step/);
    assert.match(msTranscript1, /original starter message deleted; inferred from thread title/);
    assert.match(msTranscript1, /Created: 2026-08-15 09:30 UTC/);
    assert.match(msTranscript2, /REPLY_3 third diagnostic step/);
    assert.match(msTranscript2, /REPLY_4 fourth diagnostic step/);
    assert.match(msTranscript2, /original starter message deleted; inferred from thread title/);
    assert.match(msTranscript2, /Created: 2026-08-15 09:30 UTC/);

    // 4. Huge forum post (60 replies of ~2,000 chars each at default 24,000 budget) never exceeds maxPromptChars or truncates
    const sixtyHugeReplies = Array.from({ length: 60 }, (_, idx) => ({
      id: `huge-r-${idx + 1}`,
      author: `engineer_${idx + 1}`,
      content: `REPLY_START_${idx + 1} ${'detailed_stack_trace_analysis '.repeat(62)} REPLY_END_${idx + 1}`,
      timestamp: new Date(Date.UTC(2026, 9, 10, 12, idx % 60)).toISOString(),
    }));
    const hugeForumPost = {
      postId: 'post-60-replies',
      title: 'DeepSeek large context stress test',
      author: 'stress_asker',
      createdAt: '2026-10-10T11:00:00.000Z',
      starterQuestion: 'How does the chunker handle 60 replies of 2,000 characters each?',
      replyCount: 60,
      answered: true,
      messages: [
        {
          id: 'post-60-replies',
          author: 'stress_asker',
          content: '[Forum Post: "DeepSeek large context stress test"] How does the chunker handle 60 replies of 2,000 characters each?',
          timestamp: '2026-10-10T11:00:00.000Z',
        },
        ...sixtyHugeReplies,
      ],
    };

    const recordedHugePrompts = [];
    await summarizeChannelHistory(
      {
        channelId: 'f-stress',
        channelName: '🆘-support',
        categoryName: 'Support',
        channelType: 'forum',
        posts: [hugeForumPost],
        messages: hugeForumPost.messages,
      },
      {
        chunkSize: 150,
        maxPromptChars: 24000,
        llmConfig: {
          provider: 'deepseek',
          apiKey: 'sk-test',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
        },
        fetchImpl: async (_url, options) => {
          const body = JSON.parse(options.body);
          recordedHugePrompts.push(body.messages[1].content);
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: 'Chunk summary ok.' } }],
            }),
          };
        },
      }
    );

    assert.ok(recordedHugePrompts.length >= 6, '60 x 2,000-char replies must split into multiple bounded map chunks + reduce');
    for (const p of recordedHugePrompts) {
      assert.ok(p.length <= 24000, `Prompt length ${p.length} exceeded maxPromptChars=24000`);
      assert.equal(p.includes('[prompt truncated at context budget]'), false, 'Prompt must not be hard-truncated');
      assert.equal(p.includes('[post truncated at prompt character budget]'), false, 'Post must not be hard-truncated');
      assert.equal(p.includes('[additional forum posts truncated'), false, 'Forum posts must not be dropped');
    }
    // Verify the tail marker of every single one of the 60 replies appeared intact in the map prompts
    const combinedMapPrompts = recordedHugePrompts.join('\n');
    for (let idx = 1; idx <= 60; idx++) {
      assert.equal(
        combinedMapPrompts.includes(`REPLY_END_${idx}`),
        true,
        `End of reply #${idx} (REPLY_END_${idx}) was lost or truncated`
      );
    }

    // 5. Collision-free per-channel report filenames (`💬-chat` id 111, `🗨️-chat` id 222, `chat-111` id 333)
    const collisionReportPath = path.join(tmpDir, 'reports', 'support-report-3months.md');
    const collisionBundle = {
      guildId: 'g-collide',
      guildName: 'Collision Test Server',
      lookbackDays: 90,
      channels: [
        {
          channelId: '111',
          channelName: '💬-chat',
          categoryName: 'General',
          channelType: 'chat',
          messages: [{ id: 'm1', author: 'a', content: 'Message in emoji chat 111', timestamp: '2026-10-10T10:00:00Z' }],
        },
        {
          channelId: '222',
          channelName: '🗨️-chat',
          categoryName: 'General',
          channelType: 'chat',
          messages: [{ id: 'm2', author: 'b', content: 'Message in speech chat 222', timestamp: '2026-10-10T10:01:00Z' }],
        },
        {
          channelId: '333',
          channelName: 'chat-111',
          categoryName: 'General',
          channelType: 'chat',
          messages: [{ id: 'm3', author: 'c', content: 'Message in literal chat-111 (id 333)', timestamp: '2026-10-10T10:02:00Z' }],
        },
      ],
    };

    const collisionResult = await generateServerSupportReport(collisionBundle, {
      reportOutputPath: collisionReportPath,
      llmConfig: { provider: 'fallback', apiKey: '', baseUrl: '', model: '' },
    });

    assert.equal(collisionResult.channelReportPaths.length, 3);
    const uniquePaths = new Set(collisionResult.channelReportPaths.map((p) => p.toLowerCase()));
    assert.equal(uniquePaths.size, 3, 'All 3 colliding channel names must produce distinct file paths');
    for (const filePath of collisionResult.channelReportPaths) {
      assert.equal(existsSync(filePath), true);
    }
    const allChannelReportsContent = collisionResult.channelReportPaths
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
    assert.match(allChannelReportsContent, /# Channel Report: #💬-chat/);
    assert.match(allChannelReportsContent, /# Channel Report: #🗨️-chat/);
    assert.match(allChannelReportsContent, /# Channel Report: #chat-111/);

    // 6. Oversized 60,000-char chat and Q&A messages keep all continuation parts in LLM prompts, preserve remote providerUsed, and count original message/question once
    const sixtyKBody =
      `CHAT_60K_HEAD_MARKER How do we configure deepseek caching? ` +
      `${'deepseek caching architecture discussion '.repeat(1500)} ` +
      `CHAT_60K_TAIL_MARKER`;
    assert.ok(sixtyKBody.length > 60000);

    const chat60kPrompts = [];
    const chat60kDigest = await summarizeChannelHistory(
      {
        channelId: 'chat-60k',
        channelName: '💬-chat',
        categoryName: 'General',
        channelType: 'chat',
        messages: [
          {
            id: 'msg-60k-1',
            author: 'architect_dev',
            content: sixtyKBody,
            timestamp: '2026-10-12T10:00:00.000Z',
          },
        ],
      },
      {
        chunkSize: 150,
        maxPromptChars: 24000,
        llmConfig: {
          provider: 'deepseek',
          apiKey: 'sk-test',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
        },
        fetchImpl: async (_url, options) => {
          const body = JSON.parse(options.body);
          chat60kPrompts.push(body.messages[1].content);
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: 'Chat 60k segment summary.' } }],
            }),
          };
        },
      }
    );

    assert.equal(chat60kDigest.providerUsed, 'deepseek (deepseek-flash)', 'Oversized chat message must not drop to local-fallback');
    assert.equal(chat60kDigest.messageCount, 1, 'Split continuation parts must not inflate channel messageCount');
    assert.equal(chat60kDigest.stats.totalMessages, 1, 'Split continuation parts must not inflate stats.totalMessages');
    assert.equal(chat60kDigest.stats.participants[0].count, 1, 'Split continuation parts must not inflate participant message count');
    assert.ok(chat60kPrompts.length >= 4, '60k message should trigger 3 map calls + 1 reduce call');
    for (const p of chat60kPrompts) {
      assert.ok(p.length <= 24000, `60k chat prompt length ${p.length} exceeded 24000`);
      assert.equal(p.includes('[prompt truncated at context budget]'), false);
      assert.equal(p.includes('[transcript truncated at context budget]'), false);
    }
    const combinedChat60kPrompts = chat60kPrompts.join('\n');
    assert.equal(combinedChat60kPrompts.includes('CHAT_60K_HEAD_MARKER'), true);
    assert.equal(
      combinedChat60kPrompts.includes('CHAT_60K_TAIL_MARKER'),
      true,
      'Tail marker of 60,000-char chat message must reach the LLM in continuation chunk'
    );

    // Also verify Q&A channel with 60,000-char question message counts only 1 question and keeps remote provider
    const qa60kDigest = await summarizeChannelHistory(
      {
        channelId: 'qa-60k',
        channelName: '❓-questions',
        categoryName: 'Support',
        channelType: 'qa',
        messages: [
          {
            id: 'qa-msg-60k',
            author: 'asker_60k',
            content: `${sixtyKBody} Can someone help?`,
            timestamp: '2026-10-12T11:00:00.000Z',
          },
        ],
      },
      {
        chunkSize: 150,
        maxPromptChars: 24000,
        llmConfig: {
          provider: 'deepseek',
          apiKey: 'sk-test',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
        },
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'QA 60k segment summary.' } }],
          }),
        }),
      }
    );
    assert.equal(qa60kDigest.providerUsed, 'deepseek (deepseek-flash)');
    assert.equal(qa60kDigest.qaStats.totalQuestions, 1, 'Oversized Q&A message must count as 1 question, not per continuation part');

    // 7. Long unbroken tokens (3,000-char base64/minified blobs, hex hashes) are rejected from keywords and never blow header budget
    const base64Blob3000 = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'.repeat(85);
    const shortBase64Token = 'eyJhbGciOiJIUzI1NiIs';
    const hexHashToken = 'deadbeef0123456789abcdef';
    const sixtyTokenReplies = Array.from({ length: 60 }, (_, idx) => ({
      id: `tok-r-${idx + 1}`,
      author: `dev_${idx + 1}`,
      content: `TOK_START_${idx + 1}authentication webstorm ${base64Blob3000.slice(0, 1850)} ${shortBase64Token} ${hexHashToken} TOK_END_${idx + 1}`,
      timestamp: new Date(Date.UTC(2026, 9, 11, 12, idx % 60)).toISOString(),
    }));
    const tokenStressPost = {
      postId: 'post-token-stress',
      title: 'Base64 log paste thread',
      author: 'log_poster',
      createdAt: '2026-10-11T10:00:00.000Z',
      starterQuestion: 'Why does authentication fail in webstorm with this token?',
      replyCount: 60,
      answered: true,
      messages: [
        {
          id: 'post-token-stress',
          author: 'log_poster',
          content: '[Forum Post: "Base64 log paste thread"] Why does authentication fail in webstorm with this token?',
          timestamp: '2026-10-11T10:00:00.000Z',
        },
        ...sixtyTokenReplies,
      ],
    };

    const tokenStressPrompts = [];
    const tokenStressDigest = await summarizeChannelHistory(
      {
        channelId: 'f-tok-stress',
        channelName: '🆘-support',
        categoryName: 'Support',
        channelType: 'forum',
        posts: [tokenStressPost],
        messages: tokenStressPost.messages,
      },
      {
        chunkSize: 150,
        maxPromptChars: 24000,
        llmConfig: {
          provider: 'deepseek',
          apiKey: 'sk-test',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
        },
        fetchImpl: async (_url, options) => {
          const body = JSON.parse(options.body);
          tokenStressPrompts.push(body.messages[1].content);
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: 'Token stress chunk ok.' } }],
            }),
          };
        },
      }
    );

    for (const kw of tokenStressDigest.topKeywords) {
      assert.ok(kw.word.length <= 30, `Keyword "${kw.word}" exceeded max token length 30`);
      assert.notEqual(kw.word, shortBase64Token.toLowerCase(), 'Base64 token must not be extracted as keyword');
      assert.notEqual(kw.word, hexHashToken.toLowerCase(), 'Hex hash token must not be extracted as keyword');
    }
    for (const p of tokenStressPrompts) {
      assert.ok(p.length <= 24000, `Token stress prompt length ${p.length} exceeded 24000`);
      assert.equal(p.includes('[prompt truncated at context budget]'), false, 'Long unbroken tokens must not cause prompt truncation');
    }
    const allTokenStressPrompts = tokenStressPrompts.join('\n');
    for (let idx = 1; idx <= 60; idx++) {
      assert.equal(
        allTokenStressPrompts.includes(`TOK_END_${idx}`),
        true,
        `Reply #${idx} tail marker TOK_END_${idx} was lost when replies contained unbroken base64 tokens`
      );
    }

    // 8. In LLM mode, when the LLM returns all 6 numbered headings, deterministic FAQ and Keyword blocks sit INSIDE Sections 2 and 4
    const sectionOrderReport = await generateServerSupportReport(
      {
        guildId: 'g-sec-order',
        guildName: 'Section Order Server',
        lookbackDays: 90,
        channels: [
          {
            channelId: 'f-sec-1',
            channelName: '🆘-support',
            categoryName: 'Support',
            channelType: 'forum',
            posts: taggedExport.posts,
            messages: taggedExport.messages,
          },
          {
            channelId: 'c-sec-2',
            channelName: '💬-chat',
            categoryName: 'General',
            channelType: 'chat',
            messages: [
              {
                id: 'c-m-1',
                author: 'alice',
                content: 'Testing deepseek and webstorm integration workflows today.',
                timestamp: '2026-10-12T10:00:00Z',
              },
            ],
          },
        ],
      },
      {
        reportOutputPath: null,
        channelReportsDir: null,
        llmConfig: {
          provider: 'deepseek',
          apiKey: 'sk-test',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
        },
        fetchImpl: async (_url, options) => {
          const body = JSON.parse(options.body);
          const sys = body.messages[0].content;
          if (sys.includes('Executive 3-Month Discord Retrospective Report')) {
            return {
              ok: true,
              json: async () => ({
                choices: [
                  {
                    message: {
                      content: [
                        '### 1. Executive Summary',
                        '- High-level LLM executive overview.',
                        '',
                        '### 2. Forum & Q&A Channels — Most Frequent Questions & Common Doubts (FAQ)',
                        '- LLM synthesis of support questions.',
                        '',
                        '### 3. General Chat Channels — Main Discussion Topics & Community Vibe',
                        '- LLM synthesis of chat topics.',
                        '',
                        '### 4. Most Frequently Used Keywords & Technical Terms (Server-wide & Per-Channel)',
                        '- LLM commentary on keyword trends.',
                        '',
                        '### 5. Channel-by-Channel Breakdown',
                        '- LLM per-channel summary.',
                        '',
                        '### 6. Meeting Talking Points & Action Items',
                        '- LLM action items.',
                      ].join('\n'),
                    },
                  },
                ],
              }),
            };
          }
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: 'Channel LLM digest.' } }],
            }),
          };
        },
      }
    );

    const md = sectionOrderReport.markdownReport;
    const posSec2 = md.indexOf('### 2. Forum & Q&A Channels');
    const posDetFaq = md.indexOf('#### Deterministic Forum & Q&A Resolution Breakdown (Authoritative)');
    const posSec3 = md.indexOf('### 3. General Chat Channels');
    const posSec4 = md.indexOf('### 4. Most Frequently Used Keywords');
    const posDetKwServer = md.indexOf('#### Server-Wide Top Keywords (In-Window Exact Counts)');
    const posDetKwChannel = md.indexOf('#### Per-Channel Keyword Rankings');
    const posSec5 = md.indexOf('### 5. Channel-by-Channel Breakdown');
    const posSec6 = md.indexOf('### 6. Meeting Talking Points & Action Items');

    assert.ok(posSec2 > 0 && posDetFaq > posSec2 && posDetFaq < posSec3, 'Deterministic FAQ breakdown must sit inside Section 2 (before Section 3)');
    assert.ok(
      posSec4 > posSec3 &&
        posDetKwServer > posSec4 &&
        posDetKwChannel > posDetKwServer &&
        posDetKwChannel < posSec5 &&
        posSec5 < posSec6,
      'Deterministic Keyword tables must sit inside Section 4 (before Sections 5 and 6)'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('extractTopKeywords strips whole encoded whitespace runs before tokenization and keeps only natural vocabulary', () => {
  // Deterministic >= 1,500-byte pseudo-random buffer encoded as base64 (contains +, /, = that would split into short fragments if tokenized first)
  const deterministicBytes = Buffer.alloc(1500);
  for (let i = 0; i < deterministicBytes.length; i++) {
    deterministicBytes[i] = (i * 73 + 41) ^ ((i >>> 2) * 19);
  }
  const largeBase64Paste = deterministicBytes.toString('base64');
  assert.ok(largeBase64Paste.length >= 2000, 'Base64 paste should be >= 2000 chars');
  assert.ok(/[+/=]/.test(largeBase64Paste), 'Base64 paste must include +, /, or = delimiters');

  const messages = [
    { id: '1', content: 'DeepSeek model fallback works reliably in WebStorm plugin.' },
    { id: '2', content: `Here is the crash payload: ${largeBase64Paste} please check.` },
    { id: '3', content: 'Authentication token setup for DeepSeek and WebStorm.' },
    { id: '4', content: `Raw dump (${largeBase64Paste}) and hex 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08` },
    { id: '5', content: 'Users asked about rate limits and pagination delay in Discord exporter.' },
    { id: '6', content: 'WebStorm plugin configuration and DeepSeek token troubleshooting.' },
    { id: '7', content: 'Exporter pagination handles Discord rate limits cleanly.' },
  ];

  const allowedVocabulary = new Set([
    'deepseek',
    'model',
    'fallback',
    'works',
    'reliably',
    'webstorm',
    'plugin',
    'crash',
    'payload',
    'check',
    'authentication',
    'token',
    'setup',
    'dump',
    'users',
    'asked',
    'rate',
    'limits',
    'pagination',
    'delay',
    'discord',
    'exporter',
    'configuration',
    'troubleshooting',
    'handles',
    'cleanly',
  ]);

  const keywords = extractTopKeywords(messages, { limit: 15 });
  const words = keywords.map((k) => k.word);
  assert.ok(words.includes('deepseek'), `Expected 'deepseek' in keywords: ${words.join(', ')}`);
  assert.ok(words.includes('webstorm'), `Expected 'webstorm' in keywords: ${words.join(', ')}`);
  assert.ok(words.length > 0, 'Should return natural keywords');

  for (const word of words) {
    assert.ok(
      allowedVocabulary.has(word),
      `Unexpected noise/fragment keyword "${word}" leaked into top keywords: ${words.join(', ')}`
    );
  }

  // Also verify a standalone 1,500-byte base64 paste produces 0 keywords
  const soloKeywords = extractTopKeywords([{ id: 'solo', content: largeBase64Paste }], { limit: 15 });
  assert.equal(soloKeywords.length, 0, `Standalone base64 paste should produce 0 keywords, got: ${soloKeywords.map((k) => k.word).join(', ')}`);
});

test('extractTopKeywords preserves legitimate slash, environment, and long hyphenated terms', () => {
  const keywords = extractTopKeywords(
    [
      { id: 'slash', content: 'IntelliJ/PyCharm' },
      { id: 'environment', content: 'LLM_PROVIDER=deepseek' },
      { id: 'hyphenated', content: 'github-copilot-integration' },
    ],
    { limit: 20 }
  );
  const words = new Set(keywords.map(({ word }) => word));

  for (const expected of [
    'intellij',
    'pycharm',
    'llm_provider',
    'deepseek',
    'github-copilot-integration',
  ]) {
    assert.ok(words.has(expected), `Expected legitimate term "${expected}" to be kept; got: ${[...words].join(', ')}`);
  }
});

test('extractTopKeywords removes fixed-width wrapped base64 in code fences and PEM envelopes', () => {
  const deterministicBytes = Buffer.alloc(1500);
  for (let i = 0; i < deterministicBytes.length; i++) {
    deterministicBytes[i] = (i * 73 + 41) ^ ((i >>> 2) * 19);
  }
  const base64Blob = deterministicBytes.toString('base64');
  assert.equal(base64Blob.length, 2000);
  const wrap = (width) => base64Blob.match(new RegExp(`.{1,${width}}`, 'g')).join('\n');

  const fencedWrapped76 = `\`\`\`\n${wrap(76)}\n\`\`\``;
  const pemWrapped64 = `-----BEGIN CERTIFICATE-----\n${wrap(64)}\n-----END CERTIFICATE-----`;

  const messages = [
    { id: '1', content: 'DeepSeek model fallback works reliably in WebStorm plugin.' },
    { id: '2', content: `Attached the config dump:\n${fencedWrapped76}\nplease check.` },
    { id: '3', content: `Certificate for the exporter:\n${pemWrapped64}` },
    { id: '4', content: 'Users asked about rate limits and pagination delay in Discord exporter.' },
    { id: '5', content: 'WebStorm plugin configuration and DeepSeek token troubleshooting.' },
  ];

  const allowedVocabulary = new Set([
    'deepseek', 'model', 'fallback', 'works', 'reliably', 'webstorm', 'plugin',
    'attached', 'config', 'dump', 'please', 'check',
    'certificate', 'begin', 'end', 'exporter',
    'users', 'asked', 'rate', 'limits', 'pagination', 'delay', 'discord',
    'configuration', 'troubleshooting', 'token',
  ]);

  const words = extractTopKeywords(messages, { limit: 30 }).map((k) => k.word);
  assert.ok(words.includes('deepseek'), `Expected 'deepseek' in keywords: ${words.join(', ')}`);
  assert.ok(words.includes('webstorm'), `Expected 'webstorm' in keywords: ${words.join(', ')}`);

  for (const word of words) {
    assert.ok(
      allowedVocabulary.has(word),
      `Unexpected encoded fragment "${word}" leaked into top keywords: ${words.join(', ')}`
    );
  }

  const fencedOnly = extractTopKeywords([{ id: 'fenced', content: fencedWrapped76 }], { limit: 15 });
  assert.equal(fencedOnly.length, 0, `Fenced 76-char base64 should produce 0 keywords, got: ${fencedOnly.map((k) => k.word).join(', ')}`);

  const pemOnly = extractTopKeywords([{ id: 'pem', content: pemWrapped64 }], { limit: 15 });
  for (const { word } of pemOnly) {
    assert.ok(['begin', 'end', 'certificate'].includes(word), `PEM-only content leaked fragment "${word}"`);
  }
});

test('extractTopKeywords keeps legitimate slash and env terms next to a fenced base64 blob', () => {
  const deterministicBytes = Buffer.alloc(1500);
  for (let i = 0; i < deterministicBytes.length; i++) {
    deterministicBytes[i] = (i * 73 + 41) ^ ((i >>> 2) * 19);
  }
  const wrapped = deterministicBytes.toString('base64').match(/.{1,76}/g).join('\n');

  const keywords = extractTopKeywords(
    [
      { id: 'config', content: `Setup:\n\`\`\`\nLLM_PROVIDER=deepseek\nIntelliJ/PyCharm\n\`\`\`` },
      { id: 'blob', content: `Payload:\n\`\`\`\n${wrapped}\n\`\`\`` },
      { id: 'hyphen', content: 'github-copilot-integration' },
    ],
    { limit: 20 }
  );
  const words = new Set(keywords.map(({ word }) => word));

  for (const expected of ['llm_provider', 'deepseek', 'intellij', 'pycharm', 'github-copilot-integration']) {
    assert.ok(words.has(expected), `Expected legitimate term "${expected}" to be kept; got: ${[...words].join(', ')}`);
  }
});

test('matchMasterSectionHeading and generateServerSupportReport preserve deeper ### subheadings under ## top-level sections', async () => {
  const lines = [
    '## 1. Executive Summary',
    '### 1. Installation problems',
    '## 2. Forum & Q&A',
    '### 2. API key setup',
    '### Forum Q&A digest for #support',
    '### General Chat: #chat details',
  ];
  assert.equal(matchMasterSectionHeading(lines[0], 2), 1);
  assert.equal(matchMasterSectionHeading(lines[1], 2), null);
  assert.equal(matchMasterSectionHeading(lines[2], 2), 2);
  assert.equal(matchMasterSectionHeading(lines[3], 2), null);
  assert.equal(matchMasterSectionHeading(lines[4], 2), null);
  assert.equal(matchMasterSectionHeading(lines[5], 2), null);

  // Full integration check: ## top-level master sections with nested ### numbered and title-like subheadings in Section 2 & Section 5
  const reportResult = await generateServerSupportReport(
    {
      guildId: 'guild-subheadings',
      guildName: 'Subheading Test Server',
      lookbackDays: 90,
      channels: [
        {
          channelId: '222',
          channelName: '🆘-support',
          categoryName: 'Support',
          channelType: 'forum',
          posts: [
            {
              postId: 'p-1',
              title: 'How to configure DeepSeek API key?',
              author: 'bob',
              starterQuestion: 'How do I set up the DeepSeek API key?',
              createdAt: '2026-10-10T10:00:00Z',
              replyCount: 1,
              answered: true,
              tags: ['Solved'],
              messages: [
                {
                  id: 'p-1',
                  author: 'bob',
                  content: '[Forum Post: "How to configure DeepSeek API key?"] How do I set up the DeepSeek API key?',
                  timestamp: '2026-10-10T10:00:00Z',
                },
                {
                  id: 'p-2',
                  author: 'helper',
                  content: 'Set DEEPSEEK_API_KEY in your .env file.',
                  timestamp: '2026-10-10T10:05:00Z',
                },
              ],
            },
          ],
          messages: [
            {
              id: 'p-1',
              author: 'bob',
              content: '[Forum Post: "How to configure DeepSeek API key?"] How do I set up the DeepSeek API key?',
              timestamp: '2026-10-10T10:00:00Z',
            },
            {
              id: 'p-2',
              author: 'helper',
              content: 'Set DEEPSEEK_API_KEY in your .env file.',
              timestamp: '2026-10-10T10:05:00Z',
            },
          ],
        },
        {
          channelId: '111',
          channelName: '💬-chat',
          categoryName: 'Community',
          channelType: 'chat',
          messages: [
            {
              id: 'c-1',
              author: 'alice',
              content: 'Discussing WebStorm and DeepSeek workflows.',
              timestamp: '2026-10-11T10:00:00Z',
            },
          ],
        },
      ],
    },
    {
      reportOutputPath: null,
      channelReportsDir: null,
      llmConfig: {
        provider: 'deepseek',
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
      },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        const sys = body.messages[0].content;
        if (sys.includes('Executive 3-Month')) {
          return {
            ok: true,
            json: async () => ({
              choices: [
                {
                  message: {
                    content: [
                      '## 1. Executive Summary',
                      'EXEC_SUMMARY_MARKER',
                      '',
                      '## 2. Forum & Q&A Channels — Most Frequent Questions & Common Doubts (FAQ)',
                      '### 1. Installation problems',
                      'SEC2_SUB1_MARKER',
                      '### 2. API key setup',
                      'SEC2_SUB2_MARKER',
                      '',
                      '## 3. General Chat Channels — Main Discussion Topics & Community Vibe',
                      'SEC3_CHAT_MARKER',
                      '',
                      '## 4. Most Frequently Used Keywords & Technical Terms (Server-wide & Per-Channel)',
                      'SEC4_KW_MARKER',
                      '',
                      '## 5. Channel-by-Channel Breakdown',
                      '### Forum Q&A digest for #support',
                      'FORUMQA_SUB_BREAK',
                      '### General Chat: #chat details',
                      'GENCHAT_SUB_BREAK',
                      '',
                      '## 6. Meeting Talking Points & Action Items',
                      'SEC6_CONTRIB_MARKER',
                    ].join('\n'),
                  },
                },
              ],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'Channel LLM digest.' } }],
          }),
        };
      },
    }
  );

  const md = reportResult.markdownReport;
  const posSec2 = md.indexOf('## 2. Forum & Q&A Channels');
  const posSec2Sub1 = md.indexOf('SEC2_SUB1_MARKER');
  const posSec2Sub2 = md.indexOf('SEC2_SUB2_MARKER');
  const posDetFaq = md.indexOf('#### Deterministic Forum & Q&A Resolution Breakdown (Authoritative)');
  const posSec3 = md.indexOf('## 3. General Chat Channels');
  const posSec4 = md.indexOf('## 4. Most Frequently Used Keywords');
  const posDetKw = md.indexOf('#### Server-Wide Top Keywords (In-Window Exact Counts)');
  const posSec5 = md.indexOf('## 5. Channel-by-Channel Breakdown');
  const posForumSub5 = md.indexOf('FORUMQA_SUB_BREAK');
  const posChatSub5 = md.indexOf('GENCHAT_SUB_BREAK');
  const posSec6 = md.indexOf('## 6. Meeting Talking Points & Action Items');

  assert.ok(posSec2 > 0 && posSec2Sub1 > posSec2 && posSec2Sub2 > posSec2Sub1 && posDetFaq > posSec2Sub2 && posDetFaq < posSec3, 'Section 2 numbered subheadings and deterministic FAQ block must stay inside Section 2');
  assert.ok(posSec4 > posSec3 && posDetKw > posSec4 && posDetKw < posSec5, 'Deterministic keyword tables must stay inside Section 4');
  assert.ok(
    posSec5 > posDetKw &&
      posForumSub5 > posSec5 &&
      posChatSub5 > posForumSub5 &&
      posChatSub5 < posSec6,
    'Section 5 subheadings ("### Forum Q&A digest..." and "### General Chat...") must stay inside Section 5 and not be moved to Sections 2 or 3'
  );
});

test('Step 5: bounds 4,186-char verbose EAP licensing topic block and overall Channel Digest across single-chunk, multi-chunk, local fallback, and master reports without mid-word truncation', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'discord-step5-brevity-'));

  try {
    // Construct a 4,186+ char "EAP licensing, quota, credits, and top-up policy" topic block
    const eapSubBullets = [
      '  - Users confirmed that the EAP licensing quota resets monthly on the billing cycle date, while paid JetBrains AI Pro credits apply after the included tier is exhausted.',
      '  - Community uncertainty remains around whether unused top-up credits roll over across billing cycles or expire after 30 days on enterprise seats.',
      '  - Several developers compared token consumption between multi-file refactoring sessions in IntelliJ IDEA and smaller single-file prompts in WebStorm.',
      '  - Additional lengthy elaboration on historical EAP quota tiers, credit burn rates during automated test execution, and legacy trial extensions that inflates the section unnecessarily. '.repeat(
        18
      ),
      '  - Further redundant commentary repeating every single sub-point about top-up billing dialogs, IDE status bar indicators, and quota warning thresholds in minor releases. '.repeat(
        15
      ),
    ];
    const eapTopicBlock = [
      '### EAP licensing, quota, credits, and top-up policy',
      '- Comprehensive breakdown of EAP licensing rules, monthly quota allocation, credit consumption, and top-up policy decisions across JetBrains IDEs:',
      ...eapSubBullets,
    ].join('\n');

    assert.ok(
      eapTopicBlock.length >= 4186,
      `Expected simulated EAP block to be >= 4186 chars (got ${eapTopicBlock.length})`
    );

    const verboseDigestReply = [
      '**Chat Overview & Community Vibe**',
      'Active technical discussion focused on EAP licensing quotas, WSL2 Docker integration, and DeepSeek CLI workflows. ' +
        'Extra filler sentence repeating general community enthusiasm and day-by-day chatter logs across multiple time zones. '.repeat(
          6
        ),
      '',
      '**Main Discussion Topics**',
      eapTopicBlock,
      '',
      '### WSL2 Docker and JetBrains Gateway setup',
      '- Developers confirmed that enabling the WSLg socket in Docker Desktop resolves connection timeouts in IntelliJ IDEA.',
      '- A remaining open question is whether custom SSH proxy jumps require manual port forwarding in Gateway 2026.2.',
      '- Redundant third bullet with excessive repetition of standard Docker installation steps on Windows 11. '.repeat(
        6
      ),
      '',
      '**Top Keywords & Trending Terms**',
      '- `junie` (12 in 8 msgs), `deepseek` (9 in 7 msgs), and `quota` (7 in 6 msgs) dominated technical threads.',
      '',
      '**Notable Highlights & Shared Ideas**',
      '- Separating Phase 1 Discord export from Phase 2 DeepSeek report generation allows fast offline iteration.',
      '- Teams recommended documenting EAP quota reset rules in the ambassador onboarding FAQ.',
      '- Third extra highlight bullet that should be trimmed by the 2-bullet per topic cap.',
    ].join('\n');

    // 1. Direct unit check on enforceConciseDigest
    const bounded = enforceConciseDigest(verboseDigestReply);
    assert.ok(
      bounded.length <= 2000,
      `Expected total digest length <= 2000 chars, got ${bounded.length}`
    );

    // Extract the EAP licensing section from bounded output and verify its per-topic budget
    const eapHeadingIdx = bounded.indexOf('### EAP licensing, quota, credits, and top-up policy');
    const nextHeadingIdx = bounded.indexOf('### WSL2 Docker and JetBrains Gateway setup');
    assert.ok(eapHeadingIdx >= 0, 'EAP topic heading must be preserved');
    assert.ok(nextHeadingIdx > eapHeadingIdx, 'Subsequent topic heading must be preserved');

    const boundedEapSection = bounded.slice(eapHeadingIdx, nextHeadingIdx).trim();
    assert.ok(
      boundedEapSection.length <= 450,
      `Expected bounded EAP topic block <= 450 chars (was ${eapTopicBlock.length}), got ${boundedEapSection.length}`
    );
    const eapBulletLines = boundedEapSection
      .split('\n')
      .slice(1)
      .filter((l) => /^\s*[-*•]/.test(l));
    assert.ok(
      eapBulletLines.length <= 2,
      `Expected at most 2 bullets in EAP topic block, got ${eapBulletLines.length}`
    );

    // Key facts/decisions/uncertainty must remain present
    assert.match(bounded, /EAP licensing/i);
    assert.match(bounded, /quota|credits|top-up/i);
    assert.match(bounded, /WSLg socket|Docker/i);

    // Verify no ugly mid-word truncation (every non-heading line ends cleanly with punctuation, ellipsis, or markdown marker)
    for (const line of bounded.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('**')) continue;
      assert.match(
        t,
        /(?:[.!?:)`*_]|(?:\.\.\.))$/,
        `Line appears truncated mid-word: "${t}"`
      );
    }

    // 2. Verify single-chunk and multi-chunk channels + Master Report enforcement
    const chatMessages = Array.from({ length: 6 }, (_, i) => ({
      id: `m-chat-${i + 1}`,
      author: `dev_user_${i + 1}`,
      content: `Discussing Junie EAP licensing quota, credits, top-up policy, and DeepSeek WSL2 Docker setup (${i + 1}).`,
      timestamp: new Date(Date.UTC(2026, 9, 10, 10, i)).toISOString(),
    }));

    // Single-chunk channel (chunkSize = 20 -> 1 chunk)
    const singleChunkDigest = await summarizeChannelHistory(
      {
        channelId: 'ch-single',
        channelName: 'junie',
        categoryName: 'Product',
        channelType: 'chat',
        messages: chatMessages,
      },
      {
        chunkSize: 20,
        llmConfig: {
          provider: 'deepseek',
          apiKey: 'sk-test',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
        },
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: verboseDigestReply } }],
          }),
        }),
      }
    );

    assert.equal(singleChunkDigest.chunkCount, 1);
    assert.ok(
      singleChunkDigest.summary.length <= 2000,
      `Single-chunk digest must be <= 2000 chars (got ${singleChunkDigest.summary.length})`
    );

    // Multi-chunk channel (chunkSize = 2 with chunkForumPosts or direct summarizeChannelHistory)
    const multiForumPosts = Array.from({ length: 4 }, (_, i) => ({
      postId: `fp-${i + 1}`,
      title: `EAP quota question #${i + 1}`,
      author: `asker_${i + 1}`,
      createdAt: new Date(Date.UTC(2026, 9, 12, 10, i)).toISOString(),
      starterQuestion: `How does EAP quota and top-up credit billing work in case #${i + 1}?`,
      replyCount: 1,
      answered: true,
      confirmed: i % 2 === 0,
      messages: [
        {
          id: `fp-${i + 1}`,
          author: `asker_${i + 1}`,
          content: `[Forum Post: "EAP quota question #${i + 1}"] How does EAP quota and top-up credit billing work in case #${i + 1}?`,
          timestamp: new Date(Date.UTC(2026, 9, 12, 10, i)).toISOString(),
        },
        {
          id: `fp-r-${i + 1}`,
          author: `helper_${i + 1}`,
          content: `Quota resets monthly and top-up credits apply after base quota is used.`,
          timestamp: new Date(Date.UTC(2026, 9, 12, 11, i)).toISOString(),
        },
      ],
    }));

    const multiChunkDigest = await summarizeChannelHistory(
      {
        channelId: 'ch-multi',
        channelName: '🆘-support',
        categoryName: 'Support',
        channelType: 'forum',
        posts: multiForumPosts,
        messages: multiForumPosts.flatMap((p) => p.messages),
      },
      {
        chunkSize: 2, // forces 4 chunks + hierarchical consolidation
        llmConfig: {
          provider: 'deepseek',
          apiKey: 'sk-test',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
        },
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: verboseDigestReply } }],
          }),
        }),
      }
    );

    assert.ok(multiChunkDigest.chunkCount > 1);
    assert.ok(
      multiChunkDigest.summary.length <= 2000,
      `Multi-chunk consolidated digest must be <= 2000 chars (got ${multiChunkDigest.summary.length})`
    );
    // Deterministic Q&A metrics remain intact and separate
    assert.equal(multiChunkDigest.qaStats.totalQuestions, 4);
    assert.equal(multiChunkDigest.qaStats.confirmedCount, 2);
    assert.equal(multiChunkDigest.qaStats.heuristicAnsweredCount, 2);

    // Master report generation with verbose LLM responses
    const masterOutPath = path.join(tmpDir, 'reports', 'support-report-3months.md');
    const reportRes = await generateServerSupportReport(
      {
        guildId: 'g-verbose',
        guildName: 'Verbose Digest Test Server',
        lookbackDays: 90,
        channels: [
          {
            channelId: 'ch-single',
            channelName: 'junie',
            categoryName: 'Product',
            channelType: 'chat',
            messages: chatMessages,
          },
          {
            channelId: 'ch-multi',
            channelName: '🆘-support',
            categoryName: 'Support',
            channelType: 'forum',
            posts: multiForumPosts,
            messages: multiForumPosts.flatMap((p) => p.messages),
          },
        ],
      },
      {
        chunkSize: 20,
        reportOutputPath: masterOutPath,
        llmConfig: {
          provider: 'deepseek',
          apiKey: 'sk-test',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
        },
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: verboseDigestReply } }],
          }),
        }),
      }
    );

    const junieChannelMd = readFileSync(
      path.join(tmpDir, 'reports', 'channels', 'junie.md'),
      'utf8'
    );
    const digestStart = junieChannelMd.indexOf('## Channel Digest');
    const keywordsStart = junieChannelMd.indexOf('## Top Keywords');
    const channelDigestSection = junieChannelMd
      .slice(digestStart + '## Channel Digest'.length, keywordsStart)
      .trim();
    assert.ok(
      channelDigestSection.length <= 2000,
      `Saved per-channel ## Channel Digest must be <= 2000 chars (got ${channelDigestSection.length})`
    );
    assert.ok(reportRes.markdownReport.includes('### 1. Executive Summary'));
    assert.ok(reportRes.markdownReport.includes('### 6. Meeting Talking Points & Action Items'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Step 5: redacts participant usernames and @handles from prompts, local fallback, per-channel reports, and master reports while preserving raw exported JSON and technical/product terms', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'discord-step5-privacy-'));

  try {
    const distinctiveHandles = [
      'zephyr_lead_77',
      'quasar_qa_42',
      'nebula_support_99',
      'vortex_asker_11',
      'junie_fan_88',
      'echoed_phantom_handle',
    ];

    const exportBundle = {
      guildId: 'g-privacy-1',
      guildName: 'JetBrains Junie Community Server',
      lookbackDays: 90,
      channels: [
        {
          channelId: 'c-chat-1',
          channelName: '💬-chat',
          categoryName: 'Community',
          channelType: 'chat',
          messages: [
            {
              id: 'm-1',
              author: 'zephyr_lead_77',
              content:
                'Hi @quasar_qa_42! Testing JetBrains Junie with DeepSeek (deepseek-flash and deepseek-chat) inside WebStorm and IntelliJ IDEA on Windows 11.',
              timestamp: '2026-10-10T10:00:00.000Z',
            },
            {
              id: 'm-2',
              author: 'quasar_qa_42',
              content:
                'Thanks @zephyr_lead_77 and <@987654321>! PyCharm and PostgreSQL 17 migrations with TypeScript and Docker in WSL2 work great.',
              timestamp: '2026-10-10T10:05:00.000Z',
            },
            {
              id: 'm-3',
              author: 'junie_fan_88',
              content:
                'We also verified EAP licensing quota and DEEPSEEK_API_KEY configuration in .env with @zephyr_lead_77.',
              timestamp: '2026-10-10T10:10:00.000Z',
            },
          ],
        },
        {
          channelId: 'c-forum-2',
          channelName: '🆘-support',
          categoryName: 'Support',
          channelType: 'forum',
          posts: [
            {
              postId: 'p-priv-1',
              title: 'How to configure DEEPSEEK_API_KEY and LLM_PROVIDER in WebStorm?',
              author: 'vortex_asker_11',
              createdAt: '2026-10-11T09:00:00.000Z',
              starterQuestion:
                'Hi @nebula_support_99, how do I set DEEPSEEK_API_KEY and LLM_PROVIDER=deepseek for Junie CLI?',
              replyCount: 2,
              answered: true,
              confirmed: true,
              tags: ['Solved', 'deepseek'],
              messages: [
                {
                  id: 'p-priv-1',
                  author: 'vortex_asker_11',
                  content:
                    '[Forum Post: "How to configure DEEPSEEK_API_KEY and LLM_PROVIDER in WebStorm?"] Hi @nebula_support_99, how do I set DEEPSEEK_API_KEY and LLM_PROVIDER=deepseek for Junie CLI?',
                  timestamp: '2026-10-11T09:00:00.000Z',
                },
                {
                  id: 'p-priv-r1',
                  author: 'nebula_support_99',
                  content:
                    'Hi @vortex_asker_11! Add LLM_PROVIDER=deepseek and DEEPSEEK_API_KEY in your .env file.',
                  timestamp: '2026-10-11T09:10:00.000Z',
                },
                {
                  id: 'p-priv-r2',
                  author: 'vortex_asker_11',
                  content: 'That fixed it immediately, thank you @nebula_support_99!',
                  timestamp: '2026-10-11T09:20:00.000Z',
                },
              ],
            },
          ],
          messages: [
            {
              id: 'p-priv-1',
              author: 'vortex_asker_11',
              content:
                '[Forum Post: "How to configure DEEPSEEK_API_KEY and LLM_PROVIDER in WebStorm?"] Hi @nebula_support_99, how do I set DEEPSEEK_API_KEY and LLM_PROVIDER=deepseek for Junie CLI?',
              timestamp: '2026-10-11T09:00:00.000Z',
            },
            {
              id: 'p-priv-r1',
              author: 'nebula_support_99',
              content:
                'Hi @vortex_asker_11! Add LLM_PROVIDER=deepseek and DEEPSEEK_API_KEY in your .env file.',
              timestamp: '2026-10-11T09:10:00.000Z',
            },
            {
              id: 'p-priv-r2',
              author: 'vortex_asker_11',
              content: 'That fixed it immediately, thank you @nebula_support_99!',
              timestamp: '2026-10-11T09:20:00.000Z',
            },
          ],
        },
      ],
    };

    // Snapshot raw exportBundle before running reports to verify raw JSON fidelity
    const rawSnapshotBefore = JSON.stringify(exportBundle);

    // 1. Test LLM mode where mocked LLM echoes participant names, @handles, "asked by", and "Key Contributors"
    const capturedLlmPrompts = [];
    const llmReportPath = path.join(tmpDir, 'llm-reports', 'support-report-3months.md');
    const llmChannelDir = path.join(tmpDir, 'llm-reports', 'channels');

    await generateServerSupportReport(exportBundle, {
      reportOutputPath: llmReportPath,
      channelReportsDir: llmChannelDir,
      llmConfig: {
        provider: 'deepseek',
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
      },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        capturedLlmPrompts.push(body.messages[1].content);
        const sys = body.messages[0].content;
        if (sys.includes('Executive 3-Month')) {
          return {
            ok: true,
            json: async () => ({
              choices: [
                {
                  message: {
                    content: [
                      '### 1. Executive Summary',
                      'zephyr_lead_77 and @quasar_qa_42 led discussions on JetBrains Junie, DeepSeek, WebStorm, and IntelliJ IDEA.',
                      '',
                      '### 2. Forum & Q&A Channels — Most Frequent Questions & Common Doubts (FAQ)',
                      '- **DEEPSEEK_API_KEY setup** (asked by **vortex_asker_11**): Confirmed fix provided by @nebula_support_99 using LLM_PROVIDER=deepseek in .env.',
                      '',
                      '### 3. General Chat Channels — Main Discussion Topics & Community Vibe',
                      '- **zephyr_lead_77**: Shared PyCharm, PostgreSQL 17, TypeScript, and WSL2 Docker workflows with junie_fan_88 and @echoed_phantom_handle.',
                      '',
                      '### 4. Most Frequently Used Keywords & Technical Terms (Server-wide & Per-Channel)',
                      '- Top terms include `deepseek`, `junie`, and `webstorm`.',
                      '',
                      '### 5. Channel-by-Channel Breakdown',
                      '- **#💬-chat**: Active discussion on EAP licensing quota.',
                      '- **#🆘-support**: Resolved configuration thread.',
                      '',
                      '### 6. Key Contributors & Meeting Talking Points',
                      '- **Top Active Contributors (In-Window)**: **zephyr_lead_77** (5 msgs), **nebula_support_99** (3 msgs)',
                      '- Document EAP licensing quota rules and DEEPSEEK_API_KEY fallback behavior for the next meeting.',
                    ].join('\n'),
                  },
                },
              ],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: [
                    '**Main Discussion Topics**',
                    '- **JetBrains IDE & DeepSeek Workflows**: @zephyr_lead_77 and quasar_qa_42 tested Junie in WebStorm, IntelliJ IDEA, and PyCharm with PostgreSQL 17 and WSL2 Docker.',
                    '- **Configuration & EAP Quota** (asked by **vortex_asker_11**): nebula_support_99 and junie_fan_88 confirmed setting DEEPSEEK_API_KEY and LLM_PROVIDER=deepseek in .env.',
                  ].join('\n'),
                },
              },
            ],
          }),
        };
      },
    });

    // Raw export bundle must remain 100% unchanged for data fidelity
    assert.equal(JSON.stringify(exportBundle), rawSnapshotBefore);
    assert.equal(exportBundle.channels[0].messages[0].author, 'zephyr_lead_77');
    assert.equal(exportBundle.channels[1].posts[0].author, 'vortex_asker_11');

    // Prompts sent to DeepSeek must NOT contain participant usernames or contributor rosters
    const allPromptsText = capturedLlmPrompts.join('\n');
    for (const handle of distinctiveHandles) {
      assert.equal(
        allPromptsText.includes(handle),
        false,
        `Prompt sent to DeepSeek must not contain participant handle "${handle}"`
      );
    }
    assert.doesNotMatch(allPromptsText, /Top Contributors Overall:/i);
    assert.doesNotMatch(allPromptsText, /Author:\s+vortex_asker_11/i);

    // Saved LLM reports (master + per-channel) must contain ZERO handles and preserve technical/product terms
    const savedLlmMaster = readFileSync(llmReportPath, 'utf8');
    const savedLlmChat = readFileSync(path.join(llmChannelDir, 'chat.md'), 'utf8');
    const savedLlmSupport = readFileSync(path.join(llmChannelDir, 'support.md'), 'utf8');

    for (const [label, content] of [
      ['LLM Master Report', savedLlmMaster],
      ['LLM Chat Channel Report', savedLlmChat],
      ['LLM Support Channel Report', savedLlmSupport],
    ]) {
      for (const handle of distinctiveHandles) {
        assert.equal(
          content.includes(handle),
          false,
          `${label} must not contain participant handle "${handle}"`
        );
      }
      assert.doesNotMatch(content, /Key Contributors|Top Contributors|Top Active Contributors|asked by/i);
    }

    // Technical, product, and company names must remain intact in saved reports
    for (const term of [
      'JetBrains',
      'Junie',
      'DeepSeek',
      'WebStorm',
      'IntelliJ IDEA',
      'PyCharm',
      'PostgreSQL 17',
      'WSL2',
      'Docker',
      'DEEPSEEK_API_KEY',
      'LLM_PROVIDER',
    ]) {
      assert.equal(
        savedLlmMaster.includes(term),
        true,
        `LLM Master Report must preserve legitimate technical/product term "${term}"`
      );
    }

    // 2. Test local fallback mode on the same dataset
    const fallbackReportPath = path.join(tmpDir, 'fallback-reports', 'support-report-3months.md');
    const fallbackChannelDir = path.join(tmpDir, 'fallback-reports', 'channels');

    await generateServerSupportReport(exportBundle, {
      reportOutputPath: fallbackReportPath,
      channelReportsDir: fallbackChannelDir,
      llmConfig: {
        provider: 'fallback',
        apiKey: '',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
      },
    });

    const savedFallbackMaster = readFileSync(fallbackReportPath, 'utf8');
    const savedFallbackChat = readFileSync(path.join(fallbackChannelDir, 'chat.md'), 'utf8');
    const savedFallbackSupport = readFileSync(path.join(fallbackChannelDir, 'support.md'), 'utf8');

    for (const [label, content] of [
      ['Fallback Master Report', savedFallbackMaster],
      ['Fallback Chat Channel Report', savedFallbackChat],
      ['Fallback Support Channel Report', savedFallbackSupport],
    ]) {
      for (const handle of distinctiveHandles) {
        assert.equal(
          content.includes(handle),
          false,
          `${label} must not contain participant handle "${handle}"`
        );
      }
      assert.doesNotMatch(content, /Key Contributors|Top Contributors|Top Active Contributors|asked by/i);
    }

    for (const term of ['JetBrains', 'Junie', 'DeepSeek', 'WebStorm', 'DEEPSEEK_API_KEY']) {
      assert.equal(
        savedFallbackMaster.includes(term),
        true,
        `Fallback Master Report must preserve legitimate technical/product term "${term}"`
      );
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Step 5 regressions: preserves all 8 topics when within budget, recompresses or notes omitted topics when over budget, protects @scope/pkg, @Override, **LLM_PROVIDER**:, parentheticals, common-word display names, tables, and code fences', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'discord-step5-regressions-'));

  try {
    // 1. A compliant ~1,717-char digest with 8 topics (~210 chars each) must keep ALL 8 topics
    const eightTopicLines = [
      '**Main Discussion Topics**',
      ...Array.from({ length: 8 }, (_, idx) => {
        const n = idx + 1;
        return `- **Topic ${n} Architecture & Quota Policy**: Developers verified that subsystem ${n} handles EAP token limits, monthly billing resets, and fallback routing cleanly across JetBrains IDEs without any regressions.`;
      }),
    ];
    const compliantEightTopicDigest = eightTopicLines.join('\n');
    assert.ok(
      compliantEightTopicDigest.length >= 1650 && compliantEightTopicDigest.length <= 1950,
      `Expected compliant 8-topic input around 1,717 chars, got ${compliantEightTopicDigest.length}`
    );

    const boundedCompliant = enforceConciseDigest(compliantEightTopicDigest);
    for (let n = 1; n <= 8; n++) {
      assert.equal(
        boundedCompliant.includes(`Topic ${n} Architecture & Quota Policy`),
        true,
        `Topic ${n} was dropped even though the 8-topic digest (${compliantEightTopicDigest.length} chars) was within the 2,000-char budget`
      );
    }
    assert.doesNotMatch(boundedCompliant, /omitted for brevity/i);

    // 2. When topics exceed an explicit topic limit or tight total budget, a transparent "...and N more topics omitted for brevity." note is added
    const explicitCapDigest = enforceConciseDigest(compliantEightTopicDigest, {
      maxTopicsPerSection: 4,
    });
    assert.match(explicitCapDigest, /\.\.\.and 4 more topics omitted for brevity\./i);

    const twelveVerboseTopics = [
      '**Main Discussion Topics**',
      ...Array.from({ length: 12 }, (_, idx) => {
        const n = idx + 1;
        return `- **Topic ${n} Detailed Subsystem Investigation**: ${'Developers analyzed configuration flags, memory allocation, and retry backoff across multiple IDE builds. '.repeat(4).trim()}`;
      }),
    ].join('\n');
    const boundedTwelve = enforceConciseDigest(twelveVerboseTopics, { maxTotalChars: 1200 });
    assert.ok(boundedTwelve.length <= 1200, `Expected <= 1200 chars, got ${boundedTwelve.length}`);
    assert.match(boundedTwelve, /\.\.\.and \d+ more topics? omitted for brevity\./i);

    // 2b. Content-aware LLM recompression: when initial LLM response is >2000 chars and recompression call returns a compliant 8-topic digest, all 8 topics are preserved
    let recompressCalls = 0;
    const recompressedChannelDigest = await summarizeChannelHistory(
      {
        channelId: 'ch-recompress',
        channelName: 'junie',
        categoryName: 'Product',
        channelType: 'chat',
        messages: [
          {
            id: 'm-rec-1',
            author: 'zephyr_lead_77',
            content: 'Discussing all 8 architecture topics in detail.',
            timestamp: '2026-10-12T10:00:00.000Z',
          },
        ],
      },
      {
        chunkSize: 20,
        llmConfig: {
          provider: 'deepseek',
          apiKey: 'sk-test',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
        },
        fetchImpl: async () => {
          recompressCalls++;
          const reply = recompressCalls === 1 ? twelveVerboseTopics : compliantEightTopicDigest;
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: reply } }],
            }),
          };
        },
      }
    );
    assert.equal(recompressCalls, 2, 'Should invoke LLM recompression pass when initial digest exceeds 2,000 chars');
    for (let n = 1; n <= 8; n++) {
      assert.equal(
        recompressedChannelDigest.summary.includes(`Topic ${n} Architecture & Quota Policy`),
        true,
        `Recompressed digest must preserve Topic ${n}`
      );
    }

    // 3. Name redaction edge cases: @types/node, @angular/core, @Override, **LLM_PROVIDER**:, (by default), (shared memory), (created by JetBrains), "The Code Wizard", and "mark"
    const edgeMessages = [
      {
        id: 'e-1',
        author: 'The Code Wizard',
        content:
          'Hi @mark and @zephyr_lead_77! Install @types/node and @angular/core, add @Override on the method, and use the code formatter (by default) with (shared memory) in WebStorm (created by JetBrains).',
        timestamp: '2026-10-12T11:00:00.000Z',
      },
      {
        id: 'e-2',
        author: 'mark',
        content:
          'Mark the thread as solved once @types/node and LLM_PROVIDER are configured with the code formatter.',
        timestamp: '2026-10-12T11:05:00.000Z',
      },
    ];

    const collected = collectKnownAuthors(edgeMessages);
    // Must NOT split "The Code Wizard" into "Code" or "Wizard", nor collect "type"/"types"/"angula"/"angular"/"Override"
    for (const forbidden of ['Code', 'code', 'Wizard', 'wizard', 'type', 'types', 'angula', 'angular', 'Override', 'override']) {
      assert.equal(
        collected.includes(forbidden),
        false,
        `collectKnownAuthors must not collect "${forbidden}" as an author (got: ${collected.join(', ')})`
      );
    }
    assert.equal(collected.includes('The Code Wizard'), true);
    assert.equal(collected.includes('zephyr_lead_77'), true);

    const trickySampleText = [
      '- **LLM_PROVIDER**: set it to `deepseek` (by default) in `.env`.',
      '- **DEEPSEEK_API_KEY**: required for authentication (shared memory) in Junie (created by JetBrains).',
      '- **zephyr_lead_77**: The Code Wizard and @mark tested `@types/node`, `@angular/core`, and `@Override` annotations (asked by **mark**).',
      '- Always use the code formatter and Mark the thread as solved when type checking passes.',
    ].join('\n');

    const redactedTricky = redactParticipantNames(trickySampleText, collected);
    assert.match(redactedTricky, /- \*\*LLM_PROVIDER\*\*: set it to `deepseek` \(by default\) in `\.env`\./);
    assert.match(redactedTricky, /- \*\*DEEPSEEK_API_KEY\*\*: required for authentication \(shared memory\) in Junie \(created by JetBrains\)\./);
    assert.equal(redactedTricky.includes('@types/node'), true, 'Must preserve @types/node intact');
    assert.equal(redactedTricky.includes('@angular/core'), true, 'Must preserve @angular/core intact');
    assert.equal(redactedTricky.includes('@Override'), true, 'Must preserve @Override annotation intact');
    assert.equal(redactedTricky.includes('use the code formatter'), true, 'Must not corrupt "code" into "a user"');
    assert.equal(redactedTricky.includes('Mark the thread as solved'), true, 'Must not corrupt "Mark" into "A user"');
    assert.equal(redactedTricky.includes('type checking passes'), true, 'Must not corrupt "type" into "a user"');
    assert.equal(redactedTricky.includes('zephyr_lead_77'), false, 'Must redact zephyr_lead_77');
    assert.equal(redactedTricky.includes('The Code Wizard'), false, 'Must redact full display name "The Code Wizard"');
    assert.equal(redactedTricky.includes('@mark'), false, 'Must redact @mark mention');
    assert.doesNotMatch(redactedTricky, /asked by/i, 'Must remove (asked by **mark**)');

    // Verify deterministic keyword extraction is not polluted or stripped by "The Code Wizard" or "@types/node"
    const edgeKeywords = extractTopKeywords(edgeMessages, { limit: 15 }).map((k) => k.word);
    assert.equal(edgeKeywords.includes('code'), true, 'Keyword "code" must not be removed by display name "The Code Wizard"');
    assert.equal(edgeKeywords.includes('formatter'), true, 'Keyword "formatter" must be present');

    // 4. Preserve Markdown tables and fenced code blocks in enforceConciseDigest and generateServerSupportReport
    const digestWithTableAndCode = [
      '**Main Discussion Topics**',
      '- **CLI Setup & Dependencies**: Configure `@types/node` and environment variables (by default):',
      '```bash',
      '# Install dependencies',
      'npm install @types/node @angular/core',
      'export LLM_PROVIDER=deepseek',
      '```',
      '',
      '**Top Keywords & Trending Terms**',
      '| Rank | Keyword | Count |',
      '| :--- | :--- | :---: |',
      '| 1 | `deepseek` | 12 |',
      '| 2 | `webstorm` | 8 |',
    ].join('\n');

    const boundedWithTableAndCode = enforceConciseDigest(digestWithTableAndCode, {
      knownAuthors: collected,
    });
    assert.equal(
      boundedWithTableAndCode.includes('```bash\n# Install dependencies\nnpm install @types/node @angular/core\nexport LLM_PROVIDER=deepseek\n```'),
      true,
      `Fenced code block must remain multi-line and intact, got:\n${boundedWithTableAndCode}`
    );
    assert.equal(
      boundedWithTableAndCode.includes('| Rank | Keyword | Count |\n| :--- | :--- | :---: |\n| 1 | `deepseek` | 12 |\n| 2 | `webstorm` | 8 |'),
      true,
      `Markdown table must remain multi-line and intact, got:\n${boundedWithTableAndCode}`
    );

    // Also verify Master Section 4 when the LLM includes its own "#### Per-Channel Keyword Rankings" table
    const masterMdPath = path.join(tmpDir, 'master-table-report.md');
    const masterRes = await generateServerSupportReport(
      {
        guildId: 'g-md-table',
        guildName: 'Markdown Integrity Server',
        lookbackDays: 90,
        channels: [
          {
            channelId: 'ch-md-1',
            channelName: '💬-chat',
            categoryName: 'General',
            channelType: 'chat',
            messages: edgeMessages,
          },
        ],
      },
      {
        reportOutputPath: masterMdPath,
        channelReportsDir: null,
        llmConfig: {
          provider: 'deepseek',
          apiKey: 'sk-test',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
        },
        fetchImpl: async (_url, options) => {
          const body = JSON.parse(options.body);
          const sys = body.messages[0].content;
          if (sys.includes('Executive 3-Month')) {
            return {
              ok: true,
              json: async () => ({
                choices: [
                  {
                    message: {
                      content: [
                        '### 1. Executive Summary',
                        '- Concise overview.',
                        '',
                        '### 2. Forum & Q&A Channels — Most Frequent Questions & Common Doubts (FAQ)',
                        '- No forum channels.',
                        '',
                        '### 3. General Chat Channels — Main Discussion Topics & Community Vibe',
                        '- **LLM_PROVIDER**: configured with `@types/node` and `@Override`.',
                        '```bash',
                        'npm install @types/node',
                        '```',
                        '',
                        '### 4. Most Frequently Used Keywords & Technical Terms (Server-wide & Per-Channel)',
                        '#### Per-Channel Keyword Rankings',
                        '| Channel | Top Keyword | Occurrences |',
                        '| :--- | :--- | :---: |',
                        '| #chat | `code` | 2 |',
                        '',
                        '### 5. Channel-by-Channel Breakdown',
                        '- **#💬-chat**: Active chat.',
                        '',
                        '### 6. Meeting Talking Points & Action Items',
                        '- Follow up on documentation.',
                      ].join('\n'),
                    },
                  },
                ],
              }),
            };
          }
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: digestWithTableAndCode } }],
            }),
          };
        },
      }
    );

    const masterMd = masterRes.markdownReport;
    assert.equal(
      masterMd.includes('| Channel | Top Keyword | Occurrences |\n| :--- | :--- | :---: |\n| #chat | `code` | 2 |'),
      true,
      'LLM table inside Master Section 4 must not be collapsed onto a single line'
    );
    assert.equal(
      masterMd.includes('#### Server-Wide Top Keywords (In-Window Exact Counts)'),
      true,
      'Authoritative deterministic Server-Wide Top Keywords table must still be appended in Section 4'
    );
    assert.equal(
      masterMd.includes('```bash\nnpm install @types/node\n```'),
      true,
      'Fenced bash code block inside Master Section 3 must remain intact'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('Step 5 privacy v3: redacts capitalized single-word display names exactly, handles lowercase common-word names by person context only, normalizes @john. punctuation, and keeps @workspace', () => {
  const messages = [
    { id: 'a1', author: 'Carlos', content: 'Thanks Lucia, restarting WebStorm fixed the crash. Use @workspace to inspect the project.' },
    { id: 'a2', author: 'Max', content: 'Carlos confirmed the EAP quota resets monthly; max tokens is 8000 for Junie.' },
    { id: 'a3', author: 'Lucia', content: 'Ping @john. I increased pixel density and the river pattern in the docs works.' },
    { id: 'a4', author: 'pixel', content: 'Reproduced the pixel density bug on Docker.' },
    { id: 'a5', author: 'river', content: 'river confirmed the pixel density fix works. Use the river pattern for logging.' },
  ];
  const known = collectKnownAuthors(messages);

  // Exact author strings are kept verbatim (original casing), @john. loses its trailing period
  assert.ok(known.includes('Carlos') && known.includes('Max') && known.includes('Lucia'));
  assert.ok(known.includes('john'), 'handle must be captured without trailing punctuation');
  assert.ok(!known.includes('john.'));
  assert.ok(!known.includes('workspace'), '@workspace is a tool token, never a participant');

  const redact = (s) => redactParticipantNames(s, known);

  // Capitalized single-word display names: always redacted (exact, case-sensitive match)
  assert.equal(redact('Thanks Carlos, restarting WebStorm fixed it.'), 'Thanks a user, restarting WebStorm fixed it.');
  assert.doesNotMatch(redact('Max confirmed it. Lucia agreed with Carlos.'), /\b(Max|Lucia|Carlos)\b/);
  assert.match(redact('Carlos\'s workaround helped.'), /^A user's workaround helped\.$/);
  // ...but lowercase common words with the same spelling are never touched
  assert.equal(redact('The max tokens setting is 8000.'), 'The max tokens setting is 8000.');

  // Lowercase common-word names: only clear person contexts
  assert.equal(redact('Increase pixel density in the settings.'), 'Increase pixel density in the settings.');
  assert.equal(redact('Use the river pattern for logging.'), 'Use the river pattern for logging.');
  assert.equal(redact('river confirmed the fix works.'), 'A user confirmed the fix works.');
  assert.equal(redact('Thanks pixel for the report.'), 'Thanks a user for the report.');
  assert.equal(redact('Ping @pixel about it.'), 'Ping a user about it.');

  // @john. keeps the sentence period; unknown tool/annotation tokens are preserved
  assert.equal(redact('Ping @john. Then restart.'), 'Ping a user. Then restart.');
  assert.equal(redact('Thanks @john.'), 'Thanks a user.');
  assert.equal(redact('Use @workspace to inspect, then @Override and @types/node stay.'), 'Use @workspace to inspect, then @Override and @types/node stay.');

  // Keyword counts: strong names are excluded, lowercase common-word names stay countable
  const kw = extractTopKeywords(messages, { limit: 50 });
  const kwWords = kw.map((k) => k.word);
  assert.ok(!kwWords.includes('carlos') && !kwWords.includes('lucia'));
  assert.equal(kw.find((k) => k.word === 'pixel')?.count, 3);
  assert.ok(kwWords.includes('river'));
  assert.ok(kwWords.includes('workspace'), '@workspace is a tool token, not a participant mention');
});

test('Step 5 follow-up preserves Markdown, keeps FAQ hierarchy, protects technical-name authors, and compresses only final channel output', async () => {
  const markdownDigest = [
    '### EAP quota',
    '- **Quota reset**',
    '  - *Doubt*: Does unused credit roll over?',
    '  - *Reply*: Monthly reset is confirmed; unused credits do not roll over.',
    '',
    'A separate paragraph with its own sentence boundary.',
    '',
    '> Quoted guidance stays a blockquote.',
  ].join('\n');
  assert.equal(
    enforceConciseDigest(markdownDigest),
    markdownDigest,
    'an in-budget digest must retain its Markdown byte-for-byte'
  );

  const overBudgetFaq = [
    '**Most Frequent Questions & Common Doubts (FAQ)**',
    '- **EAP quota rollover** [Unanswered]',
    '  - *Doubt*: Does unused EAP quota carry into the following month?',
    '  - *Reply*: The available information confirms a monthly reset but does not confirm rollover.',
    ...Array.from(
      { length: 14 },
      (_, index) =>
        `- **Additional recurring topic ${index + 1}**: ${'Repeated details about setup, configuration, and expected behavior. '.repeat(4)}`
    ),
  ].join('\n');
  const boundedFaq = enforceConciseDigest(overBudgetFaq);
  assert.ok(boundedFaq.length <= 2000);
  assert.match(boundedFaq, /- \*\*EAP quota rollover\*\* \[Unanswered\]/);
  assert.match(boundedFaq, /\n  - \*Doubt\*:/, 'nested doubt must remain indented under its question');
  assert.match(boundedFaq, /\n  - \*Reply\*:/, 'nested reply must remain indented under its question');
  assert.doesNotMatch(boundedFaq, /\n- \*Doubt\*:/, 'nested doubt must not be flattened to a sibling topic');
  assert.doesNotMatch(boundedFaq, /\n- \*Reply\*:/, 'nested reply must not be flattened to a sibling topic');

  const techAuthorMessages = [
    { id: 'rust-author', author: 'Rust', content: 'Rust and Java support in Junie; Rust plugin setup.' },
    { id: 'java-author', author: 'Java', content: 'Java confirmed the Kotlin compiler workflow.' },
    { id: 'kotlin-author', author: 'Kotlin', content: 'Thanks river and pixel for testing.' },
    { id: 'river-author', author: 'river', content: 'Increase pixel density; keep the river pattern.' },
    { id: 'pixel-author', author: 'pixel', content: 'Rust Java Kotlin technical terms remain useful.' },
    { id: 'mark-author', author: 'mark', content: 'Mark the thread as solved.' },
    { id: 'carlos-author', author: 'Carlos', content: 'Carlos reviewed the fix.' },
  ];
  const knownTechAndWeak = collectKnownAuthors(techAuthorMessages);
  const redactedTechText = redactParticipantNames(
    [
      'Rust and Java support in Junie.',
      '## Rust plugin',
      '- **Kotlin compiler**: retain the documented behavior.',
      'Rust confirmed the workaround.',
      'Thanks river and pixel for testing.',
      'Thank Rust and Java.',
      'Thank river and pixel.',
      'Thanks, river.',
      'Shoutout to river!',
      'Kudos to pixel!',
      'Rust and Java confirmed the fix.',
      'river, pixel and Carlos reported it.',
      'Ask Rust about the setup.',
      'Ping Java about it.',
      '**Rust:** check the config.',
      '> Rust: quoted note.',
      '- **mark**: restart the IDE.',
      'Increase pixel density and preserve the river pattern.',
    ].join('\n'),
    knownTechAndWeak
  );
  assert.match(redactedTechText, /Rust and Java support in Junie/);
  assert.match(redactedTechText, /## Rust plugin/);
  assert.match(redactedTechText, /\*\*Kotlin compiler\*\*/);
  assert.doesNotMatch(redactedTechText, /Rust confirmed/);
  assert.match(redactedTechText, /Thanks participants for testing/);
  assert.match(redactedTechText, /Thank participants\./);
  assert.match(redactedTechText, /Thanks, a user\./);
  assert.match(redactedTechText, /Shoutout to a user!/);
  assert.match(redactedTechText, /Kudos to a user!/);
  assert.match(redactedTechText, /Participants confirmed the fix\./);
  assert.match(redactedTechText, /Participants reported it\./);
  assert.match(redactedTechText, /Ask a user about the setup\./);
  assert.match(redactedTechText, /Ping a user about it\./);
  assert.doesNotMatch(redactedTechText, /\*\*Rust:\*\*/);
  assert.doesNotMatch(redactedTechText, />\s*Rust:/);
  assert.doesNotMatch(redactedTechText, /\*\*mark\*\*/);
  assert.match(redactedTechText, />\s*quoted note\./);
  assert.match(redactedTechText, /- restart the IDE\./);
  assert.match(redactedTechText, /pixel density/);
  assert.match(redactedTechText, /river pattern/);

  const techKeywords = extractTopKeywords(techAuthorMessages, { limit: 20 });
  for (const term of ['rust', 'java', 'kotlin']) {
    assert.ok(techKeywords.some((keyword) => keyword.word === term), `${term} should remain keyword-countable`);
  }

  // Per-topic cap must be enforced even when total digest length is under 2,000 characters,
  // while keeping compliant sibling topics byte-for-byte intact.
  const compliantSiblingTopic = [
    '- **WebStorm quota badge** [Confirmed]',
    '  - *Doubt*: Where does the monthly quota indicator appear?',
    '  - *Reply*: It appears in the right-hand status bar widget.',
  ].join('\n');
  const offendingTopicUnder2000 = [
    '- **EAP licensing, quota, credits, and top-up policy**: Comprehensive breakdown of monthly EAP quota rules and credit allocation:',
    `  - ${'Users confirmed monthly billing resets and top-up credit rules across JetBrains IDEs. '.repeat(4).trim()}`,
    `  - ${'Uncertainty remains around whether unused credits roll over across enterprise billing cycles. '.repeat(4).trim()}`,
    `  - ${'Third sub-bullet with excessive detail about token consumption in multi-file sessions. '.repeat(4).trim()}`,
    `  - ${'Fourth sub-bullet repeating quota warning dialogs and status bar notifications. '.repeat(4).trim()}`,
    `  - ${'Fifth sub-bullet elaborating on legacy trial extensions and seat assignments. '.repeat(3).trim()}`,
  ].join('\n');
  const inBudgetTotalButOversizedTopicDigest = [
    '**Main Discussion Topics**',
    compliantSiblingTopic,
    offendingTopicUnder2000,
  ].join('\n');
  assert.ok(
    offendingTopicUnder2000.length > 1500 && inBudgetTotalButOversizedTopicDigest.length <= 2000,
    `Expected offending topic > 1500 chars (${offendingTopicUnder2000.length}) and total <= 2000 (${inBudgetTotalButOversizedTopicDigest.length})`
  );
  const boundedMixedInBudget = enforceConciseDigest(inBudgetTotalButOversizedTopicDigest);
  assert.ok(
    boundedMixedInBudget.includes(compliantSiblingTopic),
    'Compliant sibling topic with nested Doubt/Reply bullets must be preserved byte-for-byte'
  );
  const boundedEapPart = boundedMixedInBudget.slice(
    boundedMixedInBudget.indexOf('- **EAP licensing, quota, credits, and top-up policy**')
  );
  assert.ok(
    boundedEapPart.length <= 450,
    `Offending topic inside <2,000-char digest must be bounded to <= 450 chars, got ${boundedEapPart.length}`
  );
  const boundedEapSubBullets = boundedEapPart
    .split('\n')
    .filter((l) => /^\s{2,}[-*•]\s+/.test(l));
  assert.ok(
    boundedEapSubBullets.length <= 2,
    `Offending topic must be capped to at most 2 sub-bullets, got ${boundedEapSubBullets.length}`
  );

  // Non-canonical umbrella headings ('### Key Themes', '## Summary', '### Main Topics', '### Community Insights')
  // with multiple bold-topic bullets must preserve topics or include an explicit omitted count when over budget.
  for (const heading of ['### Key Themes', '## Summary', '### Main Topics', '### Community Insights']) {
    const tenTopicsUnderHeading = [
      heading,
      ...Array.from(
        { length: 10 },
        (_, idx) =>
          `- **Theme ${idx + 1} Quota & Architecture**: ${'Developers discussed monthly EAP quota resets, Docker WSL2 networking, and DeepSeek fallback behavior in detail. '.repeat(2).trim()}`
      ),
    ].join('\n');
    assert.ok(tenTopicsUnderHeading.length > 2000);
    const boundedUmbrella = enforceConciseDigest(tenTopicsUnderHeading);
    assert.ok(boundedUmbrella.length <= 2000);
    const keptThemeMatches = boundedUmbrella.match(/- \*\*Theme \d+ Quota & Architecture\*\*/g) || [];
    assert.ok(
      keptThemeMatches.length >= 5,
      `Expected non-canonical umbrella heading "${heading}" to preserve multiple topics (got ${keptThemeMatches.length})`
    );
    if (keptThemeMatches.length < 10) {
      assert.match(
        boundedUmbrella,
        new RegExp(`\\.\\.\\.and ${10 - keptThemeMatches.length} more topics? omitted for brevity\\.`, 'i'),
        `Expected explicit omitted topic count under "${heading}"`
      );
    }
  }

  // Offline/fallback mode and missing/placeholder API keys must never invoke network in compressOversizedDigestWithLLM or callOpenAICompatibleLLM
  let unexpectedNetworkCalls = 0;
  const giantDraft = `**Main Discussion Topics**\n${'- **Huge topic**: ' + 'A'.repeat(3000)}`;
  for (const offlineConfig of [
    { provider: 'fallback', apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
    { provider: 'deepseek', apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
    { provider: 'deepseek', apiKey: 'your_deepseek_api_key_here', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  ]) {
    const compressedOffline = await compressOversizedDigestWithLLM(giantDraft, {
      llmConfig: offlineConfig,
      fetchImpl: async () => {
        unexpectedNetworkCalls++;
        throw new Error('Network must not be called when remote LLM is not configured');
      },
    });
    assert.ok(compressedOffline.length <= 2000);
    assert.ok(compressedOffline.split('\n').slice(1).join('\n').length <= 450);
    await assert.rejects(
      () =>
        callOpenAICompatibleLLM('test transcript', {
          llmConfig: offlineConfig,
          fetchImpl: async () => {
            unexpectedNetworkCalls++;
            throw new Error('Network must not be called');
          },
        }),
      /not configured/i
    );
  }
  assert.equal(unexpectedNetworkCalls, 0, 'Offline/unconfigured LLM must never call fetchImpl');

  const verboseTopic = `**Main Discussion Topics**\n${Array.from(
    { length: 12 },
    (_, index) =>
      `- **Topic ${index + 1}**: ${'Detailed but repetitive discussion about configuration, quota, and technical behavior. '.repeat(4)}`
  ).join('\n')}`;
  const conciseReply = '**Main Discussion Topics**\n- **Core topic**: Monthly quota resets; rollover remains unconfirmed.';
  let llmCalls = 0;
  const multiChunkDigest = await summarizeChannelHistory(
    {
      channelId: 'final-compress-only',
      channelName: 'chat',
      categoryName: 'Community',
      channelType: 'chat',
      messages: Array.from({ length: 4 }, (_, index) => ({
        id: `final-${index}`,
        author: `member_${index}`,
        content: `Discussing monthly quota behavior in message ${index}.`,
        timestamp: new Date(Date.UTC(2026, 9, 12, 10, index)).toISOString(),
      })),
    },
    {
      chunkSize: 2,
      llmConfig: {
        provider: 'deepseek',
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
      },
      fetchImpl: async () => {
        llmCalls++;
        const content = llmCalls === 4 ? conciseReply : verboseTopic;
        return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
      },
    }
  );
  assert.equal(llmCalls, 4, 'two map calls, one reduce call, and one final compression call are expected');
  assert.equal(multiChunkDigest.chunkCount, 2);
  assert.ok(multiChunkDigest.summary.length <= 2000);
  assert.match(multiChunkDigest.summary, /Monthly quota resets/);
});

test('Step 5 privacy v3: capitalized single-word names never reach prompts, LLM/fallback channel reports, or master reports (chat, forum, and QA text channels)', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'discord-step5-privacy3-'));
  const nameLeak = /\b(Carlos|Max|Lucia)\b|@john\b|\bpixel\s+confirmed\b|\briver\s+confirmed\b|\b[Tt]hanks,?\s+river\b/;

  try {
    const exportBundle = {
      guildId: 'g-priv3',
      guildName: 'Junie Community',
      lookbackDays: 90,
      channels: [
        {
          channelId: 'c-chat',
          channelName: '💬-chat',
          categoryName: 'Community',
          channelType: 'chat',
          messages: [
            { id: 'a1', author: 'Carlos', content: 'Thanks Lucia, restarting WebStorm fixed the crash. Use @workspace to inspect the project.', timestamp: '2026-10-10T10:00:00.000Z' },
            { id: 'a2', author: 'Max', content: 'Carlos confirmed the EAP quota resets monthly; max tokens is 8000 for Junie.', timestamp: '2026-10-10T10:05:00.000Z' },
            { id: 'a3', author: 'Lucia', content: 'Ping @john. I increased pixel density and the river pattern in the docs works.', timestamp: '2026-10-10T10:10:00.000Z' },
            { id: 'a4', author: 'pixel', content: 'Reproduced the pixel density bug on Docker.', timestamp: '2026-10-10T10:15:00.000Z' },
            { id: 'a5', author: 'river', content: 'river confirmed the pixel density fix works. Use the river pattern for logging.', timestamp: '2026-10-10T10:20:00.000Z' },
          ],
        },
        {
          channelId: 'c-qa',
          channelName: '❓-questions',
          categoryName: 'Support',
          channelType: 'qa',
          messages: [
            { id: 'q1', author: 'Carlos', content: 'Lucia, how do I configure the EAP quota in WebStorm?', timestamp: '2026-10-11T09:00:00.000Z' },
            { id: 'q2', author: 'Max', content: 'Carlos, open Settings and set the quota. Thanks @john.', timestamp: '2026-10-11T09:05:00.000Z' },
            { id: 'q3', author: 'Carlos', content: 'Thanks Max, that fixed it.', timestamp: '2026-10-11T09:10:00.000Z' },
          ],
        },
        {
          channelId: 'c-forum',
          channelName: '🆘-support',
          categoryName: 'Support',
          channelType: 'forum',
          posts: [
            {
              postId: 'p1',
              title: 'Lucia asks: Docker setup for Junie',
              author: 'Lucia',
              createdAt: '2026-10-12T09:00:00.000Z',
              starterQuestion: 'Hi Max, how do I run Junie in Docker? Carlos suggested WSL2.',
              replyCount: 1,
              answered: true,
              confirmed: true,
              messages: [
                { id: 'p1', author: 'Lucia', content: '[Forum Post: "Lucia asks: Docker setup for Junie"] Hi Max, how do I run Junie in Docker? Carlos suggested WSL2.', timestamp: '2026-10-12T09:00:00.000Z' },
                { id: 'p1r', author: 'Max', content: 'Lucia, enable WSL2 integration. Carlos confirmed it works.', timestamp: '2026-10-12T09:10:00.000Z' },
                { id: 'p1t', author: 'Lucia', content: 'Solved, thanks Max!', timestamp: '2026-10-12T09:20:00.000Z' },
              ],
            },
          ],
          messages: [
            { id: 'p1', author: 'Lucia', content: '[Forum Post: "Lucia asks: Docker setup for Junie"] Hi Max, how do I run Junie in Docker? Carlos suggested WSL2.', timestamp: '2026-10-12T09:00:00.000Z' },
            { id: 'p1r', author: 'Max', content: 'Lucia, enable WSL2 integration. Carlos confirmed it works.', timestamp: '2026-10-12T09:10:00.000Z' },
            { id: 'p1t', author: 'Lucia', content: 'Solved, thanks Max!', timestamp: '2026-10-12T09:20:00.000Z' },
          ],
        },
      ],
    };
    const rawSnapshot = JSON.stringify(exportBundle);

    const prompts = [];
    const llmMaster = path.join(tmpDir, 'llm', 'support-report-3months.md');
    const llmChannels = path.join(tmpDir, 'llm', 'channels');
    await generateServerSupportReport(exportBundle, {
      reportOutputPath: llmMaster,
      channelReportsDir: llmChannels,
      llmConfig: { provider: 'deepseek', apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        prompts.push(body.messages[1].content);
        const sys = body.messages[0].content;
        const content = sys.includes('Executive 3-Month')
          ? [
              '### 1. Executive Summary',
              'Carlos and Max discussed Junie quota; Lucia helped. Ping @john. about it.',
              '',
              '### 2. Forum & Q&A Channels — Most Frequent Questions & Common Doubts (FAQ)',
              '- **Docker setup**: Lucia asked, Max confirmed WSL2 integration; Carlos agreed.',
              '',
              '### 3. General Chat Channels — Main Discussion Topics & Community Vibe',
              '- Carlos reported a WebStorm crash fix; use @workspace for project context.',
              '',
              '### 4. Most Frequently Used Keywords & Technical Terms (Server-wide & Per-Channel)',
              '- Top terms include `junie` and `quota`.',
              '',
              '### 5. Channel-by-Channel Breakdown',
              '- Active channels.',
              '',
              '### 6. Meeting Talking Points & Action Items',
              '- Thank Carlos and Lucia. Document the EAP quota.',
            ].join('\n')
          : [
              '**Main Discussion Topics**',
              '- **WebStorm crash & quota**: Carlos confirmed the fix; thanks Lucia. Max noted the EAP quota resets monthly. Ping @john. and use @workspace.',
              '- **Pixel density**: pixel confirmed the bug; Thanks river for the river pattern.',
            ].join('\n');
        return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
      },
    });

    assert.equal(JSON.stringify(exportBundle), rawSnapshot, 'raw export must stay untouched');

    const allPrompts = prompts.join('\n');
    assert.doesNotMatch(allPrompts, nameLeak, 'prompts must not contain participant names');
    assert.match(allPrompts, /@workspace/, '@workspace tool token must survive in prompts');
    assert.match(allPrompts, /pixel density/i, 'ordinary technical prose must survive in prompts');

    const llmFiles = [
      ['LLM master', readFileSync(llmMaster, 'utf8')],
      ['LLM chat', readFileSync(path.join(llmChannels, 'chat.md'), 'utf8')],
      ['LLM qa', readFileSync(path.join(llmChannels, 'questions.md'), 'utf8')],
      ['LLM forum', readFileSync(path.join(llmChannels, 'support.md'), 'utf8')],
    ];
    for (const [label, text] of llmFiles) {
      assert.doesNotMatch(text, nameLeak, `${label} must not contain participant names`);
    }
    const llmChat = llmFiles[1][1];
    assert.match(llmChat, /@workspace/);
    assert.match(llmChat, /EAP quota resets monthly/);
    assert.match(llmChat, /Ping a user\./, 'sentence period after redacted @john must survive');
    assert.match(llmChat, /pixel density/i);

    // Local fallback path (no LLM) for channel + master reports
    const fbMaster = path.join(tmpDir, 'fb', 'support-report-3months.md');
    const fbChannels = path.join(tmpDir, 'fb', 'channels');
    await generateServerSupportReport(exportBundle, {
      reportOutputPath: fbMaster,
      channelReportsDir: fbChannels,
      llmConfig: { provider: 'fallback', apiKey: '', baseUrl: '', model: '' },
      fetchImpl: async () => {
        throw new Error('network must not be used in fallback mode');
      },
    });
    const fbFiles = [
      ['fallback master', readFileSync(fbMaster, 'utf8')],
      ['fallback chat', readFileSync(path.join(fbChannels, 'chat.md'), 'utf8')],
      ['fallback qa', readFileSync(path.join(fbChannels, 'questions.md'), 'utf8')],
      ['fallback forum', readFileSync(path.join(fbChannels, 'support.md'), 'utf8')],
    ];
    for (const [label, text] of fbFiles) {
      assert.doesNotMatch(text, nameLeak, `${label} must not contain participant names`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Step 5 vocatives and topics: addressed weak/tech names are redacted, tech lists and common words stay, inline bold topics and mixed bullets are preserved', () => {
  const known = collectKnownAuthors([
    { id: '1', author: 'river', content: 'x' },
    { id: '2', author: 'pixel', content: 'x' },
    { id: '3', author: 'Rust', content: 'x' },
    { id: '4', author: 'Java', content: 'x' },
  ]);

  const addressed = [
    ['river, yes it resets monthly.', 'A user, yes it resets monthly.'],
    ['Sure. river, try restarting.', 'Sure. A user, try restarting.'],
    ['- *Reply*: river, yes it resets.', '- *Reply*: a user, yes it resets.'],
    ['> river, yes it resets.', '> a user, yes it resets.'],
    ['river here: the fix is in.', 'A user here: the fix is in.'],
    ['ty pixel!', 'ty a user!'],
    ['Yes river, it resets.', 'Yes a user, it resets.'],
    ['Thanks river and pixel for the report.', 'Thanks participants for the report.'],
  ];
  for (const [input, expected] of addressed) {
    assert.equal(redactParticipantNames(input, known), expected, input);
  }

  const preserved = [
    'Rust and Java are supported.',
    'Yes, Rust and Java are supported.',
    'Increase pixel density in the editor.',
    'The Rust plugin is updated.',
  ];
  for (const input of preserved) {
    assert.equal(redactParticipantNames(input, known), input, input);
  }
  assert.equal(
    redactParticipantNames('Rust, Go, and Java are supported.', known.filter((n) => n !== 'pixel' && n !== 'river')),
    'Rust, Go, and Java are supported.'
  );

  const compliantInline = [
    '### Main Topics',
    '',
    '**Plugin release**: EAP 3 is out and fixes the indexing regression.',
    '',
    '**Licensing**: Quota resets monthly for all EAP users.',
    '',
    '**Credits**: Top-ups are added to the balance immediately.',
  ].join('\n');
  assert.equal(enforceConciseDigest(compliantInline), compliantInline);

  const compliantMixed = [
    '**Notable Highlights & Shared Ideas**',
    '',
    '- **Restart tip**: Restart the IDE after changing the plugin.',
    '- Update the plugin to EAP 3.',
    '- Keep the cache folder clean.',
    '- Share logs in the support forum.',
  ].join('\n');
  assert.equal(enforceConciseDigest(compliantMixed), compliantMixed);

  const overBudget = Array.from(
    { length: 20 },
    (_, i) =>
      `**Topic ${i + 1}**: ${Array.from({ length: 6 }, (__, j) => `Detailed sentence number ${j + 1} describing topic ${i + 1} in depth with many extra words that make every single sentence considerably longer than before.`).join(' ')}`
  ).join('\n\n');
  const bounded = enforceConciseDigest(overBudget);
  assert.ok(bounded.length <= 2050, `bounded length ${bounded.length}`);
  assert.ok(bounded.includes('**Topic 1**'));
  assert.ok(!bounded.includes('**Topic 20**'));
  assert.match(bounded, /\.\.\.and \d+ more topics omitted for brevity\./);
});

test('Step 5 reviewer regressions: splits multi-word authors, redacts non-author staff mentions, protects product terms (Claude Code, VS Code, JetBrains Air, Max plan, Mellum, Cloud, Dev), bounds unstructured master preamble, strips per-speaker rankings, and recompresses overlong single topics under 2,000 chars', async () => {
  // 1. Product terms must survive even when display names equal product words ("Code", "Max", "Air", "Mellum", "Cloud", "Dev")
  const productAuthorMessages = [
    { id: 'pa-1', author: 'Code', content: 'Claude Code and VS Code work fine with Junie.' },
    { id: 'pa-2', author: 'Max', content: 'Max plan costs more than Pro tier.' },
    { id: 'pa-3', author: 'Air', content: 'JetBrains Air alpha is fast.' },
    { id: 'pa-4', author: 'Mellum', content: 'Mellum models are optimized for code completion.' },
    { id: 'pa-5', author: 'Cloud', content: 'Cloud builds are nightly.' },
    { id: 'pa-6', author: 'Dev', content: 'Dev builds are nightly.' },
    { id: 'pa-7', author: 'Grace', content: 'Claude Grace and Grace plan are hypothetical product terms, while Grace confirmed the fix.' },
  ];
  const productAuthors = collectKnownAuthors(productAuthorMessages);
  const productProse = [
    'Claude Code and VS Code work fine.',
    'Max plan costs more.',
    'JetBrains Air alpha is available.',
    'Mellum models are integrated.',
    'Cloud builds are nightly.',
    'Dev builds are nightly.',
    'Max confirmed the quota reset.',
    'Thanks Code for testing.',
    'Hi Air, try restarting the IDE.',
  ].join('\n');
  const redactedProductProse = redactParticipantNames(productProse, productAuthors);
  assert.match(redactedProductProse, /Claude Code and VS Code work fine\./);
  assert.match(redactedProductProse, /Max plan costs more\./);
  assert.match(redactedProductProse, /JetBrains Air alpha is available\./);
  assert.match(redactedProductProse, /Mellum models are integrated\./);
  assert.match(redactedProductProse, /Cloud builds are nightly\./);
  assert.match(redactedProductProse, /Dev builds are nightly\./);
  assert.match(redactedProductProse, /A user confirmed the quota reset\./);
  assert.match(redactedProductProse, /Thanks a user for testing\./);
  assert.doesNotMatch(redactedProductProse, /Hi Air,/);

  // Ordinary given names are ALWAYS redacted, even next to common nouns; only protected product-word
  // author tokens (Code, Max, Air...) keep their adjacency exemptions.
  const ordinaryNameAdjacency = redactParticipantNames(
    'Grace update: the build is out. Grace support thread was helpful. Ivan project uses Gradle. Grace tests show regressions. Claude Code and Max plan stay.',
    [...productAuthors, 'Grace', 'Ivan Petrov']
  );
  assert.doesNotMatch(ordinaryNameAdjacency, /\bGrace\b|\bIvan\b|\bPetrov\b/);
  assert.match(ordinaryNameAdjacency, /A user update: the build is out\./);
  assert.match(ordinaryNameAdjacency, /A user support thread was helpful\./);
  assert.match(ordinaryNameAdjacency, /A user project uses Gradle\./);
  assert.match(ordinaryNameAdjacency, /Claude Code and Max plan stay\./);
  assert.doesNotMatch(
    redactParticipantNames('Claude Grace and Grace plan work, whereas Grace confirmed the bug.', productAuthors),
    /Grace/
  );

  // 2. Multi-word display name given names ("Maria Lopez" -> "Maria") and non-author staff mentions ("Anton", "Elena")
  //    never leak into prompts, digests, master reports, or per-channel/server keyword tables
  const staffAndMultiWordBundle = {
    guildId: 'g-staff-mw',
    guildName: 'Junie Community Server',
    lookbackDays: 90,
    channels: [
      {
        channelId: 'ch-junie',
        channelName: '💬-junie',
        categoryName: 'Community',
        channelType: 'chat',
        messages: [
          {
            id: 'mw-1',
            author: 'Maria Lopez',
            content: 'Thanks Anton for checking the EAP quota; answered by Elena that credits reset monthly in WebStorm.',
            timestamp: '2026-10-10T10:00:00.000Z',
          },
          {
            id: 'mw-2',
            author: 'zephyr_77',
            content: 'Thanks Maria and Elena! Asked by Anton about the new Mellum models in JetBrains Air and Claude Code.',
            timestamp: '2026-10-10T10:05:00.000Z',
          },
          {
            id: 'mw-3',
            author: 'Maria Lopez',
            content: 'Maria and Anton said thanks Elena for verifying the Max plan quota.',
            timestamp: '2026-10-10T10:10:00.000Z',
          },
        ],
      },
    ],
  };

  const capturedPrompts = [];
  const mwReport = await generateServerSupportReport(staffAndMultiWordBundle, {
    reportOutputPath: null,
    channelReportsDir: null,
    llmConfig: {
      provider: 'deepseek',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const sys = body.messages[0].content;
      const usr = body.messages[1].content;
      capturedPrompts.push({ sys, usr });
      if (sys.includes('Executive 3-Month')) {
        // Simulate an unstructured / preamble-heavy master reply AND Section 6 per-speaker ranking fragments
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: [
                    '# Executive Retrospective Report',
                    `- **EAP licensing, quota, credits, and top-up policy**: ${'Detailed analysis of monthly EAP quota rules, credit top-ups, and enterprise billing cycles where Maria and Elena lead the discussion. '.repeat(28)}`,
                    '',
                    '### 3. General Chat Channels — Main Discussion Topics & Community Vibe',
                    '- **Quota & Models**: Sessions where Maria and a user lead confirm Claude Code, VS Code, JetBrains Air, and Max plan support.',
                    '',
                    '### 6. Key Contributors & Meeting Talking Points',
                    '- Maria: 133 messages',
                    '- **zephyr_77** most active',
                    '- Document the monthly EAP quota reset rule.',
                  ].join('\n'),
                },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: [
                  '**Main Discussion Topics**',
                  '- **EAP quota & models**: Sessions where Maria and Elena lead confirm Anton verified the monthly reset for Claude Code, VS Code, JetBrains Air, and Max plan.',
                ].join('\n'),
              },
            },
          ],
        }),
      };
    },
  });

  const leakedNamesRegex = /\b(Maria|Lopez|Anton|Elena|zephyr_77)\b/i;
  for (const { sys, usr } of capturedPrompts) {
    assert.match(sys, /NO person names at all/i, 'every system prompt must forbid all person names including staff/mentioned people');
    assert.doesNotMatch(usr, leakedNamesRegex, `user prompt must not leak first names or staff names:\n${usr}`);
  }
  assert.doesNotMatch(
    mwReport.channelDigests[0].summary,
    leakedNamesRegex,
    `channel digest must not leak first names or staff names:\n${mwReport.channelDigests[0].summary}`
  );
  assert.doesNotMatch(
    mwReport.markdownReport,
    leakedNamesRegex,
    `master report must not leak first names or staff names:\n${mwReport.markdownReport}`
  );
  assert.match(mwReport.markdownReport, /Claude Code/);
  assert.match(mwReport.markdownReport, /VS Code/);
  assert.match(mwReport.markdownReport, /JetBrains Air/);
  assert.match(mwReport.markdownReport, /Max plan/);

  // Per-channel and server-wide keyword tables must not contain Maria, Lopez, Anton, or Elena
  const allKwWords = [
    ...mwReport.serverTopKeywords.map((k) => k.word),
    ...mwReport.channelDigests[0].topKeywords.map((k) => k.word),
  ];
  for (const forbiddenKw of ['maria', 'lopez', 'anton', 'elena', 'zephyr_77']) {
    assert.ok(!allKwWords.includes(forbiddenKw), `keyword table must not include person name "${forbiddenKw}"`);
  }

  // Unstructured preamble before first section must be bounded, and leftover ranking lines must be removed
  assert.ok(
    mwReport.markdownReport.length < 3500,
    `master report with huge unstructured preamble must be bounded (<3500 chars, got ${mwReport.markdownReport.length})`
  );
  assert.doesNotMatch(mwReport.markdownReport, /-\s*133 messages/i, 'leftover per-speaker message count line must be removed');
  assert.doesNotMatch(mwReport.markdownReport, /a user most active/i, 'leftover "a user most active" fragment must be removed');
  assert.match(mwReport.markdownReport, /### 6\. Meeting Talking Points & Action Items/);
  assert.match(mwReport.markdownReport, /Document the monthly EAP quota reset rule\./);

  // 3. Totally unstructured master LLM reply (zero ### N. headings) is bounded in Section 1
  const unstructuredMasterReport = await generateServerSupportReport(staffAndMultiWordBundle, {
    reportOutputPath: null,
    channelReportsDir: null,
    llmConfig: {
      provider: 'deepseek',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const sys = body.messages[0].content;
      if (sys.includes('Executive 3-Month')) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: `- **EAP licensing, quota, credits, and top-up policy**: ${'Unstructured master narrative repeating quota details without numbered headings. '.repeat(48)}`,
                },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '**Main Discussion Topics**\n- **Quota**: Monthly reset confirmed.' } }],
        }),
      };
    },
  });
  const sec1Slice = unstructuredMasterReport.markdownReport.slice(
    unstructuredMasterReport.markdownReport.indexOf('### 1. Executive Summary'),
    unstructuredMasterReport.markdownReport.indexOf('### 2. Forum & Q&A Channels')
  );
  assert.ok(
    sec1Slice.length <= 1300,
    `Section 1 with unstructured 3,800-char master reply must be bounded (<= 1300 chars, got ${sec1Slice.length})`
  );

  // 4. Overlong individual topic (> 450 chars) inside an under-2,000-char total digest triggers LLM recompression
  //    so key decisions at the end of the topic are preserved instead of blindly clipped
  const overlongSingleTopicUnder2000 = [
    '**Main Discussion Topics**',
    `- **EAP licensing, quota, credits, and top-up policy**: ${'Users discussed monthly billing resets, credit consumption rates, and enterprise seat rules across multiple JetBrains IDEs. '.repeat(6)}KEY_END_DECISION: Unused top-up credits carry over for 12 months.`,
  ].join('\n');
  assert.ok(
    overlongSingleTopicUnder2000.length > 750 && overlongSingleTopicUnder2000.length < 1800,
    `Expected total length < 1800 (${overlongSingleTopicUnder2000.length}) with single topic > 450`
  );

  let singleTopicCompressCalls = 0;
  const recompressedUnder2000 = await summarizeChannelHistory(
    {
      channelId: 'ch-single-overlong-topic',
      channelName: 'junie',
      categoryName: 'Community',
      channelType: 'chat',
      messages: [
        {
          id: 'sot-1',
          author: 'member_1',
          content: 'Discussing EAP quota and top-up credit carry-over decision.',
          timestamp: '2026-10-12T10:00:00.000Z',
        },
      ],
    },
    {
      chunkSize: 50,
      llmConfig: {
        provider: 'deepseek',
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
      },
      fetchImpl: async () => {
        singleTopicCompressCalls++;
        const content =
          singleTopicCompressCalls === 1
            ? overlongSingleTopicUnder2000
            : '**Main Discussion Topics**\n- **EAP licensing, quota, credits, and top-up policy**: Monthly billing resets apply across IDEs, and KEY_END_DECISION: Unused top-up credits carry over for 12 months.';
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content } }] }),
        };
      },
    }
  );
  assert.equal(
    singleTopicCompressCalls,
    2,
    'Must trigger LLM recompression when an individual topic exceeds 450 chars even if total digest is < 2,000 chars'
  );
  assert.match(
    recompressedUnder2000.summary,
    /KEY_END_DECISION: Unused top-up credits carry over for 12 months\./,
    'Recompression preserves the key decision from the end of the overlong topic'
  );
});

test('Step 5 contextual names: common words and product names (incl. Kiro, Sentry, Raycast, Message Queue) are never flagged or rewritten, while >=2 strict person-context hits are', () => {
  const ambiguous = [
    'Restart', 'Update', 'Reinstall', 'Rollback', 'Nobody', 'Others', 'Docs', 'Today', 'Yesterday',
    'Codex', 'Qwen', 'Grok', 'Chrome', 'Firefox', 'Safari', 'Edge', 'Xcode', 'Jira', 'Customer', 'Sales',
    'Kiro', 'Trae', 'Devin', 'Manus', 'Bolt', 'Roo', 'Continue', 'Gemma', 'Ruby', 'Mongo',
    'Sentry', 'Stripe', 'Postman', 'Heroku', 'Warp', 'Raycast', 'Obsidian', 'Godot', 'Blender', 'Lmstudio',
  ];
  const messages = [];
  ambiguous.forEach((word, i) => {
    messages.push({ id: `a-${i}`, author: `member_${i}`, content: `${word} fixed the issue for me.` });
    messages.push({ id: `b-${i}`, author: `helper_${i}`, content: `Thanks ${word}!` });
    messages.push({ id: `c-${i}`, author: `other_${i}`, content: `I worked with ${word} before and according to ${word} it works.` });
  });
  const known = collectKnownAuthors(messages);
  for (const word of ambiguous) {
    assert.ok(!known.includes(word), `"${word}" must not be treated as a person name`);
  }

  // Exact regression probes from review: "worked with Kiro", "according to Sentry", "Message Queue", "Hi Raycast users"
  const competitorAndToolMessages = [
    { id: 'ct-1', author: 'member_1', content: 'I worked with Kiro before.' },
    { id: 'ct-2', author: 'member_2', content: 'Kiro vs Junie: Kiro has spec mode and Kiro is popular.' },
    { id: 'ct-3', author: 'member_3', content: 'according to Sentry the crash happens in Message Queue issues.' },
    { id: 'ct-4', author: 'member_4', content: 'Hi Raycast users, any extension for Kiro or Sentry?' },
  ];
  const ctKnown = collectKnownAuthors(competitorAndToolMessages);
  for (const term of ['Kiro', 'Sentry', 'Message', 'Queue', 'Raycast']) {
    assert.ok(!ctKnown.includes(term), `"${term}" must never be collected as a known author`);
  }
  for (const m of competitorAndToolMessages) {
    assert.equal(
      redactParticipantNames(m.content, ctKnown),
      m.content,
      `Transcript line must stay unaltered: "${m.content}"`
    );
  }
  const ctKeywords = extractTopKeywords(competitorAndToolMessages, { limit: 20 }).map((k) => k.word);
  for (const expectedKw of ['kiro', 'sentry', 'message', 'queue', 'raycast']) {
    assert.ok(ctKeywords.includes(expectedKw), `"${expectedKw}" must remain in Top Keywords (got: ${ctKeywords.join(', ')})`);
  }

  const prose =
    'Restart the IDE after the update. Update to 2025.2 first. Nobody answered my question. Docs explained the Codex CLI setup. Thanks Chrome for the tip. Open it in Chrome or Edge.';
  assert.equal(redactParticipantNames(prose, known), prose);

  const keywords = extractTopKeywords(
    [
      { author: 'x1', content: 'Codex solved it. Codex answered quickly. Codex fixed the crash with Codex CLI.' },
      { author: 'x2', content: 'Codex CLI works with Codex after update.' },
    ],
    { limit: 20 }
  );
  assert.ok(keywords.some((k) => k.word === 'codex'), 'codex must stay in keyword tables');

  // Strict person-context evidence requires >=2 independent hits for non-author names
  const singleHitStaff = collectKnownAuthors([
    { id: 'sh-1', author: 'member_a', content: 'Thanks Anton! Resolved by Viktor.' },
  ]);
  assert.ok(!singleHitStaff.includes('Anton') && !singleHitStaff.includes('Viktor'), 'single strict hit must not globally redact a non-author');
  const knownParticipant = collectKnownAuthors([
    { id: 'known-author', author: 'Maria Lopez', content: 'I asked about the quota.' },
  ]);
  assert.ok(knownParticipant.includes('Maria Lopez'), 'known message authors must still be collected without contextual evidence');
  assert.doesNotMatch(redactParticipantNames('Maria Lopez asked about the quota.', knownParticipant), /Maria|Lopez/);

  const repeatedProductAttributions = [
    { id: 'pa-1', author: 'member_a', content: 'Reported by Sentry; fixed by Codex.' },
    { id: 'pa-2', author: 'member_a', content: 'Reported by Sentry again; fixed by Codex again.' },
  ];
  const sameAuthorProducts = collectKnownAuthors(repeatedProductAttributions);
  assert.ok(!sameAuthorProducts.includes('Sentry'), 'repeated product attribution by one author is insufficient person evidence');
  assert.ok(!sameAuthorProducts.includes('Codex'), 'repeated product attribution by one author is insufficient person evidence');
  const sameAuthorProductsRedacted = repeatedProductAttributions.map((message) =>
    redactParticipantNames(message.content, sameAuthorProducts)
  );
  assert.ok(sameAuthorProductsRedacted.every((content) => /Sentry/.test(content) && /Codex/.test(content)));
  const sameAuthorProductKeywords = extractTopKeywords(repeatedProductAttributions, { limit: 20 }).map((keyword) => keyword.word);
  assert.ok(sameAuthorProductKeywords.includes('sentry'));
  assert.ok(sameAuthorProductKeywords.includes('codex'));

  const twoAuthorStaff = collectKnownAuthors([
    { id: 'staff-1', author: 'member_a', content: 'Thanks Anton for checking.' },
    { id: 'staff-2', author: 'member_b', content: 'Asked by Anton to verify the fix.' },
  ]);
  assert.ok(twoAuthorStaff.includes('Anton'), 'gratitude and asked-by evidence from distinct authors should identify a staff person');
  assert.match(redactParticipantNames('Thanks Anton for checking.', twoAuthorStaff), /Thanks a user for checking\./);

  const rejectedPassiveAttributions = collectKnownAuthors([
    { id: 'tool-1', author: 'member_a', content: 'Reported by Sentry and fixed by Codex.' },
    { id: 'tool-2', author: 'member_b', content: 'Reported by Sentry and fixed by Codex.' },
  ]);
  assert.ok(!rejectedPassiveAttributions.includes('Sentry') && !rejectedPassiveAttributions.includes('Codex'), 'non-human passive verbs must not identify tools as people');

  const multiHitStaff = collectKnownAuthors([
    { id: 's-1', author: 'member_a', content: 'Thanks Anton! Thanks Maria! Thanks Viktor.' },
    { id: 's-2', author: 'member_b', content: 'Asked by Anton and Maria. Thank you Viktor! Asked by Elena.' },
    { id: 's-3', author: 'member_c', content: 'Thanks Elena for the update.' },
  ]);
  for (const name of ['Anton', 'Maria', 'Viktor', 'Elena']) {
    assert.ok(multiHitStaff.includes(name), `${name} should be detected from >=2 strict person contexts`);
  }
  // Subject-before-verb alone is not evidence
  const subjectOnly = collectKnownAuthors([{ id: 'so-1', author: 'member_c', content: 'Zorbin confirmed the fix. Plenko reported it.' }]);
  assert.ok(!subjectOnly.includes('Zorbin') && !subjectOnly.includes('Plenko'));

  // Leftover per-user count fragments are stripped cleanly from prose while standalone ranking lines are removed
  const rankingCleaned = redactParticipantNames(
    '- **Maria Lopez** (12 messages) asked about quota\n- **Maria Lopez** (12 messages)',
    ['Maria Lopez']
  );
  assert.equal(rankingCleaned.trim(), '- A user asked about quota');

  // The adjacency exemption applies ONLY to protected product-word authors, never to ordinary given names
  const redacted = redactParticipantNames(
    'Grace update: the build is out. Grace support thread was helpful. Ivan project uses Gradle. Grace tests show regressions. Claude Code and Max plan stay.',
    ['Grace', 'Ivan Petrov', 'Code', 'Max']
  );
  assert.doesNotMatch(redacted, /\bGrace\b|\bIvan\b/);
  assert.match(redacted, /Claude Code and Max plan stay\./);
});

test('Step 5 digest clipping keeps decision, fix and open-question sentences and nested sub-bullets (incl. the last) when the model refuses to shorten a verbose topic', async () => {
  const decision = 'Decision: unused credits carry over; still unconfirmed for enterprise.';
  const repeatedOpener = `**Main Discussion Topics**\n- **EAP licensing, quota, credits, and top-up policy**: ${'Users keep asking how the EAP quota resets across IDEs. '.repeat(40)}Workaround: top up manually. ${decision}`;
  const uniqueFiller = `**Main Discussion Topics**\n- **EAP licensing, quota, credits, and top-up policy**: Users keep asking how the EAP quota resets. ${Array.from({ length: 70 }, (_, i) => `Background detail ${i + 1} covers billing cycle behaviour.`).join(' ')} Fix: update to build 2025.2. ${decision}`;
  const nestedSubBullets = [
    '**Main Discussion Topics**',
    '- **EAP licensing, quota, credits, and top-up policy**:',
    '  - Users discussed how monthly EAP quotas are calculated across different IDE versions and project sizes, especially with large enterprise monorepos.',
    '  - Several comparisons were made between the EAP quota model and other coding assistants, after the pricing announcement last month.',
    '  - Some participants asked whether background indexing consumes credits when the agent is idle.',
    '  - Workaround: switch to manual credit top-ups in the JetBrains account portal when hitting the monthly cap, especially with large workspaces.',
    '  - Decision: unused top-up credits roll over for 12 months across all supported IDEs, after the pricing policy review.',
    '  - Open question: still unconfirmed whether enterprise shared pools support automatic rollover across billing cycles.',
  ].join('\n');
  assert.ok(repeatedOpener.length > 2000 && uniqueFiller.length > 3500 && nestedSubBullets.length > 700);

  for (const verbose of [repeatedOpener, uniqueFiller]) {
    for (const channelType of ['chat', 'forum']) {
      let calls = 0;
      const refusingFetch = async () => {
        calls++;
        return { ok: true, json: async () => ({ choices: [{ message: { content: verbose } }] }) };
      };
      const llmConfig = { provider: 'deepseek', apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' };
      const channel =
        channelType === 'chat'
          ? {
              channelId: 'ch-refuse',
              channelName: 'junie',
              categoryName: 'Community',
              channelType: 'chat',
              messages: [
                { id: 'r-1', author: 'member_1', content: 'How does the EAP quota reset?', timestamp: '2026-10-12T10:00:00.000Z' },
                { id: 'r-2', author: 'member_2', content: 'Credits carry over monthly.', timestamp: '2026-10-12T10:01:00.000Z' },
              ],
            }
          : {
              channelId: 'ch-refuse-forum',
              channelName: 'support',
              categoryName: 'Community',
              channelType: 'forum',
              posts: [
                {
                  postId: 'p-1',
                  title: 'EAP quota question',
                  author: 'member_1',
                  createdAt: '2026-10-12T10:00:00.000Z',
                  answered: true,
                  messages: [
                    { id: 'f-1', author: 'member_1', content: 'How does the EAP quota reset?', timestamp: '2026-10-12T10:00:00.000Z' },
                    { id: 'f-2', author: 'member_2', content: 'It resets monthly.', timestamp: '2026-10-12T10:05:00.000Z' },
                  ],
                },
              ],
              messages: [
                { id: 'f-1', author: 'member_1', content: 'How does the EAP quota reset?', timestamp: '2026-10-12T10:00:00.000Z' },
                { id: 'f-2', author: 'member_2', content: 'It resets monthly.', timestamp: '2026-10-12T10:05:00.000Z' },
              ],
            };
      const digest = await summarizeChannelHistory(channel, { chunkSize: 50, llmConfig, fetchImpl: refusingFetch });
      assert.ok(calls >= 2, 'a re-compression attempt must be made before the deterministic clip');
      assert.ok(digest.summary.length <= 2000, `digest must be bounded, got ${digest.summary.length}`);
      assert.match(digest.summary, /Decision: unused credits carry over; still unconfirmed for enterprise\./);
      assert.doesNotMatch(digest.summary, /\.\.\.\s*$/m, 'no ellipsis truncation when sentence selection applies');
      const topicLine = digest.summary.split('\n').find((l) => l.includes('EAP licensing'));
      assert.ok(topicLine && topicLine.length <= 520, `topic line must be bounded, got ${topicLine?.length}`);
      assert.equal(
        (digest.summary.match(/Users keep asking how the EAP quota resets/g) || []).length <= 1,
        true,
        'the repetitive opener must not be repeated'
      );
    }
  }

  // Nested sub-bullet shape (chat + forum): when model refuses compression, ranks & merges Workaround, Decision, and Open question
  for (const channelType of ['chat', 'forum']) {
    let nestedCalls = 0;
    const refusingNestedFetch = async () => {
      nestedCalls++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: nestedSubBullets } }] }) };
    };
    const llmConfig = { provider: 'deepseek', apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' };
    const channel =
      channelType === 'chat'
        ? {
            channelId: 'ch-nested-refuse',
            channelName: 'junie',
            categoryName: 'Community',
            channelType: 'chat',
            messages: [
              { id: 'nr-1', author: 'member_1', content: 'How does the EAP quota reset?', timestamp: '2026-10-12T10:00:00.000Z' },
              { id: 'nr-2', author: 'member_2', content: 'Credits roll over for 12 months.', timestamp: '2026-10-12T10:01:00.000Z' },
            ],
          }
        : {
            channelId: 'ch-nested-refuse-forum',
            channelName: 'support',
            categoryName: 'Community',
            channelType: 'forum',
            posts: [
              {
                postId: 'np-1',
                title: 'EAP quota question',
                author: 'member_1',
                createdAt: '2026-10-12T10:00:00.000Z',
                answered: true,
                messages: [
                  { id: 'nf-1', author: 'member_1', content: 'How does the EAP quota reset?', timestamp: '2026-10-12T10:00:00.000Z' },
                  { id: 'nf-2', author: 'member_2', content: 'Credits roll over for 12 months.', timestamp: '2026-10-12T10:05:00.000Z' },
                ],
              },
            ],
            messages: [
              { id: 'nf-1', author: 'member_1', content: 'How does the EAP quota reset?', timestamp: '2026-10-12T10:00:00.000Z' },
              { id: 'nf-2', author: 'member_2', content: 'Credits roll over for 12 months.', timestamp: '2026-10-12T10:05:00.000Z' },
            ],
          };
    const digest = await summarizeChannelHistory(channel, { chunkSize: 50, llmConfig, fetchImpl: refusingNestedFetch });
    assert.ok(nestedCalls >= 2, 'recompression must be attempted for overlong nested topic');
    const topicPart = digest.summary.slice(digest.summary.indexOf('- **EAP licensing'));
    assert.ok(topicPart.length <= 450, `nested topic block must be <= 450 chars, got ${topicPart.length}:\n${topicPart}`);
    const subLines = topicPart.split('\n').filter((l) => /^\s{2,}[-*•]\s+/.test(l));
    assert.ok(subLines.length <= 2, `nested topic must have <= 2 sub-bullets, got ${subLines.length}`);
    assert.match(topicPart, /Workaround:/, 'Workaround must be preserved');
    assert.match(topicPart, /Decision: unused top-up credits roll over for 12 months/, 'Decision must be preserved');
    assert.match(topicPart, /Open question: still unconfirmed whether enterprise/, 'Open question must be preserved');
    assert.ok(
      topicPart.indexOf('Workaround:') < topicPart.indexOf('Decision:') &&
        topicPart.indexOf('Decision:') < topicPart.indexOf('Open question:'),
      'High-priority facts must be preserved in their original order'
    );
    assert.doesNotMatch(topicPart, /\.\.\./, 'nested sub-bullets must end at clean sentence/clause boundaries without ellipsis');
  }

  // Direct clip: repeated sentences are dropped and the decision + last sentence survive
  const clipped = clipTextCleanly(
    `${'Opening sentence repeated many times. '.repeat(30)}Fix: restart the daemon. ${decision}`,
    450
  );
  assert.ok(clipped.length <= 450);
  assert.equal((clipped.match(/Opening sentence repeated many times\./g) || []).length, 1);
  assert.match(clipped, /Fix: restart the daemon\./);
  assert.match(clipped, /still unconfirmed for enterprise\.$/);
});
