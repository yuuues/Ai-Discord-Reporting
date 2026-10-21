import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, loadConfig } from './config.js';
import { generateServerSupportReport } from './services/serverReportGenerator.js';

/**
 * Sample 3-month (90-day) Discord Server dataset simulating the 1-Chat + 1-Forum
 * test scenario (#💬-chat and #🆘-support) for JetBrains Ambassador follow-up meetings
 * without needing a live Discord connection.
 */
const now = Date.now();
const DAY_MS = 24 * 3600 * 1000;

const forumPost1Messages = [
  {
    id: '201',
    author: 'carlos_dev',
    content:
      '[Forum Post: "How to configure DeepSeek API key and model fallback in Junie CLI?"] Hi team, after setting up the CLI on Windows 11, how do I configure DEEPSEEK_API_KEY so that it uses deepseek-flash first and falls back to deepseek-chat automatically?',
    attachments: ['env-setup.png'],
    timestamp: new Date(now - 75 * DAY_MS).toISOString(),
  },
  {
    id: '202',
    author: 'elena_support',
    content:
      'Hi @carlos_dev! Set LLM_PROVIDER=deepseek, DEEPSEEK_API_KEY, and LLM_MODEL=deepseek-flash in your .env file. If the endpoint returns HTTP 400/404 for deepseek-flash, the analyzer automatically retries with deepseek-chat.',
    attachments: [],
    timestamp: new Date(now - 75 * DAY_MS + 1800 * 1000).toISOString(),
  },
  {
    id: '203',
    author: 'carlos_dev',
    content: 'That fixed it immediately and works great, thank you! Resolved.',
    attachments: [],
    timestamp: new Date(now - 75 * DAY_MS + 3600 * 1000).toISOString(),
  },
];

const forumPost2Messages = [
  {
    id: '204',
    author: 'marcus_qa',
    content:
      '[Forum Post: "WSL2 Docker interpreter and rate-limit pacing during 90-day export"] When exporting large forum channels over 90 days, how does the REST v10 exporter handle Discord 429 rate limits?',
    attachments: ['rate-limit-trace.log'],
    timestamp: new Date(now - 45 * DAY_MS).toISOString(),
  },
  {
    id: '205',
    author: 'sofia_ops',
    content:
      'You can tune DISCORD_REQUEST_DELAY_MS=350 in .env. The REST client also inspects the Retry-After header on HTTP 429 responses and backs off automatically before continuing pagination.',
    attachments: [],
    timestamp: new Date(now - 45 * DAY_MS + 2400 * 1000).toISOString(),
  },
];

const forumPost3Messages = [
  {
    id: '206',
    author: 'anna_user',
    content:
      '[Forum Post: "Custom stop-word dictionary for multilingual German and French channels?"] Is there a configuration flag to add custom stop words for German or French support channels in addition to the built-in English and Spanish lists?',
    attachments: [],
    timestamp: new Date(now - 12 * DAY_MS).toISOString(),
  },
];

