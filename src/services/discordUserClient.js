import { config } from '../config.js';
import { normalizeMessage } from './messageFetcher.js';

/**
 * Direct Discord REST API v10 client for read-only exports using a personal user token.
 *
 * Caution: Automating personal Discord user accounts (self-bots) violates Discord's Terms
 * of Service, is not officially supported or guaranteed by Discord, and carries security
 * and account-suspension risks. Use strictly for read-only analysis with polite rate pacing.
 */

export const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
export const DISCORD_EPOCH = 1420070400000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;

export const DiscordChannelType = {
  GuildText: 0,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
  GuildForum: 15,
};

const PLACEHOLDER_TOKENS = new Set([
  'your_discord_user_token_here',
  'your_discord_bot_token_here',
]);

const ALLOWED_DISCORD_API_ORIGINS = [
  'https://discord.com/api/',
  'https://canary.discord.com/api/',
  'https://ptb.discord.com/api/',
];

function defaultSleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Converts a Discord Snowflake ID to a Unix timestamp in milliseconds.
 * Returns `null` if the ID is not a valid Discord Snowflake.
 *
 * @param {string|number|bigint} snowflake
 * @returns {number|null}
 */
export function snowflakeToTimestamp(snowflake) {
  if (snowflake === null || snowflake === undefined) return null;
  const raw = String(snowflake).trim();
  if (!/^\d+$/.test(raw)) return null;
  try {
    const big = BigInt(raw);
    if (big < 4194304n) return null;
    return Number((big >> 22n) + BigInt(DISCORD_EPOCH));
  } catch {
    return null;
  }
}

/**
 * Converts a Unix timestamp in milliseconds (or Date) to a Discord Snowflake ID string.
 *
 * @param {number|Date} timestampMs
 * @returns {string}
 */
export function timestampToSnowflake(timestampMs) {
  const ms = timestampMs instanceof Date ? timestampMs.getTime() : Number(timestampMs);
  if (!Number.isFinite(ms) || ms <= DISCORD_EPOCH) {
    return '0';
  }
  return ((BigInt(Math.floor(ms) - DISCORD_EPOCH)) << 22n).toString();
}

/**
 * Resolves a `maxMessages` option where `0` means unlimited within the lookback window.
 *
 * @param {number|string|undefined|null} value
 * @param {number} defaultLimit
 * @returns {number} Positive integer limit or `Number.POSITIVE_INFINITY`
 */
export function resolveMaxMessagesLimit(value, defaultLimit = config.report.maxMessagesPerChannel) {
  let target = defaultLimit;
  if (value !== undefined && value !== null && String(value).trim() !== '') {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      target = parsed;
    }
  }
  if (target === 0 || !Number.isFinite(target) || target < 0) {
    return Number.POSITIVE_INFINITY;
  }
  return target;
}

/**
 * Extracts a retry delay in milliseconds from a 429 or 202 HTTP response
 * (inspecting both HTTP headers and JSON body).
 *
 * @param {object} response
 * @param {object|null} bodyData
 * @param {number} [defaultSeconds=1]
 * @returns {number} Delay in milliseconds
 */
export function extractRetryAfterMs(response, bodyData, defaultSeconds = 1) {
  let headerRaw = null;
  const headers = response?.headers;
  if (headers) {
    if (typeof headers.get === 'function') {
      headerRaw =
        headers.get('retry-after') ??
        headers.get('Retry-After') ??
        headers.get('x-ratelimit-reset-after');
    } else if (typeof headers === 'object') {
      headerRaw =
        headers['retry-after'] ??
        headers['Retry-After'] ??
        headers['x-ratelimit-reset-after'] ??
        headers['X-RateLimit-Reset-After'];
    }
  }

  const headerVal =
    headerRaw !== null && headerRaw !== undefined && String(headerRaw).trim() !== ''
      ? Number.parseFloat(String(headerRaw).trim())
      : Number.NaN;

  const bodyRaw = bodyData?.retry_after ?? bodyData?.retryAfter;
  const bodyVal =
    bodyRaw !== null && bodyRaw !== undefined && String(bodyRaw).trim() !== ''
      ? Number.parseFloat(String(bodyRaw).trim())
      : Number.NaN;

  let retrySeconds = Number.NaN;
  if (Number.isFinite(headerVal) && headerVal >= 0 && Number.isFinite(bodyVal) && bodyVal >= 0) {
    retrySeconds = Math.max(headerVal, bodyVal);
  } else if (Number.isFinite(headerVal) && headerVal >= 0) {
    retrySeconds = headerVal;
  } else if (Number.isFinite(bodyVal) && bodyVal >= 0) {
    retrySeconds = bodyVal;
  }

  if (!Number.isFinite(retrySeconds) || retrySeconds < 0) {
    retrySeconds = defaultSeconds;
  }

  return Math.max(0, Math.ceil(retrySeconds * 1000));
}

async function readResponseJsonOrText(response) {
  let bodyData = null;
  let rawText = '';
  if (typeof response?.text === 'function') {
    try {
      rawText = await response.text();
      if (rawText) {
        try {
          bodyData = JSON.parse(rawText);
        } catch {
          bodyData = null;
        }
      }
    } catch {
      rawText = '';
    }
  } else if (typeof response?.json === 'function') {
    try {
      bodyData = await response.json();
      rawText = bodyData ? JSON.stringify(bodyData) : '';
    } catch {
      bodyData = null;
    }
  }
  return { bodyData, rawText };
}

/**
 * Performs a read-only GET request against Discord REST API v10 using a personal user token,
 * with automatic `HTTP 429` (`Retry-After` header and JSON `retry_after` body) and `HTTP 202`
 * backoff, upper-bounded wait times (`maxRetryAfterMs`), and bounded transient 5xx/network retries.
 *
 * @param {string} endpoint - Relative path (e.g., `/users/@me/guilds`) or Discord API v10 URL
 * @param {object} [options]
 * @param {string} [options.token]
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.maxRetries=3]
 * @param {number} [options.maxRetryAfterMs=60000]
 * @param {number} [options.retryBaseDelayMs=500]
 * @param {Function} [options.sleepImpl]
 * @returns {Promise<any>}
 */
