import dotenv from 'dotenv';

dotenv.config();

function parseNonNegativeInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/**
 * Loads CLI configuration from environment variables.
 *
 * Caution: Using a personal Discord user token (DISCORD_USER_TOKEN) is not officially
 * supported by Discord, as automated user accounts (self-bots) violate Discord's Terms
 * of Service and carry account/security risks. Keep tokens strictly confidential and
 * use read-only pacing.
 */
export function loadConfig(env = process.env) {
  const userToken = env.DISCORD_USER_TOKEN || env.DISCORD_TOKEN || '';

  return {
    discord: {
      userToken,
      token: userToken,
      guildId: env.DISCORD_GUILD_ID || '',
      requestDelayMs: parseNonNegativeInt(env.DISCORD_REQUEST_DELAY_MS, 350),
    },
    llm: {
      provider: (env.LLM_PROVIDER || 'deepseek').toLowerCase(),
      apiKey: env.DEEPSEEK_API_KEY || env.LLM_API_KEY || '',
      baseUrl: (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
      model: env.LLM_MODEL || 'deepseek-flash',
    },
    report: {
      lookbackDays: parsePositiveInt(env.REPORT_LOOKBACK_DAYS, 90),
      maxMessagesPerChannel: parseNonNegativeInt(env.REPORT_MAX_MESSAGES_PER_CHANNEL, 5000),
      chunkSize: Math.max(parsePositiveInt(env.REPORT_CHUNK_SIZE, 150), 20),
      excludeChannels: (env.REPORT_EXCLUDE_CHANNELS || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      includeChannels: (env.REPORT_INCLUDE_CHANNELS || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      qaChannelPatterns: (
        env.REPORT_QA_CHANNELS ||
        'question,questions,pregunta,preguntas,duda,dudas,help,ayuda,support,soporte,faq,troubleshoot,troubleshooting,bug,bugs,issue,issues,install,installation,setup,ask'
      )
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      dataDir: env.DATA_DIR || 'data',
    },
  };
}

export const config = loadConfig();
