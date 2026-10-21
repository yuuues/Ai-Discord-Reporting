# Discord Server Exporter & DeepSeek Retrospective Analyzer (CLI)

A clean, two-phase **Node.js CLI tool in English** designed to export conversation histories from Discord servers (**Normal Text Chats** and **Forum Channels**) into local JSON files and generate structured **Markdown retrospective reports** using **DeepSeek** (`deepseek-flash` with automatic fallback to `deepseek-chat`) or a built-in deterministic offline analyzer.

Built for preparing **JetBrains Ambassador follow-up meeting reports** with channel-type aware analysis:
- **Forum & Q&A Channels** (e.g., `#🆘-support`, `#💡-feature-requests`, `#🧩-github-feedback`): Groups threads/posts as structured *Question + Replies* units, identifies the **most frequent doubts (FAQ)**, distinguishes **confirmed resolutions** from **heuristic/unconfirmed answer replies**, and lists **unanswered threads**.
- **Normal Chat Channels** (e.g., `#💬-chat`, `#🏅-junie-ambassadors`): Summarizes the **main discussion topics**, captures community sentiment/vibe, and computes **exact keyword frequency rankings** (filtering English and Spanish stop words).

---

## Important Notice: Discord Terms of Service, Token Risks & Compliant Alternatives

Please read this before configuring Phase 1 (`npm run list-channels` or `npm run export-server`):

