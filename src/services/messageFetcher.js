/**
 * Fetches and normalizes messages from a Discord text channel within a time window.
 */

const DISCORD_EPOCH = 1420070400000;

/**
 * Extracts a Unix timestamp (ms) from a Discord Snowflake ID if valid.
 *
 * @param {string|number} snowflake
 * @returns {number|null}
 */
function snowflakeIdToTimestampMs(snowflake) {
  if (snowflake === null || snowflake === undefined) return null;
  const s = String(snowflake).trim();
  if (!/^\d+$/.test(s)) return null;
  try {
    const big = BigInt(s);
    if (big < 4194304n) return null;
    return Number((big >> 22n) + BigInt(DISCORD_EPOCH));
  } catch {
    return null;
  }
}

/**
 * Normalizes a raw Discord REST v10 or Discord.js message object into a clean structure.
 *
 * @param {object} msg - Discord message object
 * @returns {object|null} Normalized message or null if it should be skipped
 */
export function normalizeMessage(msg) {
  if (!msg) return null;
  if (msg.author?.bot) return null;

  const content = (msg.cleanContent ?? msg.content ?? '').trim();
  const rawAttachments = msg.attachments
    ? Array.from(msg.attachments.values?.() ?? msg.attachments)
    : [];
  const attachmentNames = rawAttachments
    .filter(Boolean)
    .map((a) => (typeof a === 'string' ? a : a.name || a.filename || 'attachment'));

  if (!content && attachmentNames.length === 0) {
    return null;
  }

  const authorName =
    msg.member?.displayName ||
    msg.member?.nick ||
    msg.author?.globalName ||
    msg.author?.global_name ||
    msg.author?.username ||
    (typeof msg.author === 'string' ? msg.author : '') ||
    'Unknown User';

  let timestamp;
  if (typeof msg.createdTimestamp === 'number' && Number.isFinite(msg.createdTimestamp)) {
    timestamp = new Date(msg.createdTimestamp);
  } else if (msg.createdAt instanceof Date) {
    timestamp = msg.createdAt;
  } else if (msg.timestamp instanceof Date) {
    timestamp = msg.timestamp;
  } else if (typeof msg.timestamp === 'string' || typeof msg.timestamp === 'number') {
    const parsed = new Date(msg.timestamp);
    timestamp = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  } else {
    const sfMs = snowflakeIdToTimestampMs(msg.id);
    timestamp = sfMs !== null ? new Date(sfMs) : new Date();
  }

  return {
    id: msg.id || String(timestamp.getTime()),
    author: authorName,
    content: content || `[Attached: ${attachmentNames.join(', ')}]`,
    attachments: attachmentNames,
    timestamp,
  };
}

/**
 * Formats normalized messages into a chronological transcript for LLM consumption,
 * plus computes quick participation statistics.
 *
 * @param {Array<object>} messages - Array of normalized messages (chronological)
 * @param {object} [options]
 * @param {boolean} [options.includeAuthors=true] - Whether to include speaker names in transcript lines
 * @param {Function} [options.contentFormatter] - Optional sanitizer for message content
 * @returns {{ transcript: string, stats: { totalMessages: number, participants: Array<{author: string, count: number}>, timeframeStart: Date|null, timeframeEnd: Date|null } }}
 */
export function buildTranscriptAndStats(
  messages = [],
  { includeAuthors = true, contentFormatter } = {}
) {
  const windowMessages = (messages || []).filter((m) => m && !m.contextOnly);
  const withDates = windowMessages.map((m) => ({
    ...m,
    timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp),
  }));
  const sorted = [...withDates].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const countsByAuthor = new Map();
  const lines = [];
  const countableMessages = [];

  for (const msg of sorted) {
    if (!msg.continuationPart) {
      countableMessages.push(msg);
      countsByAuthor.set(msg.author, (countsByAuthor.get(msg.author) || 0) + 1);
    }
    const timeStr = msg.timestamp.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const rawContent = String(msg.content || '');
    const formattedContent =
      typeof contentFormatter === 'function' ? contentFormatter(rawContent, msg) : rawContent;
    const attachmentSuffix =
      msg.attachments && msg.attachments.length > 0 && !rawContent.startsWith('[Attached:')
        ? ` [Attachments: ${msg.attachments.join(', ')}]`
        : '';
    if (includeAuthors) {
      lines.push(`[${timeStr}] ${msg.author}: ${formattedContent}${attachmentSuffix}`);
    } else {
      lines.push(`[${timeStr}] ${formattedContent}${attachmentSuffix}`);
    }
  }

  const participants = Array.from(countsByAuthor.entries())
    .map(([author, count]) => ({ author, count }))
    .sort((a, b) => b.count - a.count);

  const timeRef = countableMessages.length > 0 ? countableMessages : sorted;

  return {
    transcript: lines.join('\n'),
    stats: {
      totalMessages: countableMessages.length,
      participants,
      timeframeStart: timeRef.length > 0 ? timeRef[0].timestamp : null,
      timeframeEnd: timeRef.length > 0 ? timeRef[timeRef.length - 1].timestamp : null,
    },
  };
}

/**
 * Fetches messages from a Discord channel going back `hours` hours (up to `maxMessages`).
 *
 * @param {object} channel - Discord.js TextBasedChannel
 * @param {object} options
 * @param {number} options.hours - Lookback window in hours
 * @param {number} options.maxMessages - Maximum number of messages to inspect
 * @param {string} [options.topicFilter] - Optional keyword filter
 * @returns {Promise<Array<object>>} Chronological array of normalized messages
 */
export async function fetchChannelMessages(channel, { hours = 24, maxMessages = 200, topicFilter = '' } = {}) {
  const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
  const effectiveMax = maxMessages && maxMessages > 0 ? maxMessages : Number.POSITIVE_INFINITY;
  const collected = [];
  let lastId;
  let reachedCutoff = false;

  while (collected.length < effectiveMax && !reachedCutoff) {
    const fetchLimit = Number.isFinite(effectiveMax)
      ? Math.min(100, effectiveMax - collected.length)
      : 100;
    const options = { limit: fetchLimit };
    if (lastId) {
      options.before = lastId;
    }

    const batch = await channel.messages.fetch(options);
    if (!batch || batch.size === 0) {
      break;
    }

    for (const msg of batch.values()) {
      if (msg.createdTimestamp < cutoffTime) {
        reachedCutoff = true;
        break;
      }

      const normalized = normalizeMessage(msg);
      if (normalized) {
        if (topicFilter) {
          const keyword = topicFilter.toLowerCase();
          if (!normalized.content.toLowerCase().includes(keyword)) {
            continue;
          }
        }
        collected.push(normalized);
      }
    }

    lastId = batch.last()?.id;
    if (!lastId || batch.size < fetchLimit) {
      break;
    }
  }

  return collected.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}
