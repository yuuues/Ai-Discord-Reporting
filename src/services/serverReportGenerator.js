import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { buildTranscriptAndStats } from './messageFetcher.js';
import { classifyChannelType, sanitizeName } from './serverExporter.js';
import {
  callOpenAICompatibleLLM,
  clipTextCleanly,
  collectKnownAuthors,
  compressOversizedDigestWithLLM,
  enforceConciseDigest,
  extractQuestionsAndDoubts,
  extractTopKeywords,
  generateLocalFallbackSummary,
  hasPostStarterMessage,
  redactParticipantNames,
  summarizeMessages,
} from './summarizer.js';

export const QA_CHANNEL_CONSOLIDATION_PROMPT = `You are a senior support operations analyst.
You are given multiple chronological chunk summaries from a Discord Forum or Q&A Support channel over the past 3 months.
Consolidate them into a basic, concise, presentation-friendly Q&A channel digest in English with the following sections:
**Support & Q&A Overview**
**Most Frequent Questions & Common Doubts (FAQ)**
**Confirmed Solutions & Answers Provided**
**Unanswered Questions & Pending Issues**

Guidelines:
- Group related doubts into at most 4–6 core FAQ topics per section, keeping each topic concise: at most 2 bullets per topic and 300–450 characters per topic (keep the entire channel digest within 1,500–2,000 characters).
- Strictly distinguish between **Confirmed Resolutions** (explicitly verified by the question author or marked solved) and **Suggested Answers / Unconfirmed Replies** (heuristic answers where a reply offered guidance without explicit confirmation).
- Include NO person names at all (including participants, staff, or people mentioned), usernames, or @handles; refer to people generically.
- Do not invent facts or metrics not present in the provided segment summaries.`;

export const CHAT_CHANNEL_CONSOLIDATION_PROMPT = `You are a senior community analyst.
You are given multiple chronological chunk summaries from a general Discord chat channel over the past 3 months.
Consolidate them into a basic, concise, presentation-friendly chat channel digest in English with the following sections:
**Chat Overview & Community Vibe**
**Main Discussion Topics**
**Top Keywords & Trending Terms**
**Notable Highlights & Shared Ideas**

Guidelines:
- Group related discussions into at most 4–6 core topics per section, keeping each topic concise: at most 2 bullets per topic and 300–450 characters per topic (keep the entire channel digest within 1,500–2,000 characters).
- Incorporate the exact provided keyword frequency counts without inventing metrics.
- Include NO person names at all (including participants, staff, or people mentioned), usernames, or @handles; refer to people generically.
- Do not invent facts not present in the provided segment summaries.`;

export const CHANNEL_CONSOLIDATION_PROMPT = QA_CHANNEL_CONSOLIDATION_PROMPT;

export const MASTER_BATCH_CONSOLIDATION_PROMPT = `You are a Lead Technical Support & Community Analyst consolidating a batch of Discord channel digests for a 3-month retrospective report.
Preserve all key Forum/Q&A questions, confirmed vs. heuristic/unconfirmed solutions, unanswered threads, general chat discussion topics, exact keyword frequency metrics, and actionable takeaways concisely (max 2 bullets and <= 450 characters per topic) without inventing any facts or including any person names at all (including participants, staff, or people mentioned), usernames, or @handles.`;

export const SERVER_MASTER_REPORT_PROMPT = `You are a Lead Technical Support & Community Analyst preparing an Executive 3-Month Discord Retrospective Report to be presented at a follow-up meeting.
You are given:
1. Summaries and question stats from **Forum & Q&A Channels** (where users ask questions and report issues).
2. Summaries and topic breakdowns from **General Chat Channels** (where users discuss topics casually).
3. Exact **Keyword Frequency Counts** measured across the server and per channel.

Produce a concise, well-structured Markdown report in English ready to discuss in a meeting. Use the following sections:

### 1. Executive Summary
- High-level overview of server activity, participation counts, and community sentiment over the 3-month period.

### 2. Forum & Q&A Channels — Most Frequent Questions & Common Doubts (FAQ)
- Synthesize the most common questions, recurring doubts, setup hurdles, and bugs raised in the Forum / Q&A channels (at most 2 bullets and <= 450 characters per topic), clearly distinguishing confirmed resolutions from heuristic/unconfirmed answer replies and listing unanswered questions.

### 3. General Chat Channels — Main Discussion Topics & Community Vibe
- Summarize what users talk about in the normal chat channels (at most 2 bullets and <= 450 characters per topic): main topics, decisions, shared workflows, and community feedback.

### 4. Most Frequently Used Keywords & Technical Terms (Server-wide & Per-Channel)
- Present and interpret the most repeated keywords across the server and per channel (using the exact frequency counts provided).

### 5. Channel-by-Channel Breakdown
- Concise synthesis of each Forum/Q&A channel and each General Chat channel.

### 6. Meeting Talking Points & Action Items
- Summarize overall community participation patterns anonymously and list concrete action items for the team meeting.

Guidelines:
- Include NO person names at all (including participants, staff, or people mentioned), usernames, or @handles anywhere in the report; refer to community members and staff generically.
- Keep every topic and channel summary concise (max 2 bullets per topic, 300–450 characters per topic).
- Use only the facts and exact deterministic metrics provided in the prompt.
- Never claim a reply is a confirmed solution based solely on heuristic \`answered\` counts; only call a fix confirmed when explicitly verified.`;

/**
 * Writes a text/Markdown file atomically by writing to a temporary file in the same directory
 * and renaming it over the target path.
 *
 * @param {string} filePath
 * @param {string} content
 */
async function writeTextFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, 'utf8');
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

/**
 * Estimates the formatted character length of a single reply line in `buildForumTranscript`.
 *
 * @param {object} reply
 * @returns {number}
 */
function estimateForumReplyCharLength(reply) {
  if (!reply) return 0;
  const contentLen = String(reply.content || '').length;
  const authorLen = String(reply.author || '').length;
  const attachLen =
    Array.isArray(reply.attachments) && reply.attachments.length > 0
      ? reply.attachments.join(', ').length + 24
      : 0;
  return contentLen + authorLen + attachLen + 64;
}

/**
 * Estimates the serialized character footprint of a Forum Post in `buildForumTranscript`.
 *
 * @param {object} post
 * @returns {number}
 */
function estimatePostCharLength(post) {
  if (!post) return 0;
  const hasStarter = hasPostStarterMessage(post);
  const postMessages = Array.isArray(post.messages) ? post.messages : [];
  const starterMsg = hasStarter ? postMessages[0] : null;
  const replyMsgs = hasStarter ? postMessages.slice(1) : postMessages;

  const starterText =
    typeof post.starterQuestion === 'string' && post.starterQuestion.trim()
      ? post.starterQuestion.trim()
      : String(starterMsg?.content || post.title || '');
  const tagsLen = Array.isArray(post.tags) && post.tags.length > 0 ? post.tags.join(', ').length + 12 : 0;

  const base =
    String(post.title || '').length +
    String(post.postId || post.id || '').length +
    String(post.author || starterMsg?.author || '').length * 2 +
    starterText.length +
    tagsLen +
    420;

  const repliesLen =
    replyMsgs.length === 0
      ? 40
      : replyMsgs.reduce((sum, m) => sum + estimateForumReplyCharLength(m), 0);

  return base + repliesLen;
}

/**
 * Splits an array of messages into chunks of `chunkSize` (and optional `maxChunkChars`),
 * reserving headroom for the prompt header added by `summarizeMessages`.
 *
 * @param {Array<object>} items
 * @param {number} chunkSize
 * @param {object} [options]
 * @param {number} [options.maxChunkChars=0]
 * @returns {Array<Array<object>>}
 */
