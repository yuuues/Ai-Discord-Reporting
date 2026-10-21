import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, loadConfig } from './config.js';
import { DiscordChannelType } from './services/discordUserClient.js';
import { exportGuildHistory, listGuildChannels } from './services/serverExporter.js';
import { generateServerSupportReport } from './services/serverReportGenerator.js';

const PLACEHOLDER_TOKENS = new Set([
  'your_discord_user_token_here',
  'your_discord_bot_token_here',
]);

const PLACEHOLDER_GUILD_IDS = new Set([
  'your_discord_guild_id_here',
]);

const KNOWN_CLI_FLAGS = new Set([
  '--list-channels',
  '--export',
  '--report',
]);

const SUPPORTED_EXPORT_CHANNEL_TYPES = new Set([
  DiscordChannelType.GuildText,
  DiscordChannelType.GuildAnnouncement,
  DiscordChannelType.PublicThread,
  DiscordChannelType.AnnouncementThread,
  DiscordChannelType.GuildForum,
]);

const CLI_USAGE_TEXT = [
  'Usage:',
  '  node src/analyze-server-cli.js                 (Phase 1 export + Phase 2 report)',
  '  node src/analyze-server-cli.js --list-channels (List server channels only; no export, no AI)',
  '  node src/analyze-server-cli.js --export        (Phase 1 export only; no AI)',
  '  node src/analyze-server-cli.js --report        (Phase 2 report only from existing JSON; no Discord connection)',
].join('\n');

function isMissingToken(token) {
  const trimmed = String(token || '').trim();
  return !trimmed || PLACEHOLDER_TOKENS.has(trimmed);
}

function hasDisallowedTokenPrefix(token) {
  const trimmed = String(token || '').trim();
  return /^(?:bot|bearer)\s+/i.test(trimmed);
}

function isMissingGuildId(guildId) {
  const trimmed = String(guildId || '').trim();
  return !trimmed || PLACEHOLDER_GUILD_IDS.has(trimmed);
}

/**
 * CLI for exporting Discord conversation histories (Normal Chats + Forum Channels)
 * via Discord REST API v10 and generating Markdown reports with DeepSeek.
 *
 * Modes:
 *   node src/analyze-server-cli.js                 -> Phase 1 (Export) + Phase 2 (Generate Report)
 *   node src/analyze-server-cli.js --list-channels -> Inspect accessible server channels & types (no export, no AI)
 *   node src/analyze-server-cli.js --export        -> Phase 1 only: export histories to data/exports/ (no AI)
 *   node src/analyze-server-cli.js --report        -> Phase 2 only: generate report from existing data/exports/server-export.json (no Discord calls)
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {Function} [options.fetchImpl]
 * @param {object} [options.logger]
 * @param {boolean} [options.printReport=true]
 * @returns {Promise<{ exitCode: number, mode: string, channels?: Array<object>, exportBundle?: object, reportResult?: object }>}
 */