1. **No Official Discord User-Token API**: Discord does **not** provide an official or supported user-token API for personal accounts. Using a personal account token (`DISCORD_USER_TOKEN`) to automate requests ("self-bot" usage) **violates Discord's Terms of Service**.
2. **Account & Undocumented API Risks**: Automating a personal Discord account can **jeopardize your account** (including rate-limiting, temporary restrictions, or permanent account termination), and undocumented user-account REST behavior may change or stop working at any time without notice.
3. **No Credential Extraction Instructions**: Because Discord does not offer an officially supported way to issue personal user tokens, this documentation intentionally does **not** provide instructions for extracting secret tokens from browser DevTools, local storage, or network inspectors.
4. **Officially Compliant Alternatives & Their Limitations**:
   - **Admin-Approved Bot Integration (Requires Separate Exporter)**: Discord's officially compliant automation method is creating a Bot application in the [Discord Developer Portal](https://discord.com/developers/applications) (`Authorization: Bot <token>`) with the *Message Content Intent* and having a **Server Administrator** invite the bot with `View Channels` and `Read Message History` permissions. *Limitations*: (a) Regular community members or ambassadors who are not administrators on a third-party server cannot invite a bot to that server, and (b) this CLI's Phase 1 exporter is built specifically for a raw user token (`Authorization: <DISCORD_USER_TOKEN>`) and does **not** support `Bot <token>` authentication—using a Discord Bot requires a separate bot-token exporter to produce `data/exports/server-export.json`.
   - **Independently Supplied JSON Analysis (`npm run generate-report` / `npm run demo`)**: If using a personal account token is unacceptable for your environment, you can skip Phase 1 entirely and supply `data/exports/server-export.json` from an external compliant source (or run `npm run demo`). Phase 2 (`npm run generate-report`) makes **no Discord connection** and never reads `DISCORD_USER_TOKEN`; it only calls the DeepSeek API when `DEEPSEEK_API_KEY` is configured (or runs 100% locally with zero network calls when `LLM_PROVIDER=fallback` or no API key is set). See the [Exported JSON Schema](#exported-json-schema-for-independent-imports) below for the required file format.

---

## Architecture Overview (Two-Phase CLI)

```text
Phase 1: Read-Only Export (Optional — connects to Discord REST API v10)
  npm run list-channels  ──► Inspect server channels & types (CHAT / FORUM / QA)
  npm run export-server  ──► Paginate messages & Forum threads (active + archived)
                             with 350ms pacing & HTTP 429 Retry-After handling
                             └──► Saves data/exports/server-export.json
                                  + data/exports/<channel-name>-<id>.json

Phase 2: Hybrid DeepSeek Analysis (No Discord connection required)
  npm run generate-report ──► Reads data/exports/server-export.json locally
   ├─► Deterministic Pass: Exact keyword frequencies + Forum/Q&A resolution counts
   └─► DeepSeek Map-Reduce: QA_SYSTEM_PROMPT (Forums) & GENERAL_CHAT_SYSTEM_PROMPT (Chats)
        ├──► Per-Channel Reports: data/reports/channels/<channel>.md
        └──► Executive Master Report: data/reports/support-report-3months.md
```

### Report Format & Privacy

- **Concise Channel Digest Budgets**: Each `## Channel Digest` is kept presentation-friendly with at most **4–6 core topics per section**, **at most 2 bullets per topic**, **300–450 characters per topic** (`<= 450` chars maximum), and **1,500–2,000 characters total** (`<= 2,000` chars maximum). If a single-chunk or multi-chunk LLM draft exceeds either the total budget or the per-topic budget, Phase 2 runs an automatic AI re-compression pass (when a remote LLM is active) followed by clean sentence/clause boundary enforcement (`enforceConciseDigest`) so key decisions and open uncertainties at the end of a topic are preserved without mid-word truncation.
- **Anonymous Reporting (No Person Names or Contributor Rankings)**: Prompts, transcripts sent to the LLM, deterministic keyword rankings, per-channel reports, and the master report omit all person names (including participants, given names from multi-word display names, and staff or people mentioned in messages), usernames, `@handles`, and per-speaker message count rankings. Only aggregate counts (`Unique Participants`) are reported, while genuine product and technical terms (such as `Claude Code`, `VS Code`, `JetBrains Air`, `Max plan`, `Mellum`, `WebStorm`, `@workspace`, and `@Override`) are preserved intact.
- **Executive Master Report Structure (`data/reports/support-report-3months.md`)**:
  1. `### 1. Executive Summary`
  2. `### 2. Forum & Q&A Channels — Most Frequent Questions & Common Doubts (FAQ)` (with authoritative deterministic resolution breakdown)
  3. `### 3. General Chat Channels — Main Discussion Topics & Community Vibe`
  4. `### 4. Most Frequently Used Keywords & Technical Terms (Server-wide & Per-Channel)`
  5. `### 5. Channel-by-Channel Breakdown`
  6. `### 6. Meeting Talking Points & Action Items` (anonymous participation summary and actionable follow-ups)

---

## Quick Start & Actionable `.env` Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Run the Built-In `1 Chat + 1 Forum` Demo (Zero Credentials Required)

Test the entire pipeline immediately offline using the built-in sample dataset (`#💬-chat` and `#🆘-support`):

```bash
npm run demo
```

This runs in local deterministic fallback mode (making zero Discord or DeepSeek network calls) and generates segregated demo reports that will not overwrite live server reports:
- Master report: `data/reports/demo-support-report-3months.md`
- Per-channel demo reports: `data/reports/channels/demo-chat.md` and `data/reports/channels/demo-support.md`

### 3. Create Your `.env` File

Copy `.env.example` to `.env`:

```bash
# macOS / Linux / Git Bash
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

### 4. Obtain `DISCORD_GUILD_ID` via Discord Developer Mode

1. Open Discord and go to **User Settings (gear icon) → Advanced**.
2. Enable **Developer Mode**.
3. In your server list on the left sidebar, **right-click the server icon** (for example, your test server or the Junie Discord server) and select **Copy Server ID**.
4. Paste that numeric ID into `DISCORD_GUILD_ID` in your `.env` file.

### 5. Fill In `.env` Fields (Placeholder vs. Actual Values)

Open `.env` and replace the placeholder values with your actual configuration:

```dotenv
# BEFORE (placeholders in .env.example — rejected by the CLI):
DISCORD_USER_TOKEN=your_discord_user_token_here
DISCORD_GUILD_ID=
DEEPSEEK_API_KEY=your_deepseek_api_key_here

# AFTER (example format — never commit or share real tokens):
DISCORD_USER_TOKEN=paste_raw_token_value_without_bot_prefix
DISCORD_GUILD_ID=123456789012345678
DISCORD_REQUEST_DELAY_MS=350

LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-your-real-deepseek-api-key
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-flash
```

#### Critical Rules for `DISCORD_USER_TOKEN`
- **Replace the placeholder**: The CLI checks for `your_discord_user_token_here` (and empty values) and will exit with an error if the placeholder is left unchanged.
- **Enter the raw token only (no `Bot ` or `Bearer ` prefix)**: Do **not** prepend `Bot ` or `Bearer ` to `DISCORD_USER_TOKEN`. The REST client sends `Authorization: <DISCORD_USER_TOKEN>` directly without stripping prefixes, and the CLI rejects tokens starting with `Bot ` or `Bearer `.
- **Never commit or share your token or exports**: Treat `DISCORD_USER_TOKEN` and `DEEPSEEK_API_KEY` like passwords. Both `.env` and `data/exports/` (which contains exported Discord conversations) are listed in `.gitignore`—never paste real tokens or private server exports into issues, commits, or shared screenshots.
- **Not needed for Phase 2**: If you only run `npm run generate-report` or `npm run demo`, you can leave `DISCORD_USER_TOKEN` blank.

### Environment Variables Reference

| Variable | Default in `src/config.js` | Description |
| :--- | :--- | :--- |
| `DISCORD_USER_TOKEN` | *(empty)* | Personal Discord token for Phase 1 REST v10 export (enter raw token value, no `Bot ` prefix; fallback variable: `DISCORD_TOKEN`). Not used in `--report` or `demo`. |
| `DISCORD_GUILD_ID` | *(empty)* | Target Discord Server (Guild) ID obtained via Discord Developer Mode (*Right-click server → Copy Server ID*). |
| `DISCORD_REQUEST_DELAY_MS` | `350` | Polite delay in milliseconds between paginated Discord REST requests. |
| `LLM_PROVIDER` | `deepseek` | AI engine for Phase 2: `deepseek`, `openai`, or `fallback` (100% local deterministic mode). |
| `DEEPSEEK_API_KEY` | *(empty)* | API key from [DeepSeek Platform](https://platform.deepseek.com/) (fallback variable: `LLM_API_KEY`). If omitted, Phase 2 automatically falls back to local deterministic analysis. |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI-compatible chat completions base URL. |
| `LLM_MODEL` | `deepseek-flash` | Primary model name. Automatically retries with `deepseek-chat` if the endpoint returns HTTP 400/404 for `deepseek-flash`. |
| `REPORT_LOOKBACK_DAYS` | `90` | Days of conversation history to export and analyze (90 days = 3 months). |
| `REPORT_MAX_MESSAGES_PER_CHANNEL` | `5000` | Maximum messages exported per channel (`0` = unlimited within lookback window). |
| `REPORT_CHUNK_SIZE` | `150` | Messages per chunk during Map-Reduce summarization (minimum `20`). |
| `REPORT_INCLUDE_CHANNELS` | *(empty)* | Optional comma-separated allowlist of channel names or IDs to export (e.g., `chat,support` matches `#💬-chat` and `#🆘-support`). |
| `REPORT_EXCLUDE_CHANNELS` | *(empty)* | Comma-separated channel names or IDs to skip during export (defaults to empty in `src/config.js`; `.env.example` pre-populates a sample list `announcements,rules,...`). |
| `REPORT_QA_CHANNELS` | `question,questions,pregunta,preguntas,duda,dudas,help,ayuda,support,soporte,faq,troubleshoot,troubleshooting,bug,bugs,issue,issues,install,installation,setup,ask` | Comma-separated patterns used to classify text channels as Q&A channels (`channelType: "qa"`). Discord Forum channels (`type === 15`) are always classified as `"forum"`. |
| `DATA_DIR` | `data` | Base directory where `exports/` and `reports/` are written. |

---

## Exported JSON Schema (For Independent Imports)

If you supply `data/exports/server-export.json` independently (to run `npm run generate-report` without Phase 1), use the following JSON structure:

```json
{
  "guildId": "1234567890",
  "guildName": "Server Name",
  "exportedAt": "2026-10-21T00:00:00.000Z",
  "lookbackDays": 90,
  "timeframeStart": "2026-07-23T00:00:00.000Z",
  "timeframeEnd": "2026-10-21T00:00:00.000Z",
  "totalChannels": 2,
  "totalMessages": 2,
  "channels": [
    {
      "channelId": "111",
      "channelName": "💬-chat",
      "categoryName": "General",
      "channelType": "chat",
      "messages": [
        {
          "id": "101",
          "author": "alice",
          "content": "Message text here",
          "attachments": [],
          "timestamp": "2026-10-15T12:00:00.000Z"
        }
      ]
    },
    {
      "channelId": "222",
      "channelName": "🆘-support",
      "categoryName": "Support",
      "channelType": "forum",
      "posts": [
        {
          "postId": "2001",
          "title": "How to configure DeepSeek API key?",
          "author": "bob",
          "createdAt": "2026-10-10T10:00:00.000Z",
          "starterQuestion": "How do I set up DEEPSEEK_API_KEY?",
          "replyCount": 1,
          "answered": true,
          "confirmed": true,
          "tags": ["configuration"],
          "messages": [
            {
              "id": "201",
              "author": "bob",
              "content": "[Forum Post: \"How to configure DeepSeek API key?\"] How do I set up DEEPSEEK_API_KEY?",
              "attachments": [],
              "timestamp": "2026-10-10T10:00:00.000Z"
            },
            {
              "id": "202",
              "author": "elena_support",
              "content": "Set DEEPSEEK_API_KEY in your .env file.",
              "attachments": [],
              "timestamp": "2026-10-10T10:05:00.000Z"
            }
          ]
        }
      ],
      "messages": []
    }
  ]
}
```
- `channelType`: `"chat"` (normal text discussions & keyword analysis), `"forum"` (structured forum `posts[]` + Q&A analysis), or `"qa"` (text Q&A channel).

---

## Step-by-Step Usage Workflow

### Step 1: Test on a Small Server (`1 Chat + 1 Forum`)

Before exporting a large production community, validate your setup on a small test server containing 1 general chat (e.g., `#💬-chat`) and 1 support forum (e.g., `#🆘-support`):

1. Set `DISCORD_GUILD_ID` in `.env` to your test server ID (and optionally set `REPORT_INCLUDE_CHANNELS=chat,support`).
2. **Inspect accessible channels first** (makes no export files and no AI calls):
   ```bash
   npm run list-channels
   ```
3. **Run Phase 1 (Export to JSON)**:
   ```bash
   npm run export-server
   ```
   Verify that `data/exports/server-export.json` and the individual channel JSON files are created.
4. **Run Phase 2 (Generate Markdown Reports with DeepSeek)**:
   ```bash
   npm run generate-report
   ```
   Verify the generated reports in:
   - `data/reports/channels/chat.md`
   - `data/reports/channels/support.md`
   - `data/reports/support-report-3months.md`

### Step 2: Export & Analyze the Junie Discord Server

1. Update `DISCORD_GUILD_ID` in `.env` to the target server ID (and adjust or clear `REPORT_INCLUDE_CHANNELS` if you want all readable channels, or list specific channels such as `chat,junie-ambassadors,support,feature-requests,github-feedback`).
2. Preview which channels will be included:
   ```bash
   npm run list-channels
   ```
3. Download the 90-day conversation history once:
   ```bash
   npm run export-server
   ```
4. Generate (or re-generate anytime from the local JSON without re-downloading from Discord) the DeepSeek Markdown reports:
   ```bash
   npm run generate-report
   ```
   *(Tip: You can also run both Phase 1 and Phase 2 in a single command with `npm run analyze-server`.)*

---

## Available NPM Scripts

| Command | Description |
| :--- | :--- |
| `npm run list-channels` | Lists and classifies channels (`CHAT`, `FORUM`, `QA`) in `DISCORD_GUILD_ID` without exporting or running AI. |
| `npm run export-server` | **Phase 1 only**: Exports 90-day chat & forum history to `data/exports/server-export.json` (no AI calls). |
| `npm run generate-report` | **Phase 2 only**: Analyzes `data/exports/server-export.json` with DeepSeek (when `DEEPSEEK_API_KEY` is set) or local fallback and writes per-channel + master Markdown reports (no Discord calls). |
| `npm run analyze-server` | Runs Phase 1 (`export-server`) followed immediately by Phase 2 (`generate-report`). |
| `npm run demo` | Runs the offline `1 Chat + 1 Forum` (`#💬-chat` + `#🆘-support`) demo and writes `data/reports/demo-support-report-3months.md` and `data/reports/channels/demo-*.md`. |
| `npm test` | Runs the automated test suite (`node --test tests/*.test.js`). |

---

## Running Tests

```bash
npm test
```