export function chunkMessages(items = [], chunkSize = 150, { maxChunkChars = 0 } = {}) {
  const size = Math.max(1, chunkSize);
  const rawBudget =
    maxChunkChars && maxChunkChars > 0 ? maxChunkChars : Number.POSITIVE_INFINITY;
  const headerReserve = Number.isFinite(rawBudget)
    ? Math.min(2400, Math.max(600, Math.floor(rawBudget * 0.16)))
    : 0;
  const charBudget = Number.isFinite(rawBudget)
    ? Math.max(400, rawBudget - headerReserve)
    : Number.POSITIVE_INFINITY;
  const chunks = [];

  if (!Number.isFinite(charBudget)) {
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  }

  const maxSingleMsgContent = Math.max(200, charBudget - 120);
  const expandedItems = [];
  for (const item of items) {
    if (
      item &&
      typeof item === 'object' &&
      typeof item.content === 'string' &&
      item.content.length > maxSingleMsgContent
    ) {
      const text = item.content;
      const totalParts = Math.ceil(text.length / (maxSingleMsgContent - 30));
      const sliceLen = Math.max(100, maxSingleMsgContent - 30);
      for (let p = 0; p < totalParts; p++) {
        const piece = text.slice(p * sliceLen, (p + 1) * sliceLen);
        expandedItems.push({
          ...item,
          content: `[Part ${p + 1}/${totalParts}] ${piece}`,
          partIndex: p + 1,
          partCount: totalParts,
          ...(p > 0 ? { continuationPart: true } : {}),
        });
      }
    } else {
      expandedItems.push(item);
    }
  }

  let currentChunk = [];
  let currentChars = 0;

  for (const item of expandedItems) {
    const attachLen =
      item && typeof item === 'object' && Array.isArray(item.attachments) && item.attachments.length > 0
        ? item.attachments.join(', ').length + 20
        : 0;
    const itemChars =
      item && typeof item === 'object'
        ? String(item.content || '').length + String(item.author || '').length + attachLen + 48
        : String(item ?? '').length + 10;

    if (
      currentChunk.length > 0 &&
      (currentChunk.length >= size || currentChars + itemChars > charBudget)
    ) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChars = 0;
    }

    currentChunk.push(item);
    currentChars += itemChars;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Groups Forum Posts into bounded chunks while preserving each Forum Post (Title + Starter Question +
 * Replies) as a cohesive unit. If a single post is oversized (`messages.length > chunkSize` or
 * character footprint exceeds the prompt budget after reserving header headroom), splits its replies
 * into bounded continuation post units that each retain the thread's title, author, starterQuestion,
 * answered status, missingStarter flag, and starter context (marked `contextOnly: true` on continuation
 * parts so in-window message counts are never inflated).
 *
 * @param {Array<object>} posts
 * @param {number} [chunkSize=150]
 * @param {object} [options]
 * @param {number} [options.maxChunkChars=24000]
 * @returns {Array<{ posts: Array<object>, messages: Array<object> }>}
 */
export function chunkForumPosts(posts = [], chunkSize = 150, { maxChunkChars = 24000 } = {}) {
  const size = Math.max(1, chunkSize);
  const rawBudget =
    maxChunkChars && maxChunkChars > 0 ? maxChunkChars : Number.POSITIVE_INFINITY;
  const headerReserve = Number.isFinite(rawBudget)
    ? Math.min(2400, Math.max(600, Math.floor(rawBudget * 0.15)))
    : 0;
  const charBudget = Number.isFinite(rawBudget)
    ? Math.max(500, rawBudget - headerReserve)
    : Number.POSITIVE_INFINITY;

  const normalizedPosts = (posts || []).map((post) => ({
    ...post,
    messages: (post.messages || []).map((m) => ({
      ...m,
      timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp),
    })),
  }));

  const atomicPostUnits = [];

  for (const post of normalizedPosts) {
    const postMessages = post.messages || [];
    const hasStarter = hasPostStarterMessage(post);
    const starterMsg = hasStarter ? postMessages[0] : null;
    const rawReplyMsgs = hasStarter ? postMessages.slice(1) : postMessages;
    const postWithStarterFlag = {
      ...post,
      missingStarter: !hasStarter,
    };
    const postCharLen = estimatePostCharLength(postWithStarterFlag);

    if (postMessages.length <= size && postCharLen <= charBudget) {
      const unitWindowMessages = postMessages.filter((m) => !m?.contextOnly);
      atomicPostUnits.push({
        post: postWithStarterFlag,
        windowMessages: unitWindowMessages,
        unitCount: Math.max(1, postMessages.length),
        charLen: postCharLen,
      });
      continue;
    }

    // Oversized post: split replies into bounded slices while keeping starter question + thread metadata on every part
    const maxRepliesPerSlice = hasStarter ? Math.max(1, size - 1) : Math.max(1, size);
    const rawStarterQ =
      typeof post.starterQuestion === 'string' && post.starterQuestion.trim()
        ? post.starterQuestion.trim()
        : String(starterMsg?.content || post.title || '')
            .replace(/^\[Forum Post:\s*"[^"]*"\]\s*/i, '')
            .trim();
    const maxStarterQChars = Number.isFinite(charBudget)
      ? Math.max(160, Math.floor(charBudget * 0.35))
      : rawStarterQ.length;
    const cleanStarterQ =
      rawStarterQ.length > maxStarterQChars
        ? `${rawStarterQ.slice(0, maxStarterQChars)}...`
        : rawStarterQ;

    const tagsLen =
      Array.isArray(post.tags) && post.tags.length > 0 ? post.tags.join(', ').length + 12 : 0;
    const starterBaseChars =
      String(post.title || '').length +
      String(post.postId || post.id || '').length +
      String(post.author || starterMsg?.author || '').length * 2 +
      cleanStarterQ.length +
      tagsLen +
      430;

    const maxReplySliceBudget = Number.isFinite(charBudget)
      ? Math.max(220, charBudget - starterBaseChars)
      : Number.POSITIVE_INFINITY;
    const maxSingleReplyContent = Number.isFinite(maxReplySliceBudget)
      ? Math.max(120, maxReplySliceBudget - 110)
      : Number.POSITIVE_INFINITY;

    const replyMsgs = [];
    for (const reply of rawReplyMsgs) {
      const text = String(reply?.content || '');
      if (Number.isFinite(maxSingleReplyContent) && text.length > maxSingleReplyContent) {
        const sliceStep = Math.max(80, maxSingleReplyContent - 28);
        const replyParts = Math.ceil(text.length / sliceStep);
        for (let rp = 0; rp < replyParts; rp++) {
          const piece = text.slice(rp * sliceStep, (rp + 1) * sliceStep);
          replyMsgs.push({
            ...reply,
            content: `[Reply Part ${rp + 1}/${replyParts}] ${piece}`,
            partIndex: rp + 1,
            partCount: replyParts,
            ...(rp > 0 ? { continuationPart: true } : {}),
          });
        }
      } else {
        replyMsgs.push(reply);
      }
    }

    const replySlices = [];
    let currentSlice = [];
    let currentChars = starterBaseChars;

    for (const reply of replyMsgs) {
      const replyChars = estimateForumReplyCharLength(reply);
      if (
        currentSlice.length > 0 &&
        (currentSlice.length >= maxRepliesPerSlice || currentChars + replyChars > charBudget)
      ) {
        replySlices.push(currentSlice);
        currentSlice = [];
        currentChars = starterBaseChars;
      }
      currentSlice.push(reply);
      currentChars += replyChars;
    }
    if (currentSlice.length > 0 || replySlices.length === 0) {
      replySlices.push(currentSlice);
    }

    const totalParts = replySlices.length;

    for (let pIdx = 0; pIdx < totalParts; pIdx++) {
      const sliceReplies = replySlices[pIdx];
      let starterForPart = null;
      if (starterMsg) {
        const boundedStarterContent =
          String(starterMsg.content || '').length > maxStarterQChars + 80
            ? `[Forum Post: "${post.title || 'Untitled'}"] ${cleanStarterQ}`
            : starterMsg.content;
        starterForPart =
          pIdx === 0
            ? { ...starterMsg, content: boundedStarterContent }
            : { ...starterMsg, content: boundedStarterContent, contextOnly: true };
      }

      const partMessages = starterForPart ? [starterForPart, ...sliceReplies] : [...sliceReplies];
      const partWindowMessages = partMessages.filter((m) => !m?.contextOnly && !m?.continuationPart);
      const partPost = {
        ...post,
        missingStarter: !hasStarter,
        partIndex: pIdx + 1,
        partCount: totalParts,
        starterQuestion: cleanStarterQ,
        messages: partMessages,
      };
      atomicPostUnits.push({
        post: partPost,
        windowMessages: partWindowMessages,
        unitCount: Math.max(1, partMessages.length),
        charLen: estimatePostCharLength(partPost),
      });
    }
  }

  const chunks = [];
  let currentPosts = [];
  let currentMessages = [];
  let currentCount = 0;
  let currentChars = 0;

  for (const unit of atomicPostUnits) {
    if (
      currentPosts.length > 0 &&
      (currentCount + unit.unitCount > size || currentChars + unit.charLen + 4 > charBudget)
    ) {
      chunks.push({
        posts: currentPosts,
        messages: currentMessages,
      });
      currentPosts = [];
      currentMessages = [];
      currentCount = 0;
      currentChars = 0;
    }
    currentPosts.push(unit.post);
    currentMessages.push(...unit.windowMessages);
    currentCount += unit.unitCount;
    currentChars += unit.charLen + 4;
  }

  if (currentPosts.length > 0) {
    chunks.push({
      posts: currentPosts,
      messages: currentMessages,
    });
  }

  return chunks;
}

/**
 * Hierarchically reduces an array of text segments using bounded batches (bounded by both
 * `maxReduceBatchSize` items and `maxPromptChars` characters per LLM call, reserving headroom
 * for batch headers and server metadata) so arbitrarily large channels or servers never exceed
 * LLM context limits at any reduction level. Always runs the final consolidation pass even when
 * `segments.length === 1`.
 *
 * @param {Array<string>} segments
 * @param {object} options
 * @param {number} [options.maxReduceBatchSize=6]
 * @param {number} [options.maxPromptChars=24000]
 * @param {number} [options.headerReserve=0]
 * @param {Function} options.consolidateBatch
 * @returns {Promise<string>}
 */
export async function reduceSummariesBounded(
  segments = [],
  {
    maxReduceBatchSize = 6,
    maxPromptChars = 24000,
    headerReserve = 0,
    consolidateBatch,
  } = {}
) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return '';
  }
  const batchLimit = Math.max(2, maxReduceBatchSize);
  const rawLimit = Math.max(1000, maxPromptChars);
  const defaultReserve = Math.min(2200, Math.max(500, Math.floor(rawLimit * 0.15)));
  const effectiveHeaderReserve = Math.min(
    Math.floor(rawLimit * 0.45),
    Math.max(headerReserve || 0, defaultReserve)
  );
  const batchCharBudget = Math.max(500, rawLimit - effectiveHeaderReserve);
  const maxSingleItemChars =
    segments.length === 1
      ? Math.max(300, batchCharBudget - 32)
      : Math.max(250, Math.floor((batchCharBudget - 32) * 0.45));

  let current = segments.map((s) => {
    const str = String(s || '');
    return str.length > maxSingleItemChars
      ? `${str.slice(0, maxSingleItemChars)}\n...[segment truncated for reduction budget]`
      : str;
  });

  let pass = 1;
  while (current.length >= 1) {
    const batches = [];
    let currentBatch = [];
    let currentChars = 0;

    for (const item of current) {
      const itemLen = item.length + 16;
      if (
        currentBatch.length > 0 &&
        (currentBatch.length >= batchLimit ||
          (currentBatch.length >= 2 && currentChars + itemLen > batchCharBudget))
      ) {
        batches.push(currentBatch);
        currentBatch = [];
        currentChars = 0;
      }
      currentBatch.push(item);
      currentChars += itemLen;
    }
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    if (batches.length === 1) {
      return consolidateBatch(batches[0], {
        pass,
        batchIndex: 0,
        totalBatches: 1,
        isFinalPass: true,
      });
    }

    const nextLevel = [];
    for (let bIdx = 0; bIdx < batches.length; bIdx++) {
      const batch = batches[bIdx];
      if (batch.length === 1) {
        nextLevel.push(batch[0]);
      } else {
        const reduced = await consolidateBatch(batch, {
          pass,
          batchIndex: bIdx,
          totalBatches: batches.length,
          isFinalPass: false,
        });
        const cleanReduced = String(reduced || '');
        nextLevel.push(
          cleanReduced.length > maxSingleItemChars
            ? `${cleanReduced.slice(0, maxSingleItemChars)}\n...[segment truncated for reduction budget]`
            : cleanReduced
        );
      }
    }

    current = nextLevel;
    pass++;
  }

  return current[0] || '';
}