export async function discordRestGet(
  endpoint,
  {
    token = config.discord.userToken,
    fetchImpl = globalThis.fetch,
    maxRetries = 3,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    sleepImpl = defaultSleep,
  } = {}
) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken || PLACEHOLDER_TOKENS.has(cleanToken)) {
    throw new Error(
      'Missing or placeholder DISCORD_USER_TOKEN. Configure a valid token before calling Discord REST API v10.'
    );
  }

  const rawEndpoint = String(endpoint || '').trim();
  let url;
  if (rawEndpoint.startsWith('http://') || rawEndpoint.startsWith('https://')) {
    const isAllowedOrigin = ALLOWED_DISCORD_API_ORIGINS.some((origin) =>
      rawEndpoint.toLowerCase().startsWith(origin)
    );
    if (!isAllowedOrigin) {
      throw new Error(
        `Refusing to send Discord user token to non-Discord API URL: ${rawEndpoint}`
      );
    }
    url = rawEndpoint;
  } else {
    url = `${DISCORD_API_BASE_URL}${rawEndpoint.startsWith('/') ? '' : '/'}${rawEndpoint}`;
  }

  const retryLimit = Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 3;
  const effectiveMaxWaitMs =
    Number.isFinite(maxRetryAfterMs) && maxRetryAfterMs >= 0
      ? maxRetryAfterMs
      : DEFAULT_MAX_RETRY_AFTER_MS;
  const effectiveBaseDelayMs =
    Number.isFinite(retryBaseDelayMs) && retryBaseDelayMs >= 0
      ? retryBaseDelayMs
      : DEFAULT_RETRY_BASE_DELAY_MS;

  for (let attempt = 0; attempt <= retryLimit; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: cleanToken,
          Accept: 'application/json',
        },
      });
    } catch (networkErr) {
      if (attempt >= retryLimit) {
        const err = new Error(
          `Discord REST network error on ${rawEndpoint} after ${retryLimit} retries: ${networkErr?.message || String(networkErr)}`,
          { cause: networkErr }
        );
        err.endpoint = rawEndpoint;
        throw err;
      }
      const backoffMs = Math.min(
        effectiveMaxWaitMs,
        Math.ceil(effectiveBaseDelayMs * Math.pow(2, attempt))
      );
      await sleepImpl(backoffMs);
      continue;
    }

    if (response.status === 429) {
      const { bodyData } = await readResponseJsonOrText(response);
      const waitMs = extractRetryAfterMs(response, bodyData, 1);
      const isGlobal = Boolean(
        bodyData?.global ||
          (typeof response.headers?.get === 'function' &&
            response.headers.get('x-ratelimit-global') === 'true') ||
          response.headers?.['x-ratelimit-global'] === 'true'
      );

      if (waitMs > effectiveMaxWaitMs) {
        const err = new Error(
          `Discord API rate limit retry_after (${(waitMs / 1000).toFixed(1)}s${isGlobal ? ', global' : ''}) on ${rawEndpoint} exceeds maximum allowed wait of ${(effectiveMaxWaitMs / 1000).toFixed(1)}s.`
        );
        err.status = 429;
        err.retryAfterMs = waitMs;
        err.global = isGlobal;
        err.endpoint = rawEndpoint;
        throw err;
      }

      if (attempt >= retryLimit) {
        const err = new Error(
          `Discord API rate limit exceeded (HTTP 429${isGlobal ? ', global' : ''}) on ${rawEndpoint} after ${retryLimit} retries.`
        );
        err.status = 429;
        err.retryAfterMs = waitMs;
        err.global = isGlobal;
        err.endpoint = rawEndpoint;
        throw err;
      }

      await sleepImpl(waitMs);
      continue;
    }

    if (response.status === 202) {
      const { bodyData } = await readResponseJsonOrText(response);
      const waitMs = extractRetryAfterMs(response, bodyData, 1);

      if (waitMs > effectiveMaxWaitMs) {
        const err = new Error(
          `Discord API search index retry_after (${(waitMs / 1000).toFixed(1)}s) on ${rawEndpoint} exceeds maximum allowed wait of ${(effectiveMaxWaitMs / 1000).toFixed(1)}s.`
        );
        err.status = 202;
        err.code = bodyData?.code ?? null;
        err.retryAfterMs = waitMs;
        err.endpoint = rawEndpoint;
        throw err;
      }

      if (attempt >= retryLimit) {
        const err = new Error(
          `Discord API search index not ready (HTTP 202) on ${rawEndpoint} after ${retryLimit} retries.`
        );
        err.status = 202;
        err.code = bodyData?.code ?? null;
        err.retryAfterMs = waitMs;
        err.endpoint = rawEndpoint;
        throw err;
      }

      await sleepImpl(waitMs);
      continue;
    }

    if (response.status >= 500 && response.status < 600) {
      const { bodyData, rawText } = await readResponseJsonOrText(response);
      const detail = rawText || (bodyData ? JSON.stringify(bodyData) : '');

      if (attempt < retryLimit) {
        const backoffMs = Math.min(
          effectiveMaxWaitMs,
          Math.ceil(effectiveBaseDelayMs * Math.pow(2, attempt))
        );
        await sleepImpl(backoffMs);
        continue;
      }

      const err = new Error(
        `Discord REST API error ${response.status} on ${rawEndpoint} after ${retryLimit} retries${detail ? `: ${detail.slice(0, 200)}` : ''}`
      );
      err.status = response.status;
      err.code = bodyData?.code ?? null;
      err.endpoint = rawEndpoint;
      throw err;
    }

    if (!response.ok) {
      const { bodyData, rawText } = await readResponseJsonOrText(response);
      const detail = rawText || (bodyData ? JSON.stringify(bodyData) : '');
      const err = new Error(
        `Discord REST API error ${response.status} on ${rawEndpoint}${detail ? `: ${detail.slice(0, 200)}` : ''}`
      );
      err.status = response.status;
      err.code = bodyData?.code ?? null;
      err.endpoint = rawEndpoint;
      throw err;
    }

    if (typeof response.json === 'function') {
      return response.json();
    }
    if (typeof response.text === 'function') {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
    return null;
  }

  throw new Error(`Discord API request failed on ${rawEndpoint}.`);
}

/**
 * Fetches the list of Discord servers (guilds) accessible by the current user account.
 *
 * @param {object|string} [options]
 * @returns {Promise<Array<object>>}
 */
export async function fetchUserGuilds(options = {}) {
  const opts = typeof options === 'string' ? { token: options } : options;
  const guilds = await discordRestGet('/users/@me/guilds', opts);
  return Array.isArray(guilds) ? guilds : [];
}

/**
 * Fetches metadata for a specific Discord guild (`/guilds/{guildId}`).
 *
 * @param {string} guildId
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function fetchGuildInfo(guildId, options = {}) {
  const cleanGuildId = String(guildId || '').trim();
  if (!cleanGuildId) {
    throw new Error('guildId is required to fetch guild info.');
  }
  return discordRestGet(`/guilds/${cleanGuildId}`, options);
}

/**
 * Fetches all channels for a Discord guild (`/guilds/{guildId}/channels`).
 *
 * @param {string} guildId
 * @param {object} [options]
 * @returns {Promise<Array<object>>}
 */
export async function fetchGuildChannels(guildId, options = {}) {
  const cleanGuildId = String(guildId || '').trim();
  if (!cleanGuildId) {
    throw new Error('guildId is required to fetch guild channels.');
  }
  const channels = await discordRestGet(`/guilds/${cleanGuildId}/channels`, options);
  return Array.isArray(channels) ? channels : [];
}

/**
 * Extracts the creation/message timestamp in milliseconds from a raw Discord message object,
 * using explicit timestamp fields when present and falling back to decoding the Snowflake ID.
 *
 * @param {object} rawMsg
 * @returns {number|null}
 */