export const SAMPLE_SUPPORT_SERVER_EXPORT = {
  guildId: '99001122334455',
  guildName: 'Junie Discord & Ambassador Test Server',
  exportedAt: new Date(now).toISOString(),
  lookbackDays: 90,
  timeframeStart: new Date(now - 90 * DAY_MS).toISOString(),
  timeframeEnd: new Date(now).toISOString(),
  totalChannels: 2,
  totalMessages: 12,
  channels: [
    {
      channelId: '111',
      channelName: '💬-chat',
      categoryName: 'Junie',
      channelType: 'chat',
      postCount: 0,
      messageCount: 6,
      messages: [
        {
          id: '101',
          author: 'lucas_lead',
          content:
            'Hey ambassadors! We have been testing Junie inside IntelliJ IDEA and WebStorm all week for TypeScript and Node refactoring tasks.',
          attachments: [],
          timestamp: new Date(now - 60 * DAY_MS).toISOString(),
        },
        {
          id: '102',
          author: 'alex_pm',
          content:
            'Awesome feedback! Many developers in the community mentioned that combining WebStorm with automated unit tests speeds up multi-step plans.',
          attachments: [],
          timestamp: new Date(now - 59 * DAY_MS).toISOString(),
        },
        {
          id: '103',
          author: 'david_enterprise',
          content:
            'Agreed, IntelliJ IDEA and PyCharm users in our team love the step-by-step plan view and DeepSeek report summaries for ambassador meetings.',
          attachments: [],
          timestamp: new Date(now - 40 * DAY_MS).toISOString(),
        },
        {
          id: '104',
          author: 'elena_support',
          content:
            'Quick tip for the ambassador meeting: separating Phase 1 Discord export from Phase 2 DeepSeek report generation saves a lot of time when tweaking prompts.',
          attachments: [],
          timestamp: new Date(now - 28 * DAY_MS).toISOString(),
        },
        {
          id: '105',
          author: 'lucas_lead',
          content:
            'Yes! Having per-channel Markdown reports plus the master executive report makes presenting top keywords and community sentiment super clean.',
          attachments: [],
          timestamp: new Date(now - 15 * DAY_MS).toISOString(),
        },
        {
          id: '106',
          author: 'carlos_dev',
          content:
            'Looking forward to sharing our 3-month Junie community highlights and keyword trends at the upcoming JetBrains Ambassador follow-up session!',
          attachments: [],
          timestamp: new Date(now - 5 * DAY_MS).toISOString(),
        },
      ],
    },
    {
      channelId: '222',
      channelName: '🆘-support',
      categoryName: 'Junie',
      channelType: 'forum',
      postCount: 3,
      messageCount: 6,
      posts: [
        {
          postId: '2001',
          title: 'How to configure DeepSeek API key and model fallback in Junie CLI?',
          author: 'carlos_dev',
          createdAt: new Date(now - 75 * DAY_MS).toISOString(),
          starterQuestion:
            'Hi team, after setting up the CLI on Windows 11, how do I configure DEEPSEEK_API_KEY so that it uses deepseek-flash first and falls back to deepseek-chat automatically?',
          replyCount: 2,
          answered: true,
          confirmed: true,
          tags: ['configuration', 'deepseek'],
          messages: forumPost1Messages,
        },
        {
          postId: '2002',
          title: 'WSL2 Docker interpreter and rate-limit pacing during 90-day export',
          author: 'marcus_qa',
          createdAt: new Date(now - 45 * DAY_MS).toISOString(),
          starterQuestion:
            'When exporting large forum channels over 90 days, how does the REST v10 exporter handle Discord 429 rate limits?',
          replyCount: 1,
          answered: true,
          confirmed: false,
          tags: ['export', 'rate-limits'],
          messages: forumPost2Messages,
        },
        {
          postId: '2003',
          title: 'Custom stop-word dictionary for multilingual German and French channels?',
          author: 'anna_user',
          createdAt: new Date(now - 12 * DAY_MS).toISOString(),
          starterQuestion:
            'Is there a configuration flag to add custom stop words for German or French support channels in addition to the built-in English and Spanish lists?',
          replyCount: 0,
          answered: false,
          confirmed: false,
          tags: ['feature-request', 'i18n'],
          messages: forumPost3Messages,
        },
      ],
      messages: [
        ...forumPost1Messages,
        ...forumPost2Messages,
        ...forumPost3Messages,
      ],
    },
  ],
};

/**
 * Runs the 1-Chat (#💬-chat) + 1-Forum (#🆘-support) demonstration pipeline
 * and writes both per-channel Markdown reports and the Master Executive Report.
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {Function} [options.fetchImpl]
 * @param {object} [options.logger]
 * @param {boolean} [options.printReport=true]
 */
export async function runDemo({
  env,
  fetchImpl = globalThis.fetch,
  logger = console,
  printReport = true,
} = {}) {
  const demoEnv = env ?? {
    DATA_DIR: config.report.dataDir,
    LLM_PROVIDER: 'fallback',
    DEEPSEEK_API_KEY: '',
    LLM_API_KEY: '',
    DISCORD_USER_TOKEN: '',
    DISCORD_TOKEN: '',
    DISCORD_GUILD_ID: '',
  };
  const activeConfig = loadConfig(demoEnv);

  logger.log('======================================================================');
  logger.log(' Discord 3-Month Support Server Analyzer — CLI Demo (1 Chat + 1 Forum)');
  logger.log('======================================================================\n');

  const reportsDir = path.join(activeConfig.report.dataDir, 'reports');
  const demoReportPath = path.join(reportsDir, 'demo-support-report-3months.md');
  const channelReportsDir = path.join(reportsDir, 'channels');

  const result = await generateServerSupportReport(SAMPLE_SUPPORT_SERVER_EXPORT, {
    reportOutputPath: demoReportPath,
    channelReportsDir,
    channelFilePrefix: 'demo-',
    llmConfig: activeConfig.llm,
    fetchImpl,
  });

  if (printReport) {
    logger.log(result.markdownReport);
  }
  logger.log('----------------------------------------------------------------------');
  logger.log(
    `Server Stats        : ${SAMPLE_SUPPORT_SERVER_EXPORT.totalChannels} channels (1 Chat, 1 Forum) | ${result.globalStats.totalMessages} messages | ${result.globalStats.participants.length} participants`
  );
  logger.log(`Master Report       : ${result.reportPath}`);
  logger.log(
    `Per-Channel Reports : ${result.channelReportPaths.join(', ')}`
  );
  logger.log(`AI Engine           : ${result.providerUsed}`);
  logger.log('======================================================================');

  return result;
}

const isMainModule =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  runDemo().catch((error) => {
    console.error('[Fatal Error]', error);
    process.exitCode = 1;
  });
}