/**
 * Summarizes a single channel's full 3-month message history using Map-Reduce chunking
 * so arbitrarily large channels never exceed LLM context limits.
 *
 * @param {object} channelRecord - Exported channel object ({ channelName, categoryName, messages, posts })
 * @param {object} options
 * @param {number} [options.chunkSize]
 * @param {number} [options.maxReduceBatchSize=6]
 * @param {number} [options.maxPromptChars=24000]
 * @param {object} [options.llmConfig]
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<object>} Channel digest object
 */
export async function summarizeChannelHistory(
  channelRecord,
  {
    chunkSize = config.report.chunkSize,
    maxReduceBatchSize = 6,
    maxPromptChars = 24000,
    llmConfig = config.llm,
    fetchImpl = globalThis.fetch,
    serverAuthors = [],
  } = {}
) {
  const channelType = classifyChannelType(channelRecord);
  const rawPosts = Array.isArray(channelRecord.posts) ? channelRecord.posts : [];
  const posts = rawPosts.map((p) => ({
    ...p,
    messages: (p.messages || []).map((m) => ({
      ...m,
      timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp),
    })),
  }));

  const directWindowMessages = (channelRecord.messages || []).filter((m) => m && !m.contextOnly);
  const rawWindowMessages =
    directWindowMessages.length > 0 || posts.length === 0
      ? directWindowMessages
      : posts.flatMap((p) => (p.messages || []).filter((m) => m && !m.contextOnly));

  const messages = rawWindowMessages.map((m) => ({
    ...m,
    timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp),
  }));

  const { stats } = buildTranscriptAndStats(messages);
  // Names are redacted using every author known server-wide, because people mentioned in one
  // channel are frequently authors in another.
  const knownAuthors = collectKnownAuthors(channelRecord.messages || messages, posts, [
    ...(stats.participants || []),
    ...serverAuthors,
  ]);
  const topKeywords = extractTopKeywords(messages, { limit: 10, extraAuthors: knownAuthors });
  const qaStats =
    channelType === 'forum' || channelType === 'qa'
      ? extractQuestionsAndDoubts(messages, posts, { extraAuthors: knownAuthors })
      : null;

  const truncated = Boolean(channelRecord.truncated);
  const inaccessibleThreadCount = Number(channelRecord.inaccessibleThreadCount || 0);
  const budgetSkippedThreadCount = Number(channelRecord.budgetSkippedThreadCount || 0);
  const outOfWindowStarterCount = qaStats?.outOfWindowStarterCount || 0;
  const missingStarterCount = qaStats?.missingStarterCount || 0;

  const baseDigest = {
    // In-memory only: names used to neutralize participant identity in generated Markdown
    redactionAuthors: knownAuthors,
    channelId: String(channelRecord.channelId || channelRecord.id || ''),
    channelName: channelRecord.channelName,
    categoryName: channelRecord.categoryName || 'Uncategorized',
    channelType,
    postCount: posts.length,
    messageCount: messages.length,
    truncated,
    inaccessibleThreadCount,
    budgetSkippedThreadCount,
    outOfWindowStarterCount,
    missingStarterCount,
    stats,
    topKeywords,
    qaStats,
  };

  if (messages.length === 0 && posts.length === 0) {
    const emptyNotes = [];
    if (inaccessibleThreadCount > 0) {
      emptyNotes.push(`${inaccessibleThreadCount} inaccessible thread(s) skipped`);
    }
    if (budgetSkippedThreadCount > 0) {
      emptyNotes.push(`${budgetSkippedThreadCount} thread(s) skipped due to message budget`);
    }
    const noteSuffix = emptyNotes.length > 0 ? ` (${emptyNotes.join('; ')})` : '';
    return {
      ...baseDigest,
      chunkCount: 0,
      summary: `No messages recorded in this period.${noteSuffix}`,
      providerUsed: 'none',
    };
  }

  const isForumWithPosts = channelType === 'forum' && posts.length > 0;
  const chunks = isForumWithPosts
    ? chunkForumPosts(posts, chunkSize, { maxChunkChars: maxPromptChars })
    : chunkMessages(messages, chunkSize, { maxChunkChars: maxPromptChars }).map((msgChunk) => ({
        posts: [],
        messages: msgChunk,
      }));

  const chunkSummaries = [];
  let lastProviderUsed = 'local-fallback';
  let remoteSuccessCount = 0;
  let activeChunkCount = 0;
  let remoteProviderName = '';

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    const result = await summarizeMessages(chunk.messages, {
      channelName:
        chunks.length > 1
          ? `${channelRecord.channelName} (Part ${idx + 1}/${chunks.length})`
          : channelRecord.channelName,
      channelType,
      posts: chunk.posts,
      maxPromptChars,
      llmConfig,
      fetchImpl,
      extraAuthors: knownAuthors,
    });
    const segMsgCount = chunk.messages.filter((m) => !m?.continuationPart).length;
    const segLabel = isForumWithPosts
      ? `${chunk.posts.length} ${chunk.posts.length === 1 ? 'post unit' : 'post units'}, ${segMsgCount} in-window messages`
      : segMsgCount > 0
        ? `${segMsgCount} messages`
        : `${chunk.messages.length} message continuation part(s)`;
    chunkSummaries.push(
      chunks.length > 1
        ? `#### Segment ${idx + 1} (${segLabel})\n${result.summary}`
        : result.summary
    );
    if (result.providerUsed && result.providerUsed !== 'none') {
      activeChunkCount++;
      lastProviderUsed = result.providerUsed;
      if (!result.providerUsed.startsWith('local-fallback')) {
        remoteSuccessCount++;
        remoteProviderName = result.providerUsed;
      }
    }
  }

  if (chunks.length === 1) {
    const boundedSummary =
      remoteSuccessCount > 0
        ? await compressOversizedDigestWithLLM(chunkSummaries[0], {
            channelName: channelRecord.channelName,
            knownAuthors,
            maxPromptChars,
            llmConfig,
            fetchImpl,
          })
        : enforceConciseDigest(chunkSummaries[0], { knownAuthors });
    return {
      ...baseDigest,
      chunkCount: 1,
      summary: boundedSummary,
      providerUsed: lastProviderUsed,
    };
  }

  // Bounded hierarchical Reduce step for multi-chunk channel
  const isRemoteActive =
    activeChunkCount > 0 &&
    remoteSuccessCount === activeChunkCount &&
    Boolean(remoteProviderName);
  const consolidationPrompt =
    channelType === 'forum' || channelType === 'qa'
      ? QA_CHANNEL_CONSOLIDATION_PROMPT
      : CHAT_CHANNEL_CONSOLIDATION_PROMPT;

  const rawKeywordLine =
    topKeywords.length > 0
      ? `\nChannel Top Keywords (exact in-window counts): ${topKeywords
          .map((k) => `${String(k.word || '').slice(0, 30)} (${k.count} in ${k.messageCount} msgs)`)
          .join(', ')}`
      : '';
  const keywordLine = rawKeywordLine.slice(0, 600);

  const qaLine =
    qaStats && qaStats.totalQuestions > 0
      ? `\nChannel Q&A Metrics: ${qaStats.totalQuestions} questions/posts (${qaStats.confirmedCount} confirmed resolved, ${qaStats.heuristicAnsweredCount} with heuristic/unconfirmed answer replies, ${qaStats.unansweredCount} unanswered)`
      : '';

  const safeChannelTitle = String(channelRecord.channelName || 'channel').slice(0, 120);
  const channelHeaderReserve =
    safeChannelTitle.length +
    qaLine.length +
    keywordLine.length +
    320;

  if (isRemoteActive) {
    try {
      const consolidated = await reduceSummariesBounded(chunkSummaries, {
        maxReduceBatchSize,
        maxPromptChars,
        headerReserve: channelHeaderReserve,
        consolidateBatch: async (batch, { pass, batchIndex, totalBatches, isFinalPass }) => {
          const batchText = batch.join('\n\n');
          const batchHeader = isFinalPass
            ? `Channel: #${safeChannelTitle} [Type: ${channelType.toUpperCase()}] (${messages.length} in-window messages across ${chunks.length} segments)${qaLine}${keywordLine}`
            : `Channel: #${safeChannelTitle} [Type: ${channelType.toUpperCase()}] — Intermediate Consolidation Pass ${pass} (Batch ${batchIndex + 1}/${totalBatches})${qaLine}${keywordLine}`;
          return callOpenAICompatibleLLM(batchText, {
            channelName: channelRecord.channelName,
            systemPrompt: consolidationPrompt,
            customUserPrompt: `${batchHeader}\n\nSegment Summaries:\n${batchText}`,
            maxPromptChars,
            llmConfig,
            fetchImpl,
          });
        },
      });

      const boundedConsolidated = await compressOversizedDigestWithLLM(consolidated, {
        channelName: channelRecord.channelName,
        knownAuthors,
        maxPromptChars,
        llmConfig,
        fetchImpl,
      });

      return {
        ...baseDigest,
        chunkCount: chunks.length,
        summary: boundedConsolidated,
        providerUsed: remoteProviderName,
      };
    } catch (error) {
      console.warn(
        `[ReportGenerator] Channel consolidation LLM call failed for #${channelRecord.channelName} (${error.message}). Falling back to bounded local channel summary.`
      );
      lastProviderUsed = 'local-fallback (after LLM error)';
    }
  } else if (remoteSuccessCount > 0) {
    lastProviderUsed = 'local-fallback (after LLM error)';
  }

  // Deterministic bounded fallback summary for the full channel
  const boundedFallback = enforceConciseDigest(
    generateLocalFallbackSummary(messages, stats, {
      channelType,
      posts,
      extraAuthors: knownAuthors,
    }),
    { knownAuthors }
  );

  return {
    ...baseDigest,
    chunkCount: chunks.length,
    summary: boundedFallback,
    providerUsed: lastProviderUsed,
  };
}