function extractRawMessageTimestampMs(rawMsg) {
  if (!rawMsg) return null;
  if (typeof rawMsg.createdTimestamp === 'number' && Number.isFinite(rawMsg.createdTimestamp)) {
    return rawMsg.createdTimestamp;
  }
  if (rawMsg.createdAt instanceof Date) {
    return rawMsg.createdAt.getTime();
  }
  if (rawMsg.timestamp instanceof Date) {
    return rawMsg.timestamp.getTime();
  }
  if (typeof rawMsg.timestamp === 'string' || typeof rawMsg.timestamp === 'number') {
    const parsed = new Date(rawMsg.timestamp).getTime();
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return snowflakeToTimestamp(rawMsg.id);
}

/**
 * Fetches and normalizes messages from a Discord channel via REST v10, paginating 100 messages
 * at a time using `before` Snowflake IDs and stopping at the lookback cutoff timestamp/Snowflake.
 *
 * @param {string} channelId
 * @param {object} [options]
 * @param {string} [options.token]
 * @param {number} [options.hours]
 * @param {number} [options.cutoffTime]
 * @param {number} [options.maxMessages]
 * @param {string} [options.topicFilter]
 * @param {number} [options.requestDelayMs]
 * @param {number} [options.maxRetries]
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.sleepImpl]
 * @returns {Promise<Array<object>>} Chronological array of normalized messages (oldest first)
 */
export async function fetchChannelMessagesRest(
  channelId,
  {
    token = config.discord.userToken,
    hours = config.report.lookbackDays * 24,
    cutoffTime,
    maxMessages = config.report.maxMessagesPerChannel,
    topicFilter = '',
    requestDelayMs = config.discord.requestDelayMs,
    maxRetries = 3,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    fetchImpl = globalThis.fetch,
    sleepImpl = defaultSleep,
  } = {}
) {
  const cleanChannelId = String(channelId || '').trim();
  if (!cleanChannelId) {
    throw new Error('channelId is required to fetch channel messages.');
  }

  const effectiveCutoffTime =
    typeof cutoffTime === 'number' && Number.isFinite(cutoffTime)
      ? cutoffTime
      : Date.now() - hours * 60 * 60 * 1000;
  const cutoffSnowflake = BigInt(timestampToSnowflake(effectiveCutoffTime));
  const effectiveMax = resolveMaxMessagesLimit(maxMessages);

  const collected = [];
  const knownAuthorsById = new Map();
  let beforeId = null;
  let reachedCutoff = false;
  let truncated = false;
  let starterCandidate = null;
  let pageIndex = 0;

  const recordRawAuthor = (rawMsg) => {
    if (!rawMsg || rawMsg.author?.bot) return;
    const authorId = rawMsg.author?.id ? String(rawMsg.author.id) : null;
    if (!authorId) return;
    const displayName =
      rawMsg.member?.displayName ||
      rawMsg.member?.nick ||
      rawMsg.author?.globalName ||
      rawMsg.author?.global_name ||
      rawMsg.author?.username ||
      '';
    if (displayName) {
      knownAuthorsById.set(authorId, displayName);
    }
  };

  while (collected.length < effectiveMax && !reachedCutoff) {
    if (pageIndex > 0 && requestDelayMs > 0) {
      await sleepImpl(requestDelayMs);
    }

    const query = beforeId ? `?limit=100&before=${encodeURIComponent(beforeId)}` : '?limit=100';
    const batch = await discordRestGet(`/channels/${cleanChannelId}/messages${query}`, {
      token,
      fetchImpl,
      maxRetries,
      maxRetryAfterMs,
      retryBaseDelayMs,
      sleepImpl,
    });
    pageIndex++;

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    for (const item of batch) {
      recordRawAuthor(item);
    }

    for (let idx = 0; idx < batch.length; idx++) {
      const rawMsg = batch[idx];
      const msgTimeMs = extractRawMessageTimestampMs(rawMsg);
      const isOlderByTime = msgTimeMs !== null && msgTimeMs < effectiveCutoffTime;
      const isOlderBySnowflake =
        msgTimeMs === null &&
        typeof rawMsg?.id === 'string' &&
        /^\d+$/.test(rawMsg.id) &&
        BigInt(rawMsg.id) >= 4194304n &&
        BigInt(rawMsg.id) < cutoffSnowflake;

      if (isOlderByTime || isOlderBySnowflake) {
        reachedCutoff = true;
        for (let remIdx = batch.length - 1; remIdx >= idx; remIdx--) {
          const candidate = batch[remIdx];
          if (String(candidate?.id || '') === cleanChannelId) {
            const normStarter = normalizeMessage(candidate);
            if (normStarter) {
              if (candidate?.author?.id) {
                Object.defineProperty(normStarter, 'authorId', {
                  value: String(candidate.author.id),
                  enumerable: false,
                  configurable: true,
                });
              }
              starterCandidate = normStarter;
              break;
            }
          }
        }
        break;
      }

      const normalized = normalizeMessage(rawMsg);
      if (normalized) {
        if (rawMsg?.author?.id) {
          Object.defineProperty(normalized, 'authorId', {
            value: String(rawMsg.author.id),
            enumerable: false,
            configurable: true,
          });
        }
        if (topicFilter) {
          const keyword = topicFilter.toLowerCase();
          if (!normalized.content.toLowerCase().includes(keyword)) {
            continue;
          }
        }
        collected.push(normalized);
        if (collected.length >= effectiveMax) {
          const hasMoreInBatchWithinWindow = batch.slice(idx + 1).some((rem) => {
            const remMs = extractRawMessageTimestampMs(rem);
            if (remMs !== null) return remMs >= effectiveCutoffTime;
            if (typeof rem?.id === 'string' && /^\d+$/.test(rem.id) && BigInt(rem.id) >= 4194304n) {
              return BigInt(rem.id) >= cutoffSnowflake;
            }
            return true;
          });
          if (hasMoreInBatchWithinWindow || batch.length === 100) {
            truncated = true;
          }
          break;
        }
      }
    }

    const lastRaw = batch[batch.length - 1];
    const nextBeforeId = lastRaw?.id ? String(lastRaw.id) : null;
    if (!nextBeforeId || nextBeforeId === beforeId || batch.length < 100) {
      break;
    }
    beforeId = nextBeforeId;
  }

  const sorted = collected.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  Object.defineProperty(sorted, 'truncated', {
    value: Boolean(truncated),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(sorted, 'starterMessage', {
    value: starterCandidate,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(sorted, 'knownAuthorsById', {
    value: knownAuthorsById,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return sorted;
}

/**
 * Extracts creation and last-activity timestamps (in ms) from a raw Discord thread object.
 *
 * @param {object} thread
 * @returns {{ createdMs: number|null, activityMs: number|null, hasExplicitActivity: boolean }}
 */
function extractThreadTimestampsMs(thread) {
  if (!thread) return { createdMs: null, activityMs: null, hasExplicitActivity: false };

  let createdMs = null;
  if (typeof thread.createdTimestamp === 'number' && Number.isFinite(thread.createdTimestamp)) {
    createdMs = thread.createdTimestamp;
  } else if (thread.createdAt instanceof Date) {
    createdMs = thread.createdAt.getTime();
  } else if (thread.thread_metadata?.create_timestamp) {
    const t = new Date(thread.thread_metadata.create_timestamp).getTime();
    if (Number.isFinite(t)) createdMs = t;
  } else if (thread.timestamp) {
    const t = new Date(thread.timestamp).getTime();
    if (Number.isFinite(t)) createdMs = t;
  }
  if (createdMs === null) {
    createdMs = snowflakeToTimestamp(thread.id);
  }

  let activityMs = null;
  if (typeof thread.archiveTimestamp === 'number' && Number.isFinite(thread.archiveTimestamp)) {
    activityMs = thread.archiveTimestamp;
  } else if (thread.thread_metadata?.archive_timestamp) {
    const t = new Date(thread.thread_metadata.archive_timestamp).getTime();
    if (Number.isFinite(t)) activityMs = t;
  }
  const lastMsgMs = snowflakeToTimestamp(thread.last_message_id || thread.lastMessageId);
  if (lastMsgMs !== null && (activityMs === null || lastMsgMs > activityMs)) {
    activityMs = lastMsgMs;
  }
  const hasExplicitActivity = activityMs !== null;
  if (activityMs === null) {
    activityMs = createdMs;
  }

  return { createdMs, activityMs, hasExplicitActivity };
}

const NEGATED_RESOLUTION_PATTERN =
  /\b(?:not|never|no|isn'?t|aren'?t|wasn'?t|weren'?t|didn'?t|doesn'?t|don'?t|can'?t|cannot|won'?t|still\s+not|yet\s+to\s+be|un|non[-\s]?)\s*(?:solved|resolved|fixed|answered|working|works|work|helped|resuelto|solucionado)\b|\b(?:unresolved|unsolved|unanswered|unfixed|still\s+broken|still\s+crashing|still\s+failing|still\s+having|still\s+persists|(?:does|do|did)\s+not\s+work|(?:doesn'?t|don'?t|didn'?t)\s+work|(?:does|do|did)\s+not\s+help|(?:doesn'?t|don'?t|didn'?t)\s+help|not\s+work(?:ing)?|(?:not\s+work(?:ing)?|(?:does|do|did)\s+not\s+work|(?:doesn'?t|don'?t|didn'?t)\s+work|no\s+luck|fails?|failed)\s+either|sin\s+resolver|no\s+funciona)\b/i;

const ME_TOO_OR_NOISE_REPLY_PATTERN =
  /^(?:\+1|me\s+too|same|same\s+here|same\s+issue|same\s+problem|same\s+error|i\s+have\s+the\s+same|having\s+the\s+same|also\s+(?:having|getting|experiencing|crashing|broken|failing|seeing)|bump|following|any\s+update|any\s+news)\b|\b(?:same\s+(?:here|issue|problem|error|bug|for\s+me)|me\s+too|(?:i\s+)?need\s+this\s+too|i\s+also\s+need\s+this|looking\s+for\s+this\s+too|happens\s+to\s+me\s+too|also\s+(?:crashing|broken|failing|getting\s+this)|i'?m\s+having\s+the\s+same)\b/i;

const SOLUTION_GUIDANCE_PATTERN =
  /^(?:(?:please|just|simply|yes[,!]?|yep[,!]?|sure[,!]?)\s+)*(?:try|use|set|configure|enable|disable|update|upgrade|downgrade|install|reinstall|run|execute|pass|add|remove|delete|change|replace|check|verify|ensure|restart|clear|switch|create|edit|export)\b|\b(?:you\s+(?:can|should|need\s+to|have\s+to|must)\s+\w+|try\s+(?:to\s+\w+|running|setting|updating|upgrading|downgrading|installing|reinstalling|using|adding|removing|enabling|disabling|clearing|restarting|checking|passing|changing|replacing|switching)|make\s+sure(?:\s+to|\s+you|\s+that)?|please\s+(?:try|use|set|update|upgrade|install|reinstall|check|run|configure|enable|disable|add|remove|restart|verify|ensure)\b|(?:the\s+)?workaround\s+is|as\s+a\s+workaround|the\s+(?:fix|solution)\s+is|this\s+(?:is\s+)?(?:fixed|resolved|solved)\s+(?:by|in|with)|(?:fixed|resolved|solved|supported|implemented|added)\s+in\s+(?:v?\d|version|release|latest|commit|pr|build|step)|(?:can|should|must)\s+be\s+(?:set|configured|enabled|disabled|resolved|fixed|passed|updated|upgraded|installed|run)|defaults?\s+to\s+\S+|run\s+(?:npm|node|npx|pnpm|yarn|git|docker|pip|python|cargo|mvn|gradle)\b|set\s+[A-Z0-9_]{3,}|add\s+[A-Z0-9_]{3,}\s+to|puedes\s+\w+|debes\s+\w+|intenta\s+\w+|configura\s+\w+|actualiza\s+\w+|instala\s+\w+)/i;

const SELF_SOLVED_PATTERN =
  /\b(?:i\s+(?:solved|resolved|fixed)\s+it|fixed\s+it|figured\s+it\s+out|works\s+now|working\s+now|it\s+works\s+now|that\s+worked|issue\s+was|problem\s+was|solved\s+it|resolved\s+it|ya\s+lo\s+solucion[eé]|ya\s+funciona|resuelto|solucionado)\b/i;

const AUTHOR_CONFIRMATION_PATTERN =
  /\b(?:thanks|thank\s+you|thx|tysm|worked|that\s+fixed|fixed\s+the|solved\s+my|awesome\s+thanks|perfect\s+thanks|gracias|funcion[oó])\b/i;

export function resolveForumAppliedTagNames(thread = {}, forumChannel = null) {
  const availableTags =
    forumChannel?.available_tags ||
    forumChannel?.availableTags ||
    thread?.available_tags ||
    thread?.availableTags ||
    [];
  const tagMap = new Map();
  if (Array.isArray(availableTags)) {
    for (const tag of availableTags) {
      if (tag && typeof tag === 'object' && tag.id !== undefined) {
        tagMap.set(String(tag.id), String(tag.name || tag.id));
      }
    }
  }

  const hasExplicitTags = Array.isArray(thread?.tags) && thread.tags.length > 0;
  const rawSources =
    hasExplicitTags && tagMap.size === 0
      ? thread.tags
      : [
          ...(hasExplicitTags ? thread.tags : []),
          ...(Array.isArray(thread?.applied_tags) ? thread.applied_tags : []),
          ...(Array.isArray(thread?.appliedTags) ? thread.appliedTags : []),
        ];
  if (rawSources.length === 0) {
    return [];
  }

  const resolved = [];
  const seen = new Set();
  for (const rawTag of rawSources) {
    let name = '';
    if (rawTag && typeof rawTag === 'object') {
      name = String(
        rawTag.name || tagMap.get(String(rawTag.id ?? '')) || rawTag.id || ''
      ).trim();
    } else {
      const idOrName = String(rawTag ?? '').trim();
      if (idOrName) {
        if (tagMap.has(idOrName)) {
          name = String(tagMap.get(idOrName)).trim();
        } else if (!hasExplicitTags || !/^(?:tag_)?\d+$/.test(idOrName)) {
          name = idOrName;
        }
      }
    }
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      resolved.push(name);
    }
  }
  return resolved;
}

/**
 * Determines whether a Forum Post (thread) has been meaningfully answered, rather than
 * relying blindly on `replyCount > 0`.
 *
 * A post is considered answered if:
 * 1. Explicit `thread.answered` or `thread.resolved` boolean is set, OR
 * 2. Thread title or applied forum tags indicate non-negated solved/resolved/answered/fixed status, OR
 * 3. Another participant (different from the starter author) posted a substantive solution/guidance
 *    reply (excluding "me too / +1 / same here / also crashing", negations like "does not work either",
 *    and pure questions), OR
 * 4. The starter author posted a non-negated follow-up confirming the issue was solved or thanking a helper.
 *
 * @param {object} thread
 * @param {Array<object>} postMessages - Chronological messages in the thread
 * @param {object} [forumChannel]
 * @returns {boolean}
 */
export function determineForumPostAnswered(thread = {}, postMessages = [], forumChannel = null) {
  if (typeof thread?.answered === 'boolean') return thread.answered;
  if (typeof thread?.resolved === 'boolean') return thread.resolved;

  const title = String(thread?.name || thread?.title || '');
  if (!NEGATED_RESOLUTION_PATTERN.test(title) && /(\[(solved|resolved|answered|fixed)\]|✅|✔️)/i.test(title)) {
    return true;
  }

  const resolvedTagNames = resolveForumAppliedTagNames(thread, forumChannel);
  for (const tagName of resolvedTagNames) {
    if (
      !NEGATED_RESOLUTION_PATTERN.test(tagName) &&
      /\b(solved|resolved|answered|fixed|completed|done|resuelto|solucionado)\b/i.test(tagName)
    ) {
      return true;
    }
  }

  const missingStarter = Boolean(thread?._missingStarter);
  if (!Array.isArray(postMessages) || postMessages.length === 0) {
    return false;
  }
  if (!missingStarter && postMessages.length <= 1) {
    return false;
  }

  const threadOwnerId =
    thread?.owner_id ?? thread?.ownerId ?? thread?.owner?.id ?? null;
  const rawThreadAuthor =
    thread?.owner?.user?.global_name ||
    thread?.owner?.user?.username ||
    thread?.owner?.nick ||
    thread?.author?.global_name ||
    thread?.author?.username ||
    (typeof thread?.author === 'string' ? thread.author : '') ||
    (threadOwnerId ? `user:${threadOwnerId}` : '');

  const starterAuthor = String(
    missingStarter ? rawThreadAuthor : postMessages[0]?.author || rawThreadAuthor || ''
  )
    .trim()
    .toLowerCase();
  const starterAuthorId = String(
    (missingStarter ? threadOwnerId : postMessages[0]?.authorId || threadOwnerId) || ''
  ).trim();
  const replies = missingStarter ? postMessages : postMessages.slice(1);

  const isSameAsStarter = (m) => {
    const replyAuthorId = String(m?.authorId || '').trim();
    if (starterAuthorId && replyAuthorId && replyAuthorId === starterAuthorId) {
      return true;
    }
    const replyAuthor = String(m?.author || '').trim().toLowerCase();
    return Boolean(starterAuthor) && Boolean(replyAuthor) && replyAuthor === starterAuthor;
  };

  const otherUserReplies = replies.filter((m) => {
    const replyAuthor = String(m?.author || '').trim();
    return Boolean(replyAuthor) && !isSameAsStarter(m);
  });
  const authorFollowUps = replies.filter((m) => isSameAsStarter(m));

  for (const followUp of authorFollowUps) {
    const text = String(followUp?.content || '').trim();
    if (!text || NEGATED_RESOLUTION_PATTERN.test(text)) {
      continue;
    }
    if (SELF_SOLVED_PATTERN.test(text)) {
      return true;
    }
    if (otherUserReplies.length > 0 && AUTHOR_CONFIRMATION_PATTERN.test(text)) {
      return true;
    }
  }

  for (const reply of otherUserReplies) {
    const text = String(reply?.content || '').trim();
    if (!text) continue;

    if (ME_TOO_OR_NOISE_REPLY_PATTERN.test(text) || NEGATED_RESOLUTION_PATTERN.test(text)) {
      continue;
    }

    // Split into sentences so a pure question ("Can you check your config?") is rejected,
    // while a guidance statement ("Set DEEPSEEK_API_KEY in .env." or "Try upgrading. Did that help?") is accepted.
    const declarativeSentences = text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.endsWith('?'));

    if (
      declarativeSentences.some(
        (sentence) =>
          !ME_TOO_OR_NOISE_REPLY_PATTERN.test(sentence) &&
          !NEGATED_RESOLUTION_PATTERN.test(sentence) &&
          SOLUTION_GUIDANCE_PATTERN.test(sentence)
      )
    ) {
      return true;
    }
  }

  return false;
}

function normalizeForumCallArgs(firstArg, secondArg = {}, thirdArg = {}) {
  if (
    typeof firstArg === 'string' &&
    secondArg &&
    typeof secondArg === 'object' &&
    ('id' in secondArg || 'name' in secondArg)
  ) {
    // (guildId, forumChannel, options)
    return {
      guildId: firstArg.trim(),
      forumChannel: secondArg,
      channelId: String(secondArg.id || '').trim(),
      options: thirdArg || {},
    };
  }
  if (typeof firstArg === 'object' && firstArg !== null) {
    // (forumChannel, guildId, options) or (forumChannel, options)
    const isSecondGuildId = typeof secondArg === 'string';
    const options = (isSecondGuildId ? thirdArg : secondArg) || {};
    const guildId = String(
      (isSecondGuildId ? secondArg : options.guildId) ||
        firstArg.guild_id ||
        firstArg.guildId ||
        ''
    ).trim();
    return {
      guildId,
      forumChannel: firstArg,
      channelId: String(firstArg.id || '').trim(),
      options,
    };
  }
  // (channelId, guildId, options) or (channelId, options)
  const isSecondGuildId = typeof secondArg === 'string';
  const options = (isSecondGuildId ? thirdArg : secondArg) || {};
  const guildId = String((isSecondGuildId ? secondArg : options.guildId) || '').trim();
  const channelId = String(firstArg || '').trim();
  return {
    guildId,
    forumChannel: { id: channelId, name: 'forum' },
    channelId,
    options,
  };
}

const INACCESSIBLE_CHANNEL_CODES = new Set([50001, 50013, 10003]);

/**
 * Returns true only for explicit Discord inaccessible-channel codes:
 * `50001` (Missing Access), `50013` (Missing Permissions), or `10003` (Unknown Channel).
 * Route-level 403/404 responses without these codes (e.g. a changed endpoint) are NOT treated
 * as skippable and must fail the export visibly.
 *
 * @param {object} err
 * @returns {boolean}
 */
export function isExplicitInaccessibleError(err) {
  if (!err) return false;
  return INACCESSIBLE_CHANNEL_CODES.has(Number(err.code));
}

/**
 * Fetches all active and archived public forum threads belonging to a Forum channel
 * within the configured lookback window.
 *
 * Uses the user-account compatible `/channels/{channelId}/threads/search?archived=false...`
 * endpoint for active forum posts (handling HTTP 202 indexing retries and failing visibly
 * if active thread search fails after bounded retries), plus
 * `/channels/{channelId}/threads/archived/public` for archived forum posts.
 *
 * @param {string|object} channelOrId - Forum channel ID or channel object
 * @param {string|object} [guildIdOrOptions] - Guild ID or options object
 * @param {object} [maybeOptions] - Options object
 * @returns {Promise<Array<object>>} Deduplicated forum thread objects
 */
export async function fetchForumThreadsRest(
  channelOrId,
  guildIdOrOptions = {},
  maybeOptions = {}
) {
  const {
    channelId: resolvedChannelId,
    options,
  } = normalizeForumCallArgs(channelOrId, guildIdOrOptions, maybeOptions);

  if (!resolvedChannelId) {
    throw new Error('Forum channelId is required to fetch forum threads.');
  }

  const {
    token = config.discord.userToken,
    hours = config.report.lookbackDays * 24,
    cutoffTime,
    requestDelayMs = config.discord.requestDelayMs,
    maxRetries = 3,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    fetchImpl = globalThis.fetch,
    sleepImpl = defaultSleep,
  } = options;

  const effectiveCutoffTime =
    typeof cutoffTime === 'number' && Number.isFinite(cutoffTime)
      ? cutoffTime
      : Date.now() - hours * 60 * 60 * 1000;

  const threadMap = new Map();
  const knownUsersById = new Map();
  let madeNetworkCall = false;

  const recordThreadUsers = (membersList, firstMessagesList) => {
    if (Array.isArray(membersList)) {
      for (const m of membersList) {
        const userId = m?.user_id ?? m?.user?.id ?? m?.id;
        const name =
          m?.member?.nick ||
          m?.nick ||
          m?.user?.global_name ||
          m?.user?.globalName ||
          m?.user?.username ||
          m?.member?.user?.global_name ||
          m?.member?.user?.username ||
          '';
        if (userId && name) {
          knownUsersById.set(String(userId), String(name));
        }
      }
    }
    if (Array.isArray(firstMessagesList)) {
      for (const msg of firstMessagesList) {
        if (!msg || msg.author?.bot) continue;
        const authorId = msg.author?.id ? String(msg.author.id) : null;
        const name =
          msg.member?.displayName ||
          msg.member?.nick ||
          msg.author?.globalName ||
          msg.author?.global_name ||
          msg.author?.username ||
          '';
        if (authorId && name) {
          knownUsersById.set(authorId, String(name));
        }
      }
    }
  };

  const addMatchingThread = (thread, firstMsgMap = null, { isArchivedList = false } = {}) => {
    if (!thread || !thread.id) return { withinWindow: true };
    const parentId = thread.parent_id ?? thread.parentId ?? thread.parent?.id;
    if (parentId !== undefined && parentId !== null && String(parentId) !== resolvedChannelId) {
      return { withinWindow: true };
    }
    const starterFromSearch = firstMsgMap?.get(String(thread.id));
    if (starterFromSearch && !thread.first_message && !thread.message) {
      thread.first_message = starterFromSearch;
    }
    const { createdMs, activityMs, hasExplicitActivity } = extractThreadTimestampsMs(thread);
    const isArchived =
      isArchivedList || Boolean(thread.thread_metadata?.archived ?? thread.archived);
    if (isArchived || hasExplicitActivity) {
      const latestMs = Math.max(createdMs ?? -Infinity, activityMs ?? -Infinity);
      if (Number.isFinite(latestMs) && latestMs < effectiveCutoffTime) {
        return { withinWindow: false };
      }
    }
    const existing = threadMap.get(String(thread.id));
    if (existing?.first_message && !thread.first_message) {
      thread.first_message = existing.first_message;
    }
    if (knownUsersById.size > 0) {
      Object.defineProperty(thread, '_knownUsersById', {
        value: knownUsersById,
        enumerable: false,
        configurable: true,
      });
    }
    threadMap.set(String(thread.id), thread);
    return { withinWindow: true };
  };

  // 1. Active forum threads via user-account compatible search endpoint:
  // `GET /channels/{id}/threads/search?archived=false&sort_by=last_message_time&sort_order=desc&limit=25&offset=N`
  // Any failure here (after bounded retries in discordRestGet) is thrown directly so active posts are never silently lost.
  let offset = 0;
  let searchPage = 0;
  let keepSearching = true;

  while (keepSearching) {
    if (searchPage > 0 && requestDelayMs > 0) {
      await sleepImpl(requestDelayMs);
    }
    const searchEndpoint = `/channels/${resolvedChannelId}/threads/search?archived=false&sort_by=last_message_time&sort_order=desc&limit=25&offset=${offset}`;
    const searchData = await discordRestGet(searchEndpoint, {
      token,
      fetchImpl,
      maxRetries,
      maxRetryAfterMs,
      retryBaseDelayMs,
      sleepImpl,
    });
    madeNetworkCall = true;
    searchPage++;

    recordThreadUsers(searchData?.members, searchData?.first_messages);

    const searchThreads = Array.isArray(searchData)
      ? searchData
      : searchData?.threads || [];
    if (!Array.isArray(searchThreads) || searchThreads.length === 0) {
      break;
    }

    const firstMsgMap = new Map();
    if (Array.isArray(searchData?.first_messages)) {
      for (const msg of searchData.first_messages) {
        if (msg && msg.id) {
          firstMsgMap.set(String(msg.id), msg);
        }
        if (msg && msg.channel_id) {
          firstMsgMap.set(String(msg.channel_id), msg);
        }
      }
    }

    for (const thread of searchThreads) {
      const { withinWindow } = addMatchingThread(thread, firstMsgMap);
      if (!withinWindow) {
        keepSearching = false;
      }
    }

    offset += searchThreads.length;
    const hasMore = Boolean(searchData?.has_more ?? searchData?.hasMore);
    const totalResults =
      typeof searchData?.total_results === 'number' ? searchData.total_results : null;
    if (
      !hasMore ||
      offset >= 9975 ||
      (totalResults !== null && offset >= totalResults)
    ) {
      break;
    }
  }

  // 2. Archived public forum threads with pagination
  let beforeCursor = null;
  let keepFetchingArchived = true;
  let archivePage = 0;

  while (keepFetchingArchived) {
    if ((archivePage > 0 || madeNetworkCall) && requestDelayMs > 0) {
      await sleepImpl(requestDelayMs);
    }

    const query = beforeCursor
      ? `?limit=100&before=${encodeURIComponent(beforeCursor)}`
      : '?limit=100';
    const archivedData = await discordRestGet(
      `/channels/${resolvedChannelId}/threads/archived/public${query}`,
      {
        token,
        fetchImpl,
        maxRetries,
        maxRetryAfterMs,
        retryBaseDelayMs,
        sleepImpl,
      }
    );
    madeNetworkCall = true;
    archivePage++;

    recordThreadUsers(archivedData?.members, archivedData?.first_messages);

    const archivedList = Array.isArray(archivedData)
      ? archivedData
      : archivedData?.threads || [];
    if (!Array.isArray(archivedList) || archivedList.length === 0) {
      break;
    }

    for (const thread of archivedList) {
      const { withinWindow } = addMatchingThread(thread, null, { isArchivedList: true });
      if (!withinWindow) {
        keepFetchingArchived = false;
      }
    }

    const hasMore = Boolean(archivedData?.has_more ?? archivedData?.hasMore);
    const lastThread = archivedList[archivedList.length - 1];
    const nextCursor =
      lastThread?.thread_metadata?.archive_timestamp ||
      (typeof lastThread?.archiveTimestamp === 'number'
        ? new Date(lastThread.archiveTimestamp).toISOString()
        : null) ||
      (lastThread?.id ? String(lastThread.id) : null);

    if (!hasMore || !nextCursor || nextCursor === beforeCursor) {
      break;
    }
    beforeCursor = nextCursor;
  }

  return Array.from(threadMap.values());
}

/**
 * Fetches all forum posts (active + archived threads) and their messages for a Forum channel
 * via Discord REST API v10 within the lookback window.
 *
 * Ensures that for old forum posts created before the lookback window that still have
 * recent replies, the starter message (`GET /channels/{threadId}/messages?after={threadId-1}&limit=1`
 * or `first_message` from thread search) and thread creation timestamp are preserved.
 *
 * @param {string|object} guildId
 * @param {object|string} [forumChannel]
 * @param {object} [options]
 * @returns {Promise<{ posts: Array<object>, messages: Array<object>, truncated: boolean, inaccessibleThreadCount: number, budgetSkippedThreadCount: number }>}
 */
export async function fetchForumPostsRest(guildId, forumChannel = {}, options = {}) {
  const {
    guildId: resolvedGuildId,
    forumChannel: channelObj,
    options: opts,
  } = normalizeForumCallArgs(guildId, forumChannel, options);

  const {
    token = config.discord.userToken,
    hours = config.report.lookbackDays * 24,
    cutoffTime,
    maxMessagesPerChannel = config.report.maxMessagesPerChannel,
    requestDelayMs = config.discord.requestDelayMs,
    maxRetries = 3,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    fetchImpl = globalThis.fetch,
    sleepImpl = defaultSleep,
  } = opts;

  const effectiveCutoffTime =
    typeof cutoffTime === 'number' && Number.isFinite(cutoffTime)
      ? cutoffTime
      : Date.now() - hours * 60 * 60 * 1000;

  const threads = await fetchForumThreadsRest(channelObj, resolvedGuildId, {
    token,
    hours,
    cutoffTime: effectiveCutoffTime,
    requestDelayMs,
    maxRetries,
    maxRetryAfterMs,
    retryBaseDelayMs,
    fetchImpl,
    sleepImpl,
  });

  const posts = [];
  const allForumMessages = [];
  const knownAuthorsById = new Map();
  for (const t of threads) {
    if (t?._knownUsersById instanceof Map) {
      for (const [uid, uname] of t._knownUsersById.entries()) {
        knownAuthorsById.set(uid, uname);
      }
    }
  }

  let remainingBudget = resolveMaxMessagesLimit(maxMessagesPerChannel);
  let truncated = false;
  let inaccessibleThreadCount = 0;
  let budgetSkippedThreadCount = 0;
  const channelLabel = channelObj?.name || channelObj?.id || 'forum';

  const recordRawMsgAuthor = (rawMsg) => {
    if (!rawMsg || rawMsg.author?.bot) return;
    const authorId = rawMsg.author?.id ? String(rawMsg.author.id) : null;
    if (!authorId) return;
    const displayName =
      rawMsg.member?.displayName ||
      rawMsg.member?.nick ||
      rawMsg.author?.globalName ||
      rawMsg.author?.global_name ||
      rawMsg.author?.username ||
      '';
    if (displayName) {
      knownAuthorsById.set(authorId, displayName);
    }
  };

  for (let i = 0; i < threads.length; i++) {
    if (remainingBudget <= 0) {
      budgetSkippedThreadCount += threads.length - i;
      truncated = true;
      console.warn(
        `[Export] Message budget reached in #${channelLabel}; ${threads.length - i} post(s) were not exported.`
      );
      break;
    }

    const thread = threads[i];
    const threadIdStr = String(thread.id);
    const threadTitle = thread.name || thread.title || `Post ${threadIdStr}`;
    const threadOwnerId =
      thread.owner_id ?? thread.ownerId ?? thread.owner?.id ?? null;
    const { createdMs: threadCreatedMs } = extractThreadTimestampsMs(thread);

    if (i > 0 && requestDelayMs > 0) {
      await sleepImpl(requestDelayMs);
    }

    let postMessages;
    try {
      postMessages = await fetchChannelMessagesRest(threadIdStr, {
        token,
        hours,
        cutoffTime: effectiveCutoffTime,
        maxMessages: Number.isFinite(remainingBudget) ? remainingBudget : 0,
        requestDelayMs,
        maxRetries,
        maxRetryAfterMs,
        retryBaseDelayMs,
        fetchImpl,
        sleepImpl,
      });
    } catch (threadErr) {
      if (!isExplicitInaccessibleError(threadErr)) {
        throw threadErr;
      }
      inaccessibleThreadCount++;
      console.warn(
        `[Export] Skipping inaccessible post "${threadTitle}" (${threadIdStr}) in #${channelLabel}: ${threadErr.message}`
      );
      continue;
    }

    if (postMessages.knownAuthorsById instanceof Map) {
      for (const [uid, uname] of postMessages.knownAuthorsById.entries()) {
        knownAuthorsById.set(uid, uname);
      }
    }

    const postTruncated = Boolean(postMessages.truncated);
    if (postTruncated) {
      truncated = true;
      console.warn(
        `[Export] Post "${threadTitle}" in #${channelLabel} hit the message budget; its history is partial.`
      );
    }

    remainingBudget -= postMessages.length;

    const starterFromBatch = postMessages.starterMessage || null;
    if (
      postMessages.length === 0 &&
      threadCreatedMs !== null &&
      threadCreatedMs < effectiveCutoffTime
    ) {
      continue;
    }

    // Check whether the starter message (which has id === thread.id in Discord Forums) is present.
    // For threads created before the lookback cutoff, `fetchChannelMessagesRest` stops at the cutoff
    // and only returns recent replies, so we recover the starter message via a user-account compatible
    // message list call (`GET /channels/{threadId}/messages?after={threadId-1}&limit=1`).
    let hasStarterMessage = postMessages.some((m) => String(m.id) === threadIdStr);
    if (
      !hasStarterMessage &&
      postMessages.length > 0 &&
      threadCreatedMs !== null &&
      Math.abs(postMessages[0].timestamp.getTime() - threadCreatedMs) <= 60_000
    ) {
      hasStarterMessage = true;
    }

    if (!hasStarterMessage) {
      let normalizedStarter = null;
      let rawStarter = thread.first_message || thread.message || null;
      if (rawStarter) {
        recordRawMsgAuthor(rawStarter);
        normalizedStarter = normalizeMessage(rawStarter);
        if (normalizedStarter && rawStarter.author?.id) {
          Object.defineProperty(normalizedStarter, 'authorId', {
            value: String(rawStarter.author.id),
            enumerable: false,
            configurable: true,
          });
        }
      }

      if (!normalizedStarter && starterFromBatch && String(starterFromBatch.id) === threadIdStr) {
        normalizedStarter = starterFromBatch;
      }

      if (!normalizedStarter) {
        const isNumericThreadId = /^\d+$/.test(threadIdStr) && BigInt(threadIdStr) > 0n;
        const starterListQuery = isNumericThreadId
          ? `?after=${String(BigInt(threadIdStr) - 1n)}&limit=1`
          : `?around=${encodeURIComponent(threadIdStr)}&limit=1`;

        const extractStarterFromListResponse = (fetchedStarter) => {
          if (!fetchedStarter) return null;
          if (!Array.isArray(fetchedStarter)) {
            recordRawMsgAuthor(fetchedStarter);
            return String(fetchedStarter?.id || '') === threadIdStr ? fetchedStarter : null;
          }
          for (const item of fetchedStarter) {
            recordRawMsgAuthor(item);
          }
          const exact = fetchedStarter.find((m) => String(m?.id) === threadIdStr);
          if (exact) return exact;
          if (fetchedStarter.length === 1) {
            const single = fetchedStarter[0];
            const singleMs = extractRawMessageTimestampMs(single);
            const isNearCreation =
              threadCreatedMs !== null &&
              singleMs !== null &&
              Math.abs(singleMs - threadCreatedMs) <= 60_000;
            const isByOwner =
              threadOwnerId !== null &&
              single?.author?.id &&
              String(single.author.id) === String(threadOwnerId);
            if (isNearCreation || isByOwner || threadCreatedMs === null) {
              return single;
            }
          }
          if (fetchedStarter.length > 1 && fetchedStarter.length < 100) {
            const oldest = fetchedStarter[fetchedStarter.length - 1];
            const oldestMs = extractRawMessageTimestampMs(oldest);
            if (
              String(oldest?.id) === threadIdStr ||
              (threadCreatedMs !== null &&
                oldestMs !== null &&
                Math.abs(oldestMs - threadCreatedMs) <= 60_000)
            ) {
              return oldest;
            }
          }
          return null;
        };

        try {
          if (requestDelayMs > 0) {
            await sleepImpl(requestDelayMs);
          }
          const fetchedStarter = await discordRestGet(
            `/channels/${threadIdStr}/messages${starterListQuery}`,
            {
              token,
              fetchImpl,
              maxRetries,
              maxRetryAfterMs,
              retryBaseDelayMs,
              sleepImpl,
            }
          );
          rawStarter = extractStarterFromListResponse(fetchedStarter);
        } catch (starterErr) {
          if (!isExplicitInaccessibleError(starterErr)) {
            throw starterErr;
          }
          rawStarter = null;
        }

        if (rawStarter) {
          normalizedStarter = normalizeMessage(rawStarter);
          if (normalizedStarter && rawStarter.author?.id) {
            Object.defineProperty(normalizedStarter, 'authorId', {
              value: String(rawStarter.author.id),
              enumerable: false,
              configurable: true,
            });
          }
        }
      }

      if (normalizedStarter) {
        postMessages = [
          normalizedStarter,
          ...postMessages.filter((m) => String(m.id) !== String(normalizedStarter.id)),
        ];
        hasStarterMessage = true;
      }
    }

    if (postMessages.length === 0) {
      continue;
    }

    const serializedPostMessages = postMessages.map((m, idx) => {
      const contextOnly = new Date(m.timestamp).getTime() < effectiveCutoffTime;
      const msgObj = {
        id: m.id,
        author: m.author,
        content:
          idx === 0 && hasStarterMessage && !String(m.content || '').startsWith('[Forum Post:')
            ? `[Forum Post: "${threadTitle}"] ${m.content}`
            : m.content,
        attachments: m.attachments || [],
        timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
        postId: threadIdStr,
        postTitle: threadTitle,
        ...(contextOnly ? { contextOnly: true } : {}),
      };
      if (m.authorId) {
        Object.defineProperty(msgObj, 'authorId', {
          value: String(m.authorId),
          enumerable: false,
          configurable: true,
        });
      }
      return msgObj;
    });

    const fallbackAuthor =
      (threadOwnerId ? knownAuthorsById.get(String(threadOwnerId)) : null) ||
      thread.owner?.user?.global_name ||
      thread.owner?.user?.username ||
      thread.owner?.nick ||
      thread.author?.global_name ||
      thread.author?.username ||
      (typeof thread.author === 'string' ? thread.author : '') ||
      (threadOwnerId ? `user:${threadOwnerId}` : 'Unknown User');

    const threadForAnswerCheck = hasStarterMessage
      ? thread
      : {
          ...thread,
          _missingStarter: true,
          author:
            fallbackAuthor !== 'Unknown User' && !fallbackAuthor.startsWith('user:')
              ? fallbackAuthor
              : thread.author,
        };
    const answered = determineForumPostAnswered(
      threadForAnswerCheck,
      serializedPostMessages,
      channelObj
    );

    const postAuthor = hasStarterMessage
      ? serializedPostMessages[0].author
      : fallbackAuthor;

    const rawStarterQuestion = hasStarterMessage
      ? String(postMessages[0].content || '').replace(/^\[Forum Post:\s*"[^"]*"\]\s*/i, '')
      : threadTitle;

    const createdAtIso =
      threadCreatedMs !== null
        ? new Date(threadCreatedMs).toISOString()
        : serializedPostMessages[0].timestamp;

    const replyCount = hasStarterMessage
      ? Math.max(0, serializedPostMessages.length - 1)
      : serializedPostMessages.length;

    const resolvedTags = resolveForumAppliedTagNames(thread, channelObj);
    const rawAppliedTags = Array.isArray(thread?.applied_tags || thread?.appliedTags)
      ? (thread.applied_tags || thread.appliedTags)
          .map((t) => (t && typeof t === 'object' ? String(t.id ?? t.name ?? '') : String(t ?? '')))
          .filter(Boolean)
      : [];

    posts.push({
      postId: threadIdStr,
      title: threadTitle,
      author: postAuthor,
      createdAt: createdAtIso,
      lastActivityAt: serializedPostMessages[serializedPostMessages.length - 1].timestamp,
      starterQuestion: rawStarterQuestion,
      messageCount: serializedPostMessages.length,
      replyCount,
      answered,
      ...(resolvedTags.length > 0 ? { tags: resolvedTags } : {}),
      ...(rawAppliedTags.length > 0 ? { appliedTags: rawAppliedTags } : {}),
      ...(!hasStarterMessage ? { missingStarter: true } : {}),
      ...(postTruncated ? { truncated: true } : {}),
      messages: serializedPostMessages,
    });

    allForumMessages.push(...serializedPostMessages.filter((m) => !m.contextOnly));
  }

  posts.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  allForumMessages.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return {
    posts,
    messages: allForumMessages,
    truncated,
    inaccessibleThreadCount,
    budgetSkippedThreadCount,
  };
}