export async function runAnalyzeServerCli(
  argv = process.argv.slice(2),
  {
    env,
    fetchImpl = globalThis.fetch,
    logger = console,
    printReport = true,
  } = {}
) {
  const activeConfig = env ? loadConfig(env) : config;
  const normalizedArgv = Array.isArray(argv) ? argv.map((a) => String(a).trim()).filter(Boolean) : [];
  const unknownArgs = normalizedArgv.filter((arg) => !KNOWN_CLI_FLAGS.has(arg));

  if (unknownArgs.length > 0) {
    logger.error(
      `[Error] Unrecognized CLI argument(s): ${unknownArgs.join(', ')}\n${CLI_USAGE_TEXT}`
    );
    return { exitCode: 1, mode: 'invalid-args', unknownArgs };
  }

  const args = new Set(normalizedArgv);
  const listChannelsMode = args.has('--list-channels');
  const hasExportFlag = args.has('--export');
  const hasReportFlag = args.has('--report');

  if (listChannelsMode && (hasExportFlag || hasReportFlag)) {
    logger.error(
      `[Error] Conflicting CLI arguments: --list-channels cannot be combined with --export or --report.\n${CLI_USAGE_TEXT}`
    );
    return { exitCode: 1, mode: 'invalid-args' };
  }

  const exportOnly = hasExportFlag && !hasReportFlag;
  const reportOnly = hasReportFlag && !hasExportFlag;

  const exportDir = path.join(activeConfig.report.dataDir, 'exports');
  const exportFilePath = path.join(exportDir, 'server-export.json');
  const reportsDir = path.join(activeConfig.report.dataDir, 'reports');
  const reportFilePath = path.join(reportsDir, 'support-report-3months.md');
  const channelReportsDir = path.join(reportsDir, 'channels');

  // Mode 1: --list-channels (inspect server channels via REST v10, no export, no AI)
  if (listChannelsMode) {
    if (isMissingToken(activeConfig.discord.userToken)) {
      logger.error(
        '[Error] Missing DISCORD_USER_TOKEN in .env file.\n' +
          'Set DISCORD_USER_TOKEN and DISCORD_GUILD_ID in .env to list server channels, or run "npm run demo" for an offline sample.'
      );
      return { exitCode: 1, mode: 'list-channels' };
    }

    if (hasDisallowedTokenPrefix(activeConfig.discord.userToken)) {
      logger.error(
        '[Error] Invalid DISCORD_USER_TOKEN format: enter the raw token value without a "Bot " or "Bearer " prefix.'
      );
      return { exitCode: 1, mode: 'list-channels' };
    }

    if (isMissingGuildId(activeConfig.discord.guildId)) {
      logger.error(
        '[Error] Missing DISCORD_GUILD_ID in .env file.\n' +
          'Set DISCORD_GUILD_ID in .env (right-click the server icon in Discord -> Copy Server ID) to list channels.'
      );
      return { exitCode: 1, mode: 'list-channels' };
    }

    logger.log(
      `[Channels] Fetching channel list for guild ID "${activeConfig.discord.guildId}" via Discord REST API v10...`
    );

    const channels = await listGuildChannels(activeConfig.discord.guildId, {
      token: activeConfig.discord.userToken,
      includeChannels: activeConfig.report.includeChannels,
      excludeChannels: activeConfig.report.excludeChannels,
      qaChannelPatterns: activeConfig.report.qaChannelPatterns,
      fetchImpl,
    });

    const exportableCount = channels.filter((ch) => ch.exportable).length;
    logger.log(
      `[Channels] Found ${channels.length} total channels (${exportableCount} exportable with current filters):`
    );
    for (const ch of channels) {
      let statusLabel = 'INCLUDED';
      if (!ch.exportable) {
        const isSupportedType =
          ch.channelType === 'forum' || SUPPORTED_EXPORT_CHANNEL_TYPES.has(ch.type);
        statusLabel = isSupportedType
          ? 'SKIPPED (filtered by include/exclude rules)'
          : `SKIPPED (unsupported non-text/voice channel type ${ch.type})`;
      }
      logger.log(
        `  - #${ch.name} (ID: ${ch.id}) | Category: ${ch.categoryName} | Type: ${ch.channelType.toUpperCase()} | ${statusLabel}`
      );
    }

    return {
      exitCode: 0,
      mode: 'list-channels',
      channels,
    };
  }

  let exportBundle = null;

  // Phase 1: Export from Discord REST API v10 (when --export or default full run)
  if (!reportOnly) {
    if (isMissingToken(activeConfig.discord.userToken)) {
      logger.error(
        '[Error] Missing DISCORD_USER_TOKEN in .env file.\n' +
          'To export a Discord server, set DISCORD_USER_TOKEN and DISCORD_GUILD_ID in .env.\n' +
          'To analyze an existing export without connecting to Discord, run "npm run generate-report", or run "npm run demo" for the built-in 1-Chat + 1-Forum demo.'
      );
      return { exitCode: 1, mode: exportOnly ? 'export' : 'full' };
    }

    if (hasDisallowedTokenPrefix(activeConfig.discord.userToken)) {
      logger.error(
        '[Error] Invalid DISCORD_USER_TOKEN format: enter the raw token value without a "Bot " or "Bearer " prefix.'
      );
      return { exitCode: 1, mode: exportOnly ? 'export' : 'full' };
    }

    if (isMissingGuildId(activeConfig.discord.guildId)) {
      logger.error(
        '[Error] Missing DISCORD_GUILD_ID in .env file.\n' +
          'Set DISCORD_GUILD_ID to the target Discord server ID (right-click server icon -> Copy Server ID).'
      );
      return { exitCode: 1, mode: exportOnly ? 'export' : 'full' };
    }

    logger.log(
      `[Export] Starting ${activeConfig.report.lookbackDays}-day read-only export for server ID "${activeConfig.discord.guildId}"...`
    );

    exportBundle = await exportGuildHistory(activeConfig.discord.guildId, {
      token: activeConfig.discord.userToken,
      days: activeConfig.report.lookbackDays,
      maxMessagesPerChannel: activeConfig.report.maxMessagesPerChannel,
      includeChannels: activeConfig.report.includeChannels,
      excludeChannels: activeConfig.report.excludeChannels,
      qaChannelPatterns: activeConfig.report.qaChannelPatterns,
      outputDir: exportDir,
      requestDelayMs: activeConfig.discord.requestDelayMs,
      fetchImpl,
      onProgress: (info) => {
        if (info.step === 'fetching_channel') {
          logger.log(
            `  -> [${info.current}/${info.total}] Exporting #${info.channelName} [${info.channelType}]...`
          );
        } else if (info.step === 'skipped_channel') {
          logger.log(
            `  -> [Skipped] #${info.channelName}: ${info.reason}`
          );
        }
      },
    });

    logger.log(
      `[Export] Completed! Saved ${exportBundle.totalMessages} messages across ${exportBundle.totalChannels} active channels for "${exportBundle.guildName}" to ${exportFilePath}`
    );

    if (exportOnly) {
      return {
        exitCode: 0,
        mode: 'export',
        exportBundle,
        exportFilePath,
      };
    }
  } else {
    // Phase 2 only (--report): no Discord token or Discord REST calls
    let raw;
    try {
      raw = await fs.readFile(exportFilePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        logger.error(
          `[Error] Could not find an existing export at ${exportFilePath}. Run "npm run export-server" first, or run "npm run demo" for an offline sample.`
        );
      } else {
        logger.error(
          `[Error] Failed to read export file at ${exportFilePath}: ${err?.message || err}`
        );
      }
      return { exitCode: 1, mode: 'report' };
    }

    try {
      exportBundle = JSON.parse(raw);
    } catch (err) {
      logger.error(
        `[Error] Invalid or corrupted JSON in ${exportFilePath}: ${err?.message || err}. Fix or replace the JSON file before running "npm run generate-report".`
      );
      return { exitCode: 1, mode: 'report' };
    }

    if (!exportBundle || typeof exportBundle !== 'object' || !Array.isArray(exportBundle.channels)) {
      logger.error(
        `[Error] Invalid export schema in ${exportFilePath}: expected a JSON object with a "channels" array.`
      );
      return { exitCode: 1, mode: 'report' };
    }

    logger.log(
      `[Report] Loaded existing server export from ${exportFilePath} (${exportBundle.totalMessages ?? 0} messages across ${exportBundle.totalChannels ?? exportBundle.channels.length} channels).`
    );
  }

  // Phase 2: Generate per-channel & master Markdown reports with DeepSeek (or fallback)
  logger.log(
    `\n[Analyzer] Running ${activeConfig.report.lookbackDays}-day Map-Reduce support analysis with ${activeConfig.llm.provider.toUpperCase()} (${activeConfig.llm.model})...`
  );

  const reportResult = await generateServerSupportReport(exportBundle, {
    chunkSize: activeConfig.report.chunkSize,
    reportOutputPath: reportFilePath,
    channelReportsDir,
    llmConfig: activeConfig.llm,
    fetchImpl,
    onProgress: (info) => {
      if (info.step === 'analyzing_channel') {
        logger.log(
          `  -> [${info.current}/${info.total}] Summarizing channel #${info.channelName}...`
        );
      } else if (info.step === 'synthesizing_master_report') {
        logger.log(
          '  -> Synthesizing executive cross-channel meeting report...'
        );
      }
    },
  });

  logger.log('\n======================================================================');
  logger.log(` Master Report Saved To      : ${reportResult.reportPath}`);
  if (reportResult.channelReportPaths?.length > 0) {
    logger.log(
      ` Per-Channel Reports (${reportResult.channelReportPaths.length}) : ${channelReportsDir}`
    );
  }
  logger.log(` AI Engine Used              : ${reportResult.providerUsed}`);
  logger.log('======================================================================\n');

  if (printReport) {
    logger.log(reportResult.markdownReport);
  }

  return {
    exitCode: 0,
    mode: reportOnly ? 'report' : 'full',
    exportBundle,
    reportResult,
  };
}

const isMainModule =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  runAnalyzeServerCli()
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error('[Fatal Error]', error);
      process.exitCode = 1;
    });
}