/**
 * Formats a detailed per-channel Markdown report (`data/reports/channels/<channel-name>.md`)
 * tailored to either a Forum/Q&A channel or a General Chat channel.
 *
 * @param {object} digest - Output from summarizeChannelHistory()
 * @param {object} [exportBundle={}] - Export bundle metadata
 * @returns {string} Markdown content
 */
export function buildChannelMarkdownReport(digest, exportBundle = {}) {
  const lookbackDays = exportBundle.lookbackDays || 90;
  const serverName = exportBundle.guildName || 'Discord Support Server';
  const typeLabel =
    digest.channelType === 'forum'
      ? 'Forum Channel (Structured Thread Q&A)'
      : digest.channelType === 'qa'
        ? 'Q&A / Support Text Channel'
        : 'General Chat Channel';

  const coverageWarnings = [];
  if (digest.truncated) {
    coverageWarnings.push(
      `Channel history was truncated at the configured message budget (${digest.messageCount} in-window messages exported).`
    );
  }
  if (digest.inaccessibleThreadCount > 0) {
    coverageWarnings.push(
      `${digest.inaccessibleThreadCount} forum post(s)/thread(s) were skipped due to missing Discord channel/thread access permissions.`
    );
  }
  if (digest.budgetSkippedThreadCount > 0) {
    coverageWarnings.push(
      `${digest.budgetSkippedThreadCount} forum post(s)/thread(s) were not exported because the channel message budget was reached.`
    );
  }
  if (digest.outOfWindowStarterCount > 0) {
    coverageWarnings.push(
      `${digest.outOfWindowStarterCount} forum post starter(s) were created prior to the ${lookbackDays}-day window and retained as question context only (excluded from in-window message counts).`
    );
  }
  if (digest.missingStarterCount > 0) {
    coverageWarnings.push(
      `${digest.missingStarterCount} forum post(s) had a deleted or missing original starter message.`
    );
  }

  const lines = [
    `# Channel Report: #${digest.channelName}`,
    '',
    `- **Server**: ${serverName}`,
    `- **Category**: ${digest.categoryName || 'Uncategorized'}`,
    `- **Channel Type**: ${typeLabel}`,
    `- **Analysis Window**: Last ${lookbackDays} days`,
    `- **In-Window User Messages**: ${digest.messageCount}`,
    `- **Unique Participants (In-Window)**: ${digest.stats?.participants?.length || 0}`,
  ];

  if (digest.channelType === 'forum' || digest.channelType === 'qa') {
    const qa = digest.qaStats || {
      totalQuestions: 0,
      confirmedCount: 0,
      heuristicAnsweredCount: 0,
      unansweredCount: 0,
    };
    lines.push(
      `- **Questions / Forum Posts Analyzed**: ${qa.totalQuestions} (${qa.confirmedCount} confirmed resolved, ${qa.heuristicAnsweredCount} with heuristic/unconfirmed answer replies, ${qa.unansweredCount} unanswered)`
    );
  }

  lines.push(`- **AI Engine**: ${digest.providerUsed || 'local-fallback'}`);

  if (coverageWarnings.length > 0) {
    lines.push('', '### Data Coverage & Export Notes');
    for (const note of coverageWarnings) {
      lines.push(`- ${note}`);
    }
  }

  const knownAuthors = collectKnownAuthors(
    [],
    [],
    [...(digest.stats?.participants || []), ...(digest.redactionAuthors || [])]
  );
  const boundedSummary = digest.summary
    ? enforceConciseDigest(digest.summary, { knownAuthors })
    : 'No summary available.';

  lines.push('', '---', '', '## Channel Digest', '', boundedSummary);

  if (
    (digest.channelType === 'forum' || digest.channelType === 'qa') &&
    digest.qaStats &&
    digest.qaStats.questions.length > 0
  ) {
    lines.push('', '## Forum & Q&A Thread Breakdown', '');
    for (const q of digest.qaStats.questions.slice(0, 25)) {
      const statusBadge = q.confirmed
        ? 'Confirmed Resolution'
        : q.answered
          ? 'Answered (Heuristic / Unconfirmed Reply)'
          : 'Unanswered';
      const tagsMeta =
        Array.isArray(q.tags) && q.tags.length > 0 ? ` • Tags: ${q.tags.join(', ')}` : '';
      const starterMeta = q.starterContextOnly
        ? ' *(starter created prior to window; context only)*'
        : q.missingStarter
          ? ' *(original starter deleted)*'
          : '';
      const cleanTitle =
        redactParticipantNames(String(q.title || 'Forum Question'), knownAuthors) ||
        'Forum Question';
      const cleanQuestion = clipTextCleanly(
        redactParticipantNames(String(q.question || ''), knownAuthors),
        220
      );
      lines.push(
        `- **${cleanTitle}** [${statusBadge} • ${q.replyCount} ${q.replyCount === 1 ? 'reply' : 'replies'}${tagsMeta}]${starterMeta}`
      );
      lines.push(`  - *Question*: ${cleanQuestion}`);
      if (q.answerPreview) {
        const previewLabel = q.confirmed
          ? 'Confirmed Fix/Reply'
          : 'Suggested Answer/Reply (Unconfirmed)';
        const cleanPreview = clipTextCleanly(
          redactParticipantNames(String(q.answerPreview || ''), knownAuthors),
          180
        );
        lines.push(`  - *${previewLabel}*: ${cleanPreview}`);
      }
    }
  }

  lines.push('', '## Top Keywords (In-Window Exact Word Frequency)', '');
  if (digest.topKeywords && digest.topKeywords.length > 0) {
    lines.push('| Rank | Keyword | Occurrences | Messages |');
    lines.push('| :--- | :--- | :---: | :---: |');
    digest.topKeywords.forEach((k, idx) => {
      lines.push(`| ${idx + 1} | \`${k.word}\` | ${k.count} | ${k.messageCount} |`);
    });
  } else {
    lines.push('- No repeated technical keywords recorded in this window.');
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Computes aggregated Q&A and coverage metrics across all channels in `channelDigests`.
 *
 * @param {Array<object>} channelDigests
 * @param {object} exportBundle
 */
function computeServerAggregateMetrics(channelDigests, exportBundle) {
  const forumQaDigests = channelDigests.filter(
    (d) => d.channelType === 'forum' || d.channelType === 'qa'
  );
  const chatDigests = channelDigests.filter((d) => d.channelType === 'chat');

  let totalQuestions = 0;
  let answeredCount = 0;
  let confirmedCount = 0;
  let heuristicAnsweredCount = 0;
  let unansweredCount = 0;
  let outOfWindowStarterCount = 0;
  let missingStarterCount = 0;
  let inaccessibleThreadCount = 0;
  let budgetSkippedThreadCount = 0;
  const allQuestions = [];
  const truncatedChannels = [];

  for (const d of channelDigests) {
    if (d.truncated) {
      truncatedChannels.push(d.channelName);
    }
    inaccessibleThreadCount += Number(d.inaccessibleThreadCount || 0);
    budgetSkippedThreadCount += Number(d.budgetSkippedThreadCount || 0);

    if (d.qaStats) {
      totalQuestions += d.qaStats.totalQuestions || 0;
      answeredCount += d.qaStats.answeredCount || 0;
      confirmedCount += d.qaStats.confirmedCount || 0;
      heuristicAnsweredCount += d.qaStats.heuristicAnsweredCount || 0;
      unansweredCount += d.qaStats.unansweredCount || 0;
      outOfWindowStarterCount += d.qaStats.outOfWindowStarterCount || 0;
      missingStarterCount += d.qaStats.missingStarterCount || 0;
      for (const q of d.qaStats.questions || []) {
        allQuestions.push({
          ...q,
          channelName: d.channelName,
          channelType: d.channelType,
        });
      }
    }
  }

  return {
    forumQaDigests,
    chatDigests,
    qaSummary: {
      totalQuestions,
      answeredCount,
      confirmedCount,
      heuristicAnsweredCount,
      unansweredCount,
      outOfWindowStarterCount,
      missingStarterCount,
      inaccessibleThreadCount,
      budgetSkippedThreadCount,
      questions: allQuestions,
    },
    truncatedChannels,
    skippedChannels: Array.isArray(exportBundle?.skippedChannels)
      ? exportBundle.skippedChannels
      : [],
  };
}

/**
 * Builds deterministic sections 1..6 for the Master Executive Report so that both offline fallback
 * mode and hybrid LLM mode always contain exact, non-invented metrics and all required report sections.
 */
function buildDeterministicMasterSections(
  exportBundle,
  channelDigests,
  globalStats,
  serverTopKeywords,
  aggregates,
  knownAuthors = []
) {
  const lookbackDays = exportBundle.lookbackDays || 90;
  const serverName = exportBundle.guildName || 'Discord Support Server';
  const { forumQaDigests, chatDigests, qaSummary, truncatedChannels, skippedChannels } =
    aggregates;

  // Section 1: Executive Summary
  const execLines = [
    '### 1. Executive Summary',
    `Over the last **${lookbackDays} days**, **${serverName}** recorded **${globalStats.totalMessages} in-window user messages** across **${channelDigests.length} analyzed channels** (**${forumQaDigests.length}** Forum/Q&A, **${chatDigests.length}** General Chat) and **${globalStats.participants.length} unique participants**.`,
  ];
  if (qaSummary.totalQuestions > 0) {
    execLines.push(
      `- **Support & Q&A Resolution Breakdown**: **${qaSummary.totalQuestions}** total questions/forum posts (**${qaSummary.confirmedCount}** confirmed resolved, **${qaSummary.heuristicAnsweredCount}** with heuristic/unconfirmed answer replies, **${qaSummary.unansweredCount}** unanswered).`
    );
  }
  if (
    skippedChannels.length > 0 ||
    truncatedChannels.length > 0 ||
    qaSummary.inaccessibleThreadCount > 0 ||
    qaSummary.budgetSkippedThreadCount > 0 ||
    qaSummary.outOfWindowStarterCount > 0 ||
    qaSummary.missingStarterCount > 0
  ) {
    const coverageParts = [];
    if (skippedChannels.length > 0) {
      coverageParts.push(`${skippedChannels.length} inaccessible channel(s) skipped`);
    }
    if (truncatedChannels.length > 0) {
      coverageParts.push(`${truncatedChannels.length} channel(s) truncated at message budget`);
    }
    if (qaSummary.inaccessibleThreadCount > 0) {
      coverageParts.push(`${qaSummary.inaccessibleThreadCount} inaccessible forum thread(s) skipped`);
    }
    if (qaSummary.budgetSkippedThreadCount > 0) {
      coverageParts.push(`${qaSummary.budgetSkippedThreadCount} forum thread(s) skipped due to budget`);
    }
    if (qaSummary.outOfWindowStarterCount > 0) {
      coverageParts.push(
        `${qaSummary.outOfWindowStarterCount} older forum starter(s) retained as context only (excluded from window message counts)`
      );
    }
    if (qaSummary.missingStarterCount > 0) {
      coverageParts.push(`${qaSummary.missingStarterCount} forum post(s) with deleted starter message`);
    }
    execLines.push(`- **Data Coverage Notes**: ${coverageParts.join('; ')}.`);
  }

  // Section 2: Forum & Q&A Channels — Most Frequent Questions & Common Doubts (FAQ)
  const faqLines = [
    '### 2. Forum & Q&A Channels — Most Frequent Questions & Common Doubts (FAQ)',
  ];
  if (forumQaDigests.length === 0) {
    faqLines.push('- No Forum or Q&A channels were included in this server export.');
  } else if (qaSummary.questions.length === 0) {
    faqLines.push(
      `- Analyzed **${forumQaDigests.length}** Forum/Q&A channel(s) (${forumQaDigests.map((d) => `#${d.channelName}`).join(', ')}), with **0** questions recorded in the ${lookbackDays}-day window.`
    );
  } else {
    faqLines.push(
      `- **Total Questions / Threads**: **${qaSummary.totalQuestions}** across ${forumQaDigests.map((d) => `**#${d.channelName}**`).join(', ')} (**${qaSummary.confirmedCount}** confirmed resolved, **${qaSummary.heuristicAnsweredCount}** with heuristic/unconfirmed answer replies, **${qaSummary.unansweredCount}** unanswered).`
    );
    for (const q of qaSummary.questions.slice(0, 12)) {
      const statusBadge = q.confirmed
        ? '[Confirmed Resolution]'
        : q.answered
          ? '[Suggested Answer / Unconfirmed Reply (Heuristic)]'
          : '[Unanswered]';
      const tagsNote =
        Array.isArray(q.tags) && q.tags.length > 0 ? ` *(Tags: ${q.tags.join(', ')})*` : '';
      const contextNote = q.starterContextOnly
        ? ' *(out-of-window starter context)*'
        : q.missingStarter
          ? ' *(starter message deleted)*'
          : '';
      const cleanTitle =
        redactParticipantNames(String(q.title || 'Forum Question'), knownAuthors) ||
        'Forum Question';
      const cleanDoubt = clipTextCleanly(
        redactParticipantNames(String(q.question || ''), knownAuthors),
        180
      );
      faqLines.push(
        `- **#${q.channelName}** — **${cleanTitle}** ${statusBadge}${tagsNote}${contextNote}`
      );
      faqLines.push(`  - *Doubt*: "${cleanDoubt}"`);
      if (q.answerPreview) {
        const replyLabel = q.confirmed
          ? 'Confirmed Solution/Reply'
          : 'Suggested Answer/Reply (Unconfirmed)';
        const cleanReply = clipTextCleanly(
          redactParticipantNames(String(q.answerPreview || ''), knownAuthors),
          180
        );
        faqLines.push(`  - *${replyLabel}*: ${cleanReply}`);
      }
    }
  }

  // Section 3: General Chat Channels — Main Discussion Topics & Community Vibe
  const chatLines = [
    '### 3. General Chat Channels — Main Discussion Topics & Community Vibe',
  ];
  if (chatDigests.length === 0) {
    chatLines.push('- No General Chat channels were included in this server export.');
  } else {
    for (const c of chatDigests) {
      const kwStr =
        c.topKeywords && c.topKeywords.length > 0
          ? c.topKeywords
              .slice(0, 5)
              .map((k) => `\`${k.word}\` (${k.count})`)
              .join(', ')
          : 'none';
      chatLines.push(
        `- **#${c.channelName}** (*${c.categoryName}*) — **${c.messageCount}** in-window messages across **${c.stats.participants.length}** participants (Top keywords: ${kwStr}).`
      );
      const summaryFirstLine = redactParticipantNames(String(c.summary || ''), knownAuthors)
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('**') && !l.startsWith('_Note:') && !l.startsWith('#'));
      if (summaryFirstLine) {
        const cleanFirstLine = summaryFirstLine.replace(/^-\s*/, '');
        const clippedFirstLine = clipTextCleanly(cleanFirstLine, 220);
        chatLines.push(`  - ${clippedFirstLine}`);
      }
    }
  }

  // Section 4: Most Frequently Used Keywords & Technical Terms (Server-wide & Per-Channel)
  const keywordLines = [
    '### 4. Most Frequently Used Keywords & Technical Terms (Server-wide & Per-Channel)',
  ];
  if (serverTopKeywords.length > 0) {
    keywordLines.push(
      '#### Server-Wide Top Keywords (In-Window Exact Counts)',
      '| Rank | Keyword | Total Occurrences | Messages Containing Keyword |',
      '| :--- | :--- | :---: | :---: |',
      ...serverTopKeywords.map(
        (k, idx) => `| ${idx + 1} | \`${k.word}\` | ${k.count} | ${k.messageCount} |`
      ),
      ''
    );
  } else {
    keywordLines.push('- No repeated keywords recorded across in-window messages.', '');
  }

  keywordLines.push('#### Per-Channel Keyword Rankings');
  for (const c of channelDigests) {
    const channelKws =
      c.topKeywords && c.topKeywords.length > 0
        ? c.topKeywords
            .slice(0, 6)
            .map((k) => `\`${k.word}\` (${k.count} in ${k.messageCount} msgs)`)
            .join(', ')
        : 'No repeated keywords in window';
    keywordLines.push(`- **#${c.channelName}** [${c.channelType.toUpperCase()}]: ${channelKws}`);
  }

  // Section 5: Channel-by-Channel Breakdown
  const breakdownLines = [
    '### 5. Channel-by-Channel Breakdown',
    ...channelDigests.flatMap((c) => {
      const metaParts = [
        `Category: *${c.categoryName}*`,
        `Type: **${c.channelType.toUpperCase()}**`,
        `In-Window Messages: **${c.messageCount}**`,
        `Participants: **${c.stats.participants.length}**`,
      ];
      if (c.qaStats) {
        metaParts.push(
          `Questions/Posts: **${c.qaStats.totalQuestions}** (${c.qaStats.confirmedCount} confirmed, ${c.qaStats.heuristicAnsweredCount} heuristic/unconfirmed, ${c.qaStats.unansweredCount} unanswered)`
        );
      }
      if (c.truncated) {
        metaParts.push('**TRUNCATED AT BUDGET**');
      }
      if (c.inaccessibleThreadCount > 0) {
        metaParts.push(`Inaccessible Threads Skipped: **${c.inaccessibleThreadCount}**`);
      }
      if (c.budgetSkippedThreadCount > 0) {
        metaParts.push(`Budget-Skipped Threads: **${c.budgetSkippedThreadCount}**`);
      }
      return [
        `#### #${c.channelName} (${c.messageCount} messages)`,
        `- ${metaParts.join(' | ')}`,
        '',
        enforceConciseDigest(c.summary, { knownAuthors }),
        '',
      ];
    }),
  ];

  // Section 6: Meeting Talking Points & Action Items (anonymous participation overview)
  const contributorLines = [
    '### 6. Meeting Talking Points & Action Items',
    globalStats.participants.length > 0
      ? `- **Community Participation (In-Window)**: **${globalStats.participants.length}** unique participants across **${globalStats.totalMessages}** messages in **${channelDigests.length}** channels (individual handles omitted).`
      : '- **Community Participation (In-Window)**: No participant activity recorded in this window.',
    ...(qaSummary.unansweredCount > 0
      ? [
          `- **Follow Up on Unanswered Doubts**: ${qaSummary.unansweredCount} question(s)/post(s) remain unanswered and require support review.`,
        ]
      : []),
    ...(qaSummary.heuristicAnsweredCount > 0
      ? [
          `- **Verify Unconfirmed Guidance Replies**: ${qaSummary.heuristicAnsweredCount} question(s)/post(s) received a heuristic guidance reply without explicit asker confirmation.`,
        ]
      : []),
    ...(serverTopKeywords.length > 0
      ? [
          `- **Top Recurring Technical Themes**: Focus documentation and FAQ updates around ${serverTopKeywords
            .slice(0, 5)
            .map((k) => `\`${k.word}\` (${k.count})`)
            .join(', ')}.`,
        ]
      : []),
  ];

  return {
    section1: execLines.join('\n'),
    section2: faqLines.join('\n'),
    section3: chatLines.join('\n'),
    section4: keywordLines.join('\n'),
    section5: breakdownLines.join('\n'),
    section6: contributorLines.join('\n'),
  };
}

/**
 * Builds a deterministic local executive report when no LLM API key is provided
 * or when offline demoing is desired.
 */
function buildFallbackMasterSynthesis(
  exportBundle,
  channelDigests,
  globalStats,
  serverTopKeywords,
  aggregates,
  knownAuthors = []
) {
  const sections = buildDeterministicMasterSections(
    exportBundle,
    channelDigests,
    globalStats,
    serverTopKeywords,
    aggregates,
    knownAuthors
  );
  return [
    sections.section1,
    '',
    sections.section2,
    '',
    sections.section3,
    '',
    sections.section4,
    '',
    sections.section5,
    '',
    sections.section6,
  ].join('\n');
}

/**
 * Matches a top-level Master Report section heading line (`##` or `###`, excluding `####+`)
 * and returns its section number (`1` through `6`) or `null`.
 * When `expectedLevel` is provided (e.g. `2` for `##` or `3` for `###`), only headings at
 * that exact Markdown level are accepted so deeper subheadings (such as `### Forum Q&A digest`
 * or `### General Chat` under `## 5. Channel-by-Channel Breakdown`) are never misclassified
 * as top-level master sections.
 *
 * @param {string} line
 * @param {number|null} [expectedLevel=null]
 * @returns {number|null}
 */
export function matchMasterSectionHeading(line, expectedLevel = null) {
  const trimmed = String(line || '').trim();
  const levelMatch = trimmed.match(/^(#{2,3})\s+(.*)$/);
  if (!levelMatch) {
    return null;
  }
  const level = levelMatch[1].length;
  if (expectedLevel !== null && level !== expectedLevel) {
    return null;
  }
  const rest = levelMatch[2].trim();
  if (/^(?:1\.\s*)?Executive\s+Summary\b/i.test(rest)) return 1;
  if (
    /^(?:2\.\s*Forum.*Q\s*&\s*A|Forum\s*(?:&|and)\s*Q\s*&\s*A(?:\s+Channels|\s*[—–-]|\s+Most\s+Frequent|\s*$))/i.test(
      rest
    )
  ) {
    return 2;
  }
  if (
    /^(?:3\.\s*General\s+Chat|General\s+Chat(?:\s+Channels|\s*[—–-]|\s+Main\s+Discussion|\s*$))/i.test(
      rest
    )
  ) {
    return 3;
  }
  if (/^(?:4\.\s*)?Most\s+Frequently\s+Used\s+Keywords\b/i.test(rest)) return 4;
  if (/^(?:5\.\s*)?Channel-by-Channel\s+Breakdown\b/i.test(rest)) return 5;
  if (
    /^(?:6\.\s*)?(?:(?:Key\s+Contributors|Community\s+Participation|Participation\s+(?:Summary|Overview))\s*(?:&|and|—|-)\s*)?Meeting\s+Talking\s+Points\b/i.test(
      rest
    ) ||
    /^(?:6\.\s*)?Key\s+Contributors\b/i.test(rest)
  ) {
    return 6;
  }
  return null;
}

/**
 * Bounds a single top-level Master Report section while preserving its top-level heading
 * and any nested `###`/`####` subheadings.
 */
function boundMasterSectionText(sectionText, knownAuthors = []) {
  const raw = redactParticipantNames(String(sectionText || '').trim(), knownAuthors);
  if (!raw) return '';
  const lines = raw.split('\n');
  if (lines.length <= 1) return raw;

  const topHeading = lines[0];
  const bodyLines = lines.slice(1);

  // Split body by `###` or `####` subheadings (outside code fences) so subheadings are preserved intact
  const subBlocks = [];
  let currentSub = { heading: '', lines: [] };
  let inFence = false;
  for (const line of bodyLines) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      currentSub.lines.push(line);
      continue;
    }
    if (!inFence && /^#{3,4}\s+\S/.test(line.trim())) {
      if (currentSub.heading || currentSub.lines.some((l) => l.trim())) {
        subBlocks.push(currentSub);
      }
      currentSub = { heading: line.trim(), lines: [] };
    } else {
      currentSub.lines.push(line);
    }
  }
  if (currentSub.heading || currentSub.lines.some((l) => l.trim())) {
    subBlocks.push(currentSub);
  }

  const boundedParts = subBlocks
    .map((sb) => {
      const innerText = sb.lines.join('\n').trim();
      if (!innerText) return sb.heading || '';
      const combinedBlock = [sb.heading, innerText].filter(Boolean).join('\n');
      return enforceConciseDigest(combinedBlock, {
        maxTopicChars: 450,
        maxBulletsPerTopic: 2,
        maxTotalChars: 1500,
        knownAuthors,
      });
    })
    .filter(Boolean);

  if (boundedParts.length === 0) return '';

  return [topHeading, ...boundedParts].join('\n');
}

/**
 * Ensures the master report body always contains all 6 required sections in exact numerical
 * order (1. Executive Summary, 2. Forum & Q&A Doubts, 3. General Chat Topics, 4. Top Keywords
 * Across the Server, 5. Channel-by-Channel Breakdown, and 6. Meeting Talking Points & Action Items)
 * and places the authoritative deterministic FAQ and Keyword blocks directly inside Sections 2 and 4.
 */
function ensureCompleteMasterSections(llmBody, deterministicSections, knownAuthors = []) {
  const cleanLlm = redactParticipantNames(String(llmBody || '').trim(), knownAuthors);
  const lines = cleanLlm ? cleanLlm.split('\n') : [];
  const preambleLines = [];
  const sectionLinesMap = new Map();
  let currentSection = null;

  // Derive the heading level (2 for `##` or 3 for `###`) of the first top-level master section
  // so deeper subheadings (e.g. `###` under a `##` master section) are never treated as section boundaries.
  let topSectionLevel = null;
  for (const line of lines) {
    const matched = matchMasterSectionHeading(line);
    if (matched !== null) {
      const m = String(line || '').trim().match(/^(#{2,3})\s+/);
      if (m) {
        topSectionLevel = m[1].length;
        break;
      }
    }
  }

  for (const line of lines) {
    const matchedSection = matchMasterSectionHeading(line, topSectionLevel);
    if (matchedSection !== null) {
      currentSection = matchedSection;
      let normalizedLine = line;
      if (matchedSection === 6 && /Key\s+Contributors/i.test(line)) {
        const prefixMatch = String(line).trim().match(/^(#{2,3})\s+/);
        const hashes = prefixMatch ? prefixMatch[1] : '###';
        normalizedLine = `${hashes} 6. Meeting Talking Points & Action Items`;
      }
      if (!sectionLinesMap.has(currentSection)) {
        sectionLinesMap.set(currentSection, [normalizedLine]);
      } else {
        sectionLinesMap.get(currentSection).push(normalizedLine);
      }
    } else if (currentSection !== null) {
      sectionLinesMap.get(currentSection).push(line);
    } else {
      preambleLines.push(line);
    }
  }

  const preambleWithoutTopTitle = preambleLines
    .filter((l) => !/^#{1,2}\s+.*(?:retrospective|executive|support|discord|report)/i.test(l.trim()))
    .join('\n')
    .trim();
  const boundedPreamble = preambleWithoutTopTitle
    ? enforceConciseDigest(preambleWithoutTopTitle, {
        maxTopicChars: 450,
        maxBulletsPerTopic: 2,
        maxTotalChars: 800,
        knownAuthors,
      })
    : '';

  // Section 1: Executive Summary
  let sec1;
  if (sectionLinesMap.has(1)) {
    const llmSec1 = boundMasterSectionText(sectionLinesMap.get(1).join('\n').trim(), knownAuthors);
    sec1 = llmSec1 || (boundedPreamble ? `${deterministicSections.section1}\n\n${boundedPreamble}` : deterministicSections.section1);
  } else {
    sec1 = boundedPreamble
      ? `${deterministicSections.section1}\n\n${boundedPreamble}`
      : deterministicSections.section1;
  }

  // Section 2: Forum & Q&A Channels — Most Frequent Questions & Common Doubts (FAQ)
  const faqBodyWithoutHeading = String(deterministicSections.section2 || '')
    .split('\n')
    .slice(1)
    .join('\n')
    .trim();
  let sec2;
  if (sectionLinesMap.has(2)) {
    const llmSec2 = boundMasterSectionText(sectionLinesMap.get(2).join('\n').trim(), knownAuthors);
    if (llmSec2) {
      sec2 =
        faqBodyWithoutHeading && !llmSec2.includes(faqBodyWithoutHeading)
          ? `${llmSec2}\n\n#### Deterministic Forum & Q&A Resolution Breakdown (Authoritative)\n${faqBodyWithoutHeading}`
          : llmSec2;
    } else {
      sec2 = deterministicSections.section2;
    }
  } else {
    sec2 = deterministicSections.section2;
  }

  // Section 3: General Chat Channels — Main Discussion Topics & Community Vibe
  const llmSec3 = sectionLinesMap.has(3)
    ? boundMasterSectionText(sectionLinesMap.get(3).join('\n').trim(), knownAuthors)
    : '';
  const sec3 = llmSec3 || deterministicSections.section3;

  // Section 4: Most Frequently Used Keywords & Technical Terms (Server-wide & Per-Channel)
  const kwBodyWithoutHeading = String(deterministicSections.section4 || '')
    .split('\n')
    .slice(1)
    .join('\n')
    .trim();
  let sec4;
  if (sectionLinesMap.has(4)) {
    const llmSec4 = boundMasterSectionText(sectionLinesMap.get(4).join('\n').trim(), knownAuthors);
    if (llmSec4) {
      sec4 =
        kwBodyWithoutHeading && !llmSec4.includes(kwBodyWithoutHeading)
          ? `${llmSec4}\n\n${kwBodyWithoutHeading}`
          : llmSec4;
    } else {
      sec4 = deterministicSections.section4;
    }
  } else {
    sec4 = deterministicSections.section4;
  }

  // Section 5: Channel-by-Channel Breakdown
  const llmSec5 = sectionLinesMap.has(5)
    ? boundMasterSectionText(sectionLinesMap.get(5).join('\n').trim(), knownAuthors)
    : '';
  const sec5 = llmSec5 || deterministicSections.section5;

  // Section 6: Meeting Talking Points & Action Items
  const llmSec6 = sectionLinesMap.has(6)
    ? boundMasterSectionText(sectionLinesMap.get(6).join('\n').trim(), knownAuthors)
    : '';
  const sec6 = llmSec6 || deterministicSections.section6;

  return [sec1, sec2, sec3, sec4, sec5, sec6].filter(Boolean).join('\n\n');
}

/**
 * Generates a full 3-month Discord Support Server Report from an exported dataset
 * using a 3-level bounded Map-Reduce pipeline powered by DeepSeek (or local fallback).
 * Also writes individual per-channel Markdown reports (`data/reports/channels/<channel-name>.md`)
 * when saving to disk.
 *
 * @param {object} exportBundle - Output from exportGuildHistory() or loaded from server-export.json
 * @param {object} options
 * @param {number} [options.chunkSize]
 * @param {number} [options.maxReduceBatchSize=6]
 * @param {number} [options.maxPromptChars=24000]
 * @param {object} [options.llmConfig]
 * @param {Function} [options.fetchImpl]
 * @param {string} [options.reportOutputPath] - Optional file path to save the master Markdown report
 * @param {string|null} [options.channelReportsDir] - Optional directory path for per-channel Markdown reports
 * @param {string} [options.channelFilePrefix=''] - Optional filename prefix for per-channel Markdown reports (e.g. "demo-")
 * @param {Function} [options.onProgress]
 * @returns {Promise<{ markdownReport: string, channelDigests: Array<object>, channelReportPaths: Array<string>, globalStats: object, serverTopKeywords: Array<object>, qaSummary: object, providerUsed: string, reportPath: string|null }>}
 */
export async function generateServerSupportReport(
  exportBundle,
  {
    chunkSize = config.report.chunkSize,
    maxReduceBatchSize = 6,
    maxPromptChars = 24000,
    llmConfig = config.llm,
    fetchImpl = globalThis.fetch,
    reportOutputPath = path.join(config.report.dataDir, 'reports', 'support-report-3months.md'),
    channelReportsDir,
    channelFilePrefix = '',
    onProgress = () => {},
  } = {}
) {
  const channels = exportBundle.channels || [];
  const channelDigests = [];
  const allWindowMessages = [];
  // Server-wide author registry so a person who is an author in one channel is also neutralized
  // when merely mentioned in another channel (never written to reports or JSON).
  const preScanAuthors = collectKnownAuthors(
    channels.flatMap((c) => (Array.isArray(c?.messages) ? c.messages : [])),
    channels.flatMap((c) => (Array.isArray(c?.posts) ? c.posts : []))
  );

  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    onProgress({
      step: 'analyzing_channel',
      current: i + 1,
      total: channels.length,
      channelName: ch.channelName,
    });

    const digest = await summarizeChannelHistory(ch, {
      chunkSize,
      maxReduceBatchSize,
      maxPromptChars,
      llmConfig,
      fetchImpl,
      serverAuthors: preScanAuthors,
    });
    channelDigests.push(digest);

    const directWindowMsgs = (ch.messages || []).filter((m) => m && !m.contextOnly);
    const channelWindowMsgs =
      directWindowMsgs.length > 0 || !Array.isArray(ch.posts) || ch.posts.length === 0
        ? directWindowMsgs
        : ch.posts.flatMap((p) => (p.messages || []).filter((m) => m && !m.contextOnly));

    for (const m of channelWindowMsgs) {
      allWindowMessages.push(m);
    }
  }

  const { stats: globalStats } = buildTranscriptAndStats(allWindowMessages);
  const allExportPosts = channels.flatMap((ch) => (Array.isArray(ch.posts) ? ch.posts : []));
  const allRawMessages = channels.flatMap((ch) => (Array.isArray(ch.messages) ? ch.messages : []));
  const serverKnownAuthors = collectKnownAuthors(
    [...allRawMessages, ...allWindowMessages],
    allExportPosts,
    [...(globalStats.participants || []), ...preScanAuthors]
  );
  for (const d of channelDigests) {
    if (d.summary) {
      d.summary = enforceConciseDigest(d.summary, { knownAuthors: serverKnownAuthors });
    }
  }
  const serverTopKeywords = extractTopKeywords(allWindowMessages, {
    limit: 15,
    extraAuthors: serverKnownAuthors,
  });
  const aggregates = computeServerAggregateMetrics(channelDigests, exportBundle);
  const deterministicSections = buildDeterministicMasterSections(
    exportBundle,
    channelDigests,
    globalStats,
    serverTopKeywords,
    aggregates,
    serverKnownAuthors
  );

  const providerUsed =
    channelDigests.find((d) => d.providerUsed && d.providerUsed !== 'none')?.providerUsed ||
    'local-fallback';

  let executiveBody = '';
  const isRemoteActive =
    channelDigests.length > 0 &&
    !providerUsed.startsWith('local-fallback') &&
    providerUsed !== 'none';

  if (isRemoteActive) {
    onProgress({ step: 'synthesizing_master_report' });

    const serverKeywordsList = serverTopKeywords
      .slice(0, 15)
      .map((k) => `${k.word} (${k.count} occurrences across ${k.messageCount} messages)`)
      .join(', ');

    const qaOverviewLine =
      aggregates.qaSummary.totalQuestions > 0
        ? `${aggregates.qaSummary.totalQuestions} total questions/posts across ${aggregates.forumQaDigests.length} Forum/Q&A channels (${aggregates.qaSummary.confirmedCount} confirmed resolved, ${aggregates.qaSummary.heuristicAnsweredCount} heuristic/unconfirmed answer replies, ${aggregates.qaSummary.unansweredCount} unanswered)`
        : 'None';

    const channelBlocks = channelDigests.map((d) => {
      const kwLine =
        d.topKeywords && d.topKeywords.length > 0
          ? `Top Keywords: ${d.topKeywords.map((k) => `${k.word} (${k.count})`).join(', ')}`
          : 'Top Keywords: none';
      const qaLine = d.qaStats
        ? ` | Questions/Posts: ${d.qaStats.totalQuestions} (${d.qaStats.confirmedCount} confirmed, ${d.qaStats.heuristicAnsweredCount} heuristic/unconfirmed, ${d.qaStats.unansweredCount} unanswered)`
        : '';
      return `## Channel: #${d.channelName} [Type: ${d.channelType.toUpperCase()}] (Category: ${d.categoryName} | In-Window Messages: ${d.messageCount} | Participants: ${d.stats.participants.length}${qaLine})\n${kwLine}\n${d.summary}`;
    });

    const rawServerMetaBlock = [
      `Server Name: ${String(exportBundle.guildName || 'Support Server').slice(0, 140)}`,
      `Analysis Window: Last ${exportBundle.lookbackDays || 90} days (${(exportBundle.timeframeStart || globalStats.timeframeStart?.toISOString() || '').slice(0, 10) || 'N/A'} to ${(exportBundle.timeframeEnd || globalStats.timeframeEnd?.toISOString() || '').slice(0, 10) || 'N/A'})`,
      `Total In-Window Messages Analyzed: ${globalStats.totalMessages} across ${channelDigests.length} channels (${aggregates.forumQaDigests.length} Forum/Q&A, ${aggregates.chatDigests.length} General Chat)`,
      `Unique Participants Overall: ${globalStats.participants.length} (keep report anonymous; do not include usernames or handles)`,
      `Forum & Q&A Resolution Summary: ${qaOverviewLine}`,
      `Server-Wide Top Keywords (exact counts): ${(serverKeywordsList || 'N/A').slice(0, 700)}`,
    ].join('\n');
    const maxMetaChars = Math.max(300, Math.floor(Math.max(1000, maxPromptChars) * 0.35) - 180);
    const serverMetaBlock =
      rawServerMetaBlock.length > maxMetaChars
        ? rawServerMetaBlock.slice(0, maxMetaChars)
        : rawServerMetaBlock;

    try {
      const masterHeaderReserve = serverMetaBlock.length + 280;
      const rawLlmMaster = await reduceSummariesBounded(channelBlocks, {
        maxReduceBatchSize,
        maxPromptChars,
        headerReserve: masterHeaderReserve,
        consolidateBatch: async (batch, { pass, batchIndex, totalBatches, isFinalPass }) => {
          const batchInput = batch.join('\n\n---\n\n');
          if (!isFinalPass) {
            return callOpenAICompatibleLLM(batchInput, {
              channelName: `server-batch-${pass}-${batchIndex + 1}`,
              systemPrompt: MASTER_BATCH_CONSOLIDATION_PROMPT,
              customUserPrompt: `${serverMetaBlock}\n\nConsolidate the following channel digests (Pass ${pass}, Batch ${batchIndex + 1}/${totalBatches}):\n\n${batchInput}`,
              maxPromptChars,
              llmConfig,
              fetchImpl,
            });
          }

          const customUserPrompt = [
            serverMetaBlock,
            '',
            'Below are the consolidated summaries for the channels in the server:',
            '',
            batchInput,
          ].join('\n');

          return callOpenAICompatibleLLM(batchInput, {
            channelName: 'entire-server',
            systemPrompt: SERVER_MASTER_REPORT_PROMPT,
            customUserPrompt,
            maxPromptChars,
            llmConfig,
            fetchImpl,
          });
        },
      });

      executiveBody = ensureCompleteMasterSections(
        rawLlmMaster,
        deterministicSections,
        serverKnownAuthors
      );
    } catch (error) {
      console.warn(
        `[ReportGenerator] Master synthesis LLM call failed (${error.message}). Using structured digest fallback.`
      );
      executiveBody = buildFallbackMasterSynthesis(
        exportBundle,
        channelDigests,
        globalStats,
        serverTopKeywords,
        aggregates,
        serverKnownAuthors
      );
    }
  } else {
    executiveBody = buildFallbackMasterSynthesis(
      exportBundle,
      channelDigests,
      globalStats,
      serverTopKeywords,
      aggregates,
      serverKnownAuthors
    );
  }

  const windowStartStr =
    (exportBundle.timeframeStart || globalStats.timeframeStart?.toISOString() || '').slice(0, 10) ||
    'N/A';
  const windowEndStr =
    (exportBundle.timeframeEnd || globalStats.timeframeEnd?.toISOString() || '').slice(0, 10) ||
    'N/A';

  const headerLines = [
    `# Discord Support Server Retrospective Report (${exportBundle.lookbackDays || 90}-Day Analysis)`,
    '',
    `- **Server**: ${exportBundle.guildName || 'Support Discord Server'}`,
    `- **Analysis Window**: Last ${exportBundle.lookbackDays || 90} days (${windowStartStr} → ${windowEndStr})`,
    `- **Channels Analyzed**: ${channelDigests.length} (${aggregates.forumQaDigests.length} Forum/Q&A, ${aggregates.chatDigests.length} General Chat)`,
    `- **Total User Messages**: ${globalStats.totalMessages}`,
    `- **Unique Participants**: ${globalStats.participants.length}`,
  ];

  if (aggregates.qaSummary.totalQuestions > 0) {
    headerLines.push(
      `- **Forum & Q&A Questions**: ${aggregates.qaSummary.totalQuestions} (${aggregates.qaSummary.confirmedCount} confirmed resolved, ${aggregates.qaSummary.heuristicAnsweredCount} heuristic/unconfirmed answer replies, ${aggregates.qaSummary.unansweredCount} unanswered)`
    );
  }
  if (aggregates.skippedChannels.length > 0) {
    headerLines.push(
      `- **Skipped Inaccessible Channels**: ${aggregates.skippedChannels.length} (${aggregates.skippedChannels.map((s) => `#${s.channelName}`).join(', ')})`
    );
  }
  if (
    aggregates.truncatedChannels.length > 0 ||
    aggregates.qaSummary.inaccessibleThreadCount > 0 ||
    aggregates.qaSummary.budgetSkippedThreadCount > 0
  ) {
    headerLines.push(
      `- **Partial/Skipped Thread Counts**: ${aggregates.truncatedChannels.length} truncated channel(s), ${aggregates.qaSummary.inaccessibleThreadCount} inaccessible forum thread(s) skipped, ${aggregates.qaSummary.budgetSkippedThreadCount} budget-skipped forum thread(s)`
    );
  }

  headerLines.push(
    `- **AI Engine**: ${providerUsed}`,
    '',
    '---',
    '',
    executiveBody,
    ''
  );

  const markdownReport = headerLines.join('\n');

  const resolvedChannelReportsDir =
    channelReportsDir !== undefined
      ? channelReportsDir
      : reportOutputPath
        ? path.join(path.dirname(reportOutputPath), 'channels')
        : null;

  const channelReportPaths = [];
  if (resolvedChannelReportsDir) {
    await fs.mkdir(resolvedChannelReportsDir, { recursive: true });
    const safePrefix = String(channelFilePrefix || '');
    const baseCounts = new Map();
    const entries = channelDigests.map((d, idx) => {
      const base = `${safePrefix}${sanitizeName(d.channelName)}`;
      const idPart = sanitizeName(d.channelId || String(idx + 1));
      baseCounts.set(base.toLowerCase(), (baseCounts.get(base.toLowerCase()) || 0) + 1);
      return { digest: d, base, idPart };
    });

    const initialStemCounts = new Map();
    for (const entry of entries) {
      const isDuplicateBase = (baseCounts.get(entry.base.toLowerCase()) || 0) > 1;
      const initialStem = isDuplicateBase ? `${entry.base}-${entry.idPart}` : entry.base;
      entry.initialStem = initialStem;
      entry.isDuplicateBase = isDuplicateBase;
      initialStemCounts.set(
        initialStem.toLowerCase(),
        (initialStemCounts.get(initialStem.toLowerCase()) || 0) + 1
      );
    }

    const usedFileNames = new Set();
    for (const entry of entries) {
      const { digest, base, idPart, initialStem, isDuplicateBase } = entry;
      const stemHasCollision =
        (initialStemCounts.get(initialStem.toLowerCase()) || 0) > 1 ||
        usedFileNames.has(`${initialStem}.md`.toLowerCase());

      let preferredStem = initialStem;
      if (stemHasCollision && !isDuplicateBase) {
        preferredStem = `${base}-${idPart}`;
      }

      let candidateFileName = `${preferredStem}.md`;
      let counter = 2;
      while (usedFileNames.has(candidateFileName.toLowerCase())) {
        candidateFileName = `${preferredStem}-${counter++}.md`;
      }
      usedFileNames.add(candidateFileName.toLowerCase());

      const channelFilePath = path.join(resolvedChannelReportsDir, candidateFileName);
      const channelMarkdown = buildChannelMarkdownReport(digest, exportBundle);
      await writeTextFileAtomic(channelFilePath, channelMarkdown);
      digest.reportPath = channelFilePath;
      channelReportPaths.push(channelFilePath);
    }
  }

  let savedPath = null;
  if (reportOutputPath) {
    await writeTextFileAtomic(reportOutputPath, markdownReport);
    savedPath = reportOutputPath;
  }

  return {
    markdownReport,
    channelDigests,
    channelReportPaths,
    globalStats,
    serverTopKeywords,
    qaSummary: aggregates.qaSummary,
    providerUsed,
    reportPath: savedPath,
  };
}
