import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DiscordChannelType,
  fetchChannelMessagesRest,
  fetchForumPostsRest,
  fetchGuildChannels,
  fetchGuildInfo,
  isExplicitInaccessibleError,
} from './discordUserClient.js';

const ChannelType = DiscordChannelType;

const PermissionFlagsBits = {
  ViewChannel: 1n << 10n,
  ReadMessageHistory: 1n << 16n,
};

/**
 * Sanitizes a channel or server name for safe filesystem usage.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeName(name) {
  return (name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'channel';
}

/**
 * Writes a JSON file atomically by writing to a temporary file in the same directory
 * and renaming it over the target path.
 *
 * @param {string} filePath
 * @param {any} data
 */
async function writeJsonFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2, 8)}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  try {
    await fs.writeFile(tmpPath, payload, 'utf8');
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    try {
      await fs.rm(tmpPath, { force: true });
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

function isInaccessibleChannelError(err) {
  return isExplicitInaccessibleError(err);
}

const OWNED_CHANNEL_FILE_PATTERN = /^[a-z0-9-_]+-\d+\.json$/;
const OWNED_ATOMIC_TMP_FILE_PATTERN =
  /^(?:server-export\.json|[a-z0-9-_]+-[a-z0-9-_]+\.json)\.\d+\.\d+-[0-9a-f]+\.tmp$/;

/**
 * Checks whether a channel matches any entry in a list of channel IDs or names
 * (supports emoji-prefixed names like "💬-chat" matching "chat").
 *
 * @param {object} channel
 * @param {Array<string>} filterList
 * @returns {boolean}
 */
export function matchesChannelFilter(channel, filterList = []) {
  if (!channel || !Array.isArray(filterList) || filterList.length === 0) {
    return false;
  }

  const channelId = String(channel.id || '').toLowerCase();
  const rawName = String(channel.name || '').toLowerCase();
  const cleanName = sanitizeName(rawName);

  return filterList.some((entry) => {
    const target = String(entry || '').trim().toLowerCase();
    if (!target) return false;
    const cleanTarget = sanitizeName(target);
    return (
      channelId === target ||
      rawName === target ||
      cleanName === cleanTarget ||
      rawName.includes(target) ||
      (cleanTarget && cleanName.includes(cleanTarget))
    );
  });
}

/**
 * Classifies a Discord channel or exported channel record into:
 * - `'forum'`: Discord Forum channel (where each topic/question is a post/thread)
 * - `'qa'`: Text channel dedicated to questions, help, support, FAQ, or bug reports
 * - `'chat'`: Normal discussion / community chat channel
 *
 * @param {object} channelOrRecord
 * @param {Array<string>} [qaPatterns]
 * @returns {'forum'|'qa'|'chat'}
 */
export function classifyChannelType(
  channelOrRecord,
  qaPatterns = config.report.qaChannelPatterns
) {
  if (!channelOrRecord) return 'chat';

  if (
    channelOrRecord.channelType === 'forum' ||
    channelOrRecord.type === ChannelType.GuildForum ||
    (Array.isArray(channelOrRecord.posts) && channelOrRecord.posts.length > 0)
  ) {
    return 'forum';
  }

  if (channelOrRecord.channelType === 'qa') {
    return 'qa';
  }

  if (channelOrRecord.channelType === 'chat') {
    return 'chat';
  }

  const rawName = String(channelOrRecord.channelName || channelOrRecord.name || '').toLowerCase();
  const cleanName = sanitizeName(rawName);
  const tokens = new Set(cleanName.split('-').filter(Boolean));

  const patterns = Array.isArray(qaPatterns) ? qaPatterns : [];
  for (const pattern of patterns) {
    const p = String(pattern || '').trim().toLowerCase();
    if (!p) continue;
    if (tokens.has(p) || cleanName === p || rawName.includes(p)) {
      return 'qa';
    }
  }

  return 'chat';
}

/**
 * Determines whether a guild channel is a readable text or forum channel that should be included
 * in the full-server support export.
 *
 * @param {object} channel - Discord REST v10 channel object
 * @param {object} [botMember=null] - Optional member for permission checks
 * @param {Array<string>} [excludeList=[]] - Lowercase channel names or IDs to skip
 * @param {Array<string>} [includeList=[]] - Optional allowlist of channel names or IDs
 * @returns {boolean}
 */
export function isExportableChannel(
  channel,
  botMember = null,
  excludeList = [],
  includeList = []
) {
  if (!channel) return false;

  if (matchesChannelFilter(channel, excludeList)) {
    return false;
  }

  if (Array.isArray(includeList) && includeList.length > 0) {
    if (!matchesChannelFilter(channel, includeList)) {
      return false;
    }
  }

  const isForum =
    channel.channelType === 'forum' ||
    channel.type === ChannelType.GuildForum;

  const supportedTextTypes = new Set([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.AnnouncementThread,
  ]);

  const hasValidTextType = supportedTextTypes.has(channel.type);
  const hasValidForumType = isForum;

  if (!hasValidTextType && !hasValidForumType) {
    return false;
  }

  if (botMember && typeof channel.permissionsFor === 'function') {
    const perms = channel.permissionsFor(botMember);
    if (
      perms &&
      (!perms.has(PermissionFlagsBits.ViewChannel) ||
        !perms.has(PermissionFlagsBits.ReadMessageHistory))
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Lists and classifies channels in a Discord server via REST API v10 (or from a channel list).
 *
 * @param {string|object} guildOrId - Guild ID string or guild object
 * @param {object} [options]
 * @returns {Promise<Array<{ id: string, name: string, type: number, channelType: 'forum'|'qa'|'chat', categoryName: string, exportable: boolean }>>}
 */
export async function listGuildChannels(
  guildOrId,
  {
    token = config.discord.userToken,
    excludeChannels = config.report.excludeChannels,
    includeChannels = config.report.includeChannels,
    qaChannelPatterns = config.report.qaChannelPatterns,
    fetchImpl = globalThis.fetch,
    maxRetries = 3,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    sleepImpl,
  } = {}
) {
  const guildId =
    typeof guildOrId === 'string'
      ? guildOrId.trim()
      : String(guildOrId?.id || guildOrId?.guildId || config.discord.guildId || '').trim();

  const rawChannels =
    guildOrId && typeof guildOrId === 'object' && Array.isArray(guildOrId.channels)
      ? guildOrId.channels
      : await fetchGuildChannels(guildId, {
          token,
          fetchImpl,
          maxRetries,
          maxRetryAfterMs,
          retryBaseDelayMs,
          sleepImpl,
        });

  const categoryMap = new Map();
  for (const ch of rawChannels) {
    if (ch && ch.type === ChannelType.GuildCategory && ch.id) {
      categoryMap.set(String(ch.id), ch.name || 'Uncategorized');
    }
  }

  return rawChannels
    .filter((ch) => ch && ch.type !== ChannelType.GuildCategory)
    .map((ch) => {
      const parentId = ch.parent_id ?? ch.parentId ?? ch.parent?.id;
      const categoryName =
        ch.parent?.name ||
        ch.categoryName ||
        (parentId ? categoryMap.get(String(parentId)) : null) ||
        'Uncategorized';
      return {
        id: String(ch.id),
        name: ch.name,
        type: ch.type,
        channelType: classifyChannelType(ch, qaChannelPatterns),
        categoryName,
        exportable: isExportableChannel(ch, null, excludeChannels, includeChannels),
      };
    });
}

/**
 * Fetches all forum posts (active + archived threads) and their messages from a Discord Forum channel
 * within the specified lookback window in hours via Discord REST API v10.
 *
 * @param {object} forumChannel - Forum channel object
 * @param {object} [options]
 * @returns {Promise<{ posts: Array<object>, messages: Array<object>, truncated: boolean, inaccessibleThreadCount: number, budgetSkippedThreadCount: number }>}
 */
export async function fetchForumChannelPosts(
  forumChannel,
  {
    hours = 24 * 90,
    maxMessagesPerChannel = 5000,
    guildId = '',
    token = config.discord.userToken,
    requestDelayMs = config.discord.requestDelayMs,
    maxRetries = 3,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    fetchImpl = globalThis.fetch,
    sleepImpl,
  } = {}
) {
  const resolvedGuildId =
    guildId || forumChannel?.guild_id || forumChannel?.guildId || config.discord.guildId;
  return fetchForumPostsRest(resolvedGuildId, forumChannel, {
    token,
    hours,
    maxMessagesPerChannel,
    requestDelayMs,
    maxRetries,
    maxRetryAfterMs,
    retryBaseDelayMs,
    fetchImpl,
    sleepImpl,
  });
}

/**
 * Exports all readable text and forum channels from a Discord server over the specified
 * lookback period (defaults to 90 days / 3 months) using Discord REST API v10.
 *
 * Inaccessible channels (explicit Discord codes `50001`, `50013`, or `10003`) are skipped with a
 * warning and recorded in `skippedChannels`. Every other error, including route-level 403/404 responses
 * without those codes, authentication (`401`), rate-limit (`429`), and server (`5xx`) errors fail hard
 * without writing partial exports.
 *
 * Saves individual channel JSON files and `server-export.json` atomically (`*.tmp` + `fs.rename`)
 * inside `outputDir` only after all channel exports succeed.
 *
 * Caution: Automating personal user tokens violates Discord's Terms of Service and is not
 * officially supported or guaranteed by Discord.
 *
 * @param {string|object} [guildOrId] - Guild ID string, REST guild object, or options object
 * @param {object} [options]
 * @returns {Promise<object>} Exported server dataset
 */
export async function exportGuildHistory(guildOrId, options = {}) {
  let targetGuild = guildOrId;
  let opts = options || {};

  if (
    guildOrId &&
    typeof guildOrId === 'object' &&
    !('channels' in guildOrId) &&
    !('name' in guildOrId) &&
    ('guildId' in guildOrId || 'token' in guildOrId || 'days' in guildOrId || 'fetchImpl' in guildOrId)
  ) {
    opts = guildOrId;
    targetGuild = opts.guildId || config.discord.guildId;
  }

  const {
    token = config.discord.userToken,
    days = config.report.lookbackDays,
    maxMessagesPerChannel = config.report.maxMessagesPerChannel,
    excludeChannels = config.report.excludeChannels,
    includeChannels = config.report.includeChannels,
    qaChannelPatterns = config.report.qaChannelPatterns,
    outputDir = path.join(config.report.dataDir, 'exports'),
    requestDelayMs = config.discord.requestDelayMs,
    maxRetries = 3,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    retryBaseDelayMs = requestDelayMs === 0 ? 0 : DEFAULT_RETRY_BASE_DELAY_MS,
    fetchImpl = globalThis.fetch,
    sleepImpl,
    onProgress = () => {},
  } = opts;

  const hours = days * 24;

  const guildId =
    typeof targetGuild === 'string'
      ? targetGuild.trim()
      : String(targetGuild?.id || targetGuild?.guildId || opts.guildId || config.discord.guildId || '').trim();

  if (!guildId) {
    throw new Error('guildId (or DISCORD_GUILD_ID) is required to export server history.');
  }

  let guildName = '';
  if (targetGuild && typeof targetGuild === 'object' && targetGuild.name) {
    guildName = targetGuild.name;
  } else if (opts.guildName) {
    guildName = opts.guildName;
  } else {
    try {
      const guildInfo = await fetchGuildInfo(guildId, {
        token,
        fetchImpl,
        maxRetries,
        maxRetryAfterMs,
        retryBaseDelayMs,
        sleepImpl,
      });
      guildName = guildInfo?.name || `Guild ${guildId}`;
    } catch (err) {
      if (err && (err.status === 404 || err.status === 403)) {
        guildName = `Guild ${guildId}`;
      } else {
        throw err;
      }
    }
  }

  const allChannels =
    targetGuild && typeof targetGuild === 'object' && Array.isArray(targetGuild.channels)
      ? targetGuild.channels
      : await fetchGuildChannels(guildId, {
          token,
          fetchImpl,
          maxRetries,
          maxRetryAfterMs,
          retryBaseDelayMs,
          sleepImpl,
        });

  const categoryMap = new Map();
  for (const ch of allChannels) {
    if (ch && ch.type === ChannelType.GuildCategory && ch.id) {
      categoryMap.set(String(ch.id), ch.name || 'Uncategorized');
    }
  }

  const rawChannels = allChannels.filter((ch) =>
    isExportableChannel(ch, null, excludeChannels, includeChannels)
  );

  const exportedChannels = [];
  const skippedChannels = [];
  let totalMessagesExported = 0;

  for (let i = 0; i < rawChannels.length; i++) {
    const channel = rawChannels[i];
    const parentId = channel.parent_id ?? channel.parentId ?? channel.parent?.id;
    const categoryName =
      channel.parent?.name ||
      channel.categoryName ||
      (parentId ? categoryMap.get(String(parentId)) : null) ||
      'Uncategorized';
    const channelType = classifyChannelType(channel, qaChannelPatterns);

    onProgress({
      step: 'fetching_channel',
      current: i + 1,
      total: rawChannels.length,
      channelName: channel.name,
      channelType,
    });

    const isForumChannel =
      channelType === 'forum' || channel.type === ChannelType.GuildForum;

    let serializedMessages = [];
    let forumPosts = [];
    let channelTruncated = false;
    let inaccessibleThreadCount = 0;
    let budgetSkippedThreadCount = 0;

    try {
      if (isForumChannel) {
        const forumData = await fetchForumChannelPosts(channel, {
          hours,
          maxMessagesPerChannel,
          guildId,
          token,
          requestDelayMs,
          maxRetries,
          maxRetryAfterMs,
          retryBaseDelayMs,
          fetchImpl,
          sleepImpl,
        });
        forumPosts = forumData.posts;
        serializedMessages = forumData.messages;
        channelTruncated = Boolean(forumData.truncated);
        inaccessibleThreadCount = forumData.inaccessibleThreadCount || 0;
        budgetSkippedThreadCount = forumData.budgetSkippedThreadCount || 0;
      } else {
        const messages = await fetchChannelMessagesRest(channel.id, {
          token,
          hours,
          maxMessages: maxMessagesPerChannel,
          requestDelayMs,
          maxRetries,
          maxRetryAfterMs,
          retryBaseDelayMs,
          fetchImpl,
          sleepImpl,
        });

        channelTruncated = Boolean(messages.truncated);
        serializedMessages = messages.map((m) => ({
          id: m.id,
          author: m.author,
          content: m.content,
          attachments: m.attachments || [],
          timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
        }));
      }
    } catch (channelErr) {
      if (isInaccessibleChannelError(channelErr)) {
        const skipRecord = {
          channelId: String(channel.id),
          channelName: channel.name,
          categoryName,
          channelType,
          status: channelErr.status ?? null,
          code: channelErr.code ?? null,
          reason: channelErr.message,
        };
        skippedChannels.push(skipRecord);
        console.warn(
          `[Export] Skipping inaccessible channel #${channel.name} (${channel.id}): ${channelErr.message}`
        );
        onProgress({
          step: 'skipped_channel',
          ...skipRecord,
        });
        continue;
      }
      throw channelErr;
    }

    if (channelTruncated) {
      console.warn(
        `[Export] #${channel.name} truncated at the message budget (${serializedMessages.length} messages kept` +
          (isForumChannel ? `, ${budgetSkippedThreadCount} post(s) not exported` : '') +
          '). Raise REPORT_MAX_MESSAGES_PER_CHANNEL (0 = unlimited) to export more.'
      );
    }
    if (inaccessibleThreadCount > 0) {
      console.warn(
        `[Export] #${channel.name}: ${inaccessibleThreadCount} inaccessible post(s) were skipped.`
      );
    }

    const channelRecord = {
      channelId: String(channel.id),
      channelName: channel.name,
      categoryName,
      channelType,
      postCount: forumPosts.length,
      messageCount: serializedMessages.length,
      truncated: channelTruncated,
      ...(isForumChannel
        ? { inaccessibleThreadCount, budgetSkippedThreadCount }
        : {}),
      timeframeStart: serializedMessages[0]?.timestamp || null,
      timeframeEnd: serializedMessages[serializedMessages.length - 1]?.timestamp || null,
      ...(isForumChannel || forumPosts.length > 0 ? { posts: forumPosts } : {}),
      messages: serializedMessages,
    };

    exportedChannels.push(channelRecord);
    totalMessagesExported += serializedMessages.length;
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const exportBundle = {
    guildId,
    guildName,
    exportedAt: now.toISOString(),
    lookbackDays: days,
    timeframeStart: windowStart.toISOString(),
    timeframeEnd: now.toISOString(),
    totalChannels: exportedChannels.length,
    totalMessages: totalMessagesExported,
    skippedChannels,
    channels: exportedChannels,
  };

  if (outputDir) {
    await fs.mkdir(outputDir, { recursive: true });
    const writtenChannelFiles = new Set();

    for (const channelRecord of exportedChannels) {
      const safeChannelFile = `${sanitizeName(channelRecord.channelName)}-${channelRecord.channelId}.json`;
      writtenChannelFiles.add(safeChannelFile);
      await writeJsonFileAtomic(path.join(outputDir, safeChannelFile), channelRecord);
    }

    // Write master bundle atomically last
    const bundlePath = path.join(outputDir, 'server-export.json');
    await writeJsonFileAtomic(bundlePath, exportBundle);

    // Clean up stale owned per-channel JSON files (`<name>-<snowflake>.json`) or leftover atomic temp files
    try {
      const existingEntries = await fs.readdir(outputDir, { withFileTypes: true });
      for (const entry of existingEntries) {
        if (!entry.isFile()) continue;
        if (entry.name === 'server-export.json') continue;
        if (writtenChannelFiles.has(entry.name)) continue;
        if (
          OWNED_CHANNEL_FILE_PATTERN.test(entry.name) ||
          OWNED_ATOMIC_TMP_FILE_PATTERN.test(entry.name)
        ) {
          await fs.rm(path.join(outputDir, entry.name), { force: true });
        }
      }
    } catch {
      // Ignore directory cleanup errors
    }
  }

  return exportBundle;
}
