import { config } from '../config.js';
import {
  determineForumPostAnswered,
  resolveForumAppliedTagNames,
} from './discordUserClient.js';
import { buildTranscriptAndStats } from './messageFetcher.js';

const STOP_WORDS = new Set([
  // English stop words
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'not', 'are', 'from',
  'your', 'all', 'have', 'new', 'more', 'an', 'was', 'we', 'will', 'can',
  'about', 'if', 'my', 'has', 'but', 'our', 'one', 'other', 'do', 'no',
  'they', 'what', 'up', 'out', 'so', 'when', 'which', 'their', 'said',
  'its', 'just', 'like', 'been', 'would', 'could', 'should', 'some', 'into',
  'than', 'then', 'them', 'these', 'also', 'how', 'who', 'where', 'why',
  'yes', 'yeah', 'hey', 'hello', 'thanks', 'thank', 'okay', 'ok', 'lol',
  'there', 'were', 'does', 'did', 'had', 'having', 'here', 'most', 'much',
  'many', 'such', 'each', 'every', 'both', 'through', 'during', 'before',
  'after', 'above', 'below', 'between', 'under', 'again', 'further', 'once',
  'same', 'able', 'need', 'want', 'know', 'think', 'make', 'made', 'using',
  'used', 'work', 'working', 'works', 'still', 'even', 'well', 'good',
  'great', 'guys', 'anyone', 'someone', 'everyone', 'something', 'anything',
  'nothing', 'really', 'very', 'only', 'over', 'back', 'after', 'first',
  'attached', 'attachment', 'attachments', 'forum', 'post',
  // Spanish stop words
  'para', 'como', 'pero', 'más', 'mas', 'este', 'esta', 'esto', 'estos',
  'estas', 'ese', 'esa', 'eso', 'esos', 'esas', 'todo', 'toda', 'todos',
  'todas', 'algo', 'alguien', 'alguno', 'alguna', 'algunos', 'algunas',
  'nada', 'nadie', 'otro', 'otra', 'otros', 'otras', 'mismo', 'misma',
  'tienen', 'tiene', 'tener', 'tengo', 'hacer', 'hace', 'hacen', 'hecho',
  'puede', 'pueden', 'puedo', 'poder', 'está', 'están', 'estan', 'estar',
  'estoy', 'cuando', 'donde', 'dónde', 'cómo', 'porque', 'porqué', 'quien',
  'quién', 'cual', 'cuál', 'sobre', 'entre', 'hasta', 'desde', 'hacia',
  'también', 'tambien', 'solo', 'sólo', 'sino', 'cada', 'muy', 'bien',
  'aquí', 'aqui', 'allí', 'alli', 'ahora', 'antes', 'después', 'despues',
  'siempre', 'nunca', 'hola', 'gracias', 'buenas', 'buenos', 'sabe',
  'sería', 'seria', 'había', 'habia', 'hay', 'son', 'era', 'eran', 'fue',
  'fueron', 'sea', 'sean', 'del', 'las', 'los', 'una', 'uno', 'unos',
  'unas', 'con', 'sin', 'por', 'qué', 'que', 'nos', 'les', 'mis', 'sus',
  'eso', 'así', 'asi', 'creo', 'pues', 'vale', 'claro', 'toda', 'poco',
]);

const SHORT_TECH_TERMS = new Set([
  'api', 'cli', 'ide', 'llm', 'mcp', 'wsl', 'ssh', 'git', 'ram', 'cpu',
  'gpu', 'sdk', 'bug', 'pro', 'eap', 'env', 'sql', 'php', 'css', 'jwt',
  'aws', 'url', 'npm', 'bot', 'ai', 'pr', 'ci', 'cd', 'ui', 'ux', 'os',
]);

const PROTECTED_TECH_AND_PRODUCT_TERMS = new Set([
  ...STOP_WORDS,
  ...SHORT_TECH_TERMS,
  'jetbrains', 'junie', 'deepseek', 'deepseek-flash', 'deepseek-chat', 'deepseek-reasoner',
  'deepseek-v3', 'deepseek-r1', 'intellij', 'idea', 'webstorm', 'pycharm', 'phpstorm',
  'goland', 'rider', 'clion', 'rubymine', 'datagrip', 'dataspell', 'aqua', 'fleet',
  'gateway', 'space', 'youtrack', 'teamcity', 'mps', 'kotlin', 'android', 'studio',
  'resharper', 'qodana', 'grazie', 'assistant', 'github', 'gitlab', 'bitbucket',
  'copilot', 'openai', 'chatgpt', 'gpt', 'gpt-4', 'gpt-4o', 'anthropic', 'claude',
  'sonnet', 'haiku', 'opus', 'google', 'gemini', 'ollama', 'groq', 'together',
  'mistral', 'llama', 'microsoft', 'vscode', 'cursor', 'windsurf', 'zed', 'docker',
  'kubernetes', 'wsl', 'wsl2', 'wslg', 'linux', 'ubuntu', 'debian', 'fedora', 'arch',
  'windows', 'macos', 'apple', 'amazon', 'aws', 'azure', 'gcp', 'cloudflare', 'vercel',
  'netlify', 'supabase', 'firebase', 'postgres', 'postgresql', 'mysql', 'mariadb',
  'sqlite', 'redis', 'mongodb', 'kafka', 'rabbitmq', 'elasticsearch', 'opensearch',
  'prisma', 'drizzle', 'hibernate', 'typeorm', 'sequelize', 'sqlalchemy', 'pydantic',
  'fastapi', 'flask', 'django', 'spring', 'springboot', 'quarkus', 'micronaut', 'ktor',
  'gradle', 'maven', 'sbt', 'ant', 'bazel', 'cmake', 'make', 'ninja', 'cargo', 'rustc',
  'rustup', 'golang', 'python', 'pip', 'poetry', 'conda', 'venv', 'virtualenv', 'pyenv',
  'node', 'nodejs', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'typescript', 'javascript',
  'ecmascript', 'react', 'nextjs', 'vue', 'nuxt', 'angular', 'svelte', 'sveltekit',
  'vite', 'webpack', 'rollup', 'esbuild', 'swc', 'turbopack', 'babel', 'eslint',
  'prettier', 'biome', 'jest', 'vitest', 'mocha', 'chai', 'playwright', 'cypress',
  'selenium', 'puppeteer', 'junit', 'pytest', 'rspec', 'phpunit', 'git', 'svn',
  'mercurial', 'ssh', 'tls', 'ssl', 'http', 'https', 'http2', 'http3', 'grpc',
  'graphql', 'rest', 'websocket', 'websockets', 'json', 'jsonb', 'yaml', 'toml',
  'xml', 'html', 'css', 'sass', 'less', 'tailwind', 'bootstrap', 'jwt', 'oauth',
  'oauth2', 'oidc', 'saml', 'ldap', 'cors', 'csrf', 'xss', 'sql', 'nosql', 'api',
  'apis', 'cli', 'sdk', 'ide', 'ides', 'llm', 'llms', 'mcp', 'rag', 'agent', 'agents',
  'subagent', 'subagents', 'token', 'tokens', 'quota', 'quotas', 'credit', 'credits',
  'license', 'licenses', 'licensing', 'subscription', 'subscriptions', 'billing',
  'plan', 'plans', 'tier', 'tiers', 'top-up', 'topup', 'eap', 'pro', 'ultimate',
  'community', 'enterprise', 'team', 'teams', 'organization', 'ambassador', 'ambassadors',
  'discord', 'slack', 'telegram', 'discourse', 'forum', 'forums', 'thread', 'threads',
  'channel', 'channels', 'server', 'servers', 'guild', 'bot', 'bots', 'user', 'users',
  'member', 'members', 'developer', 'developers', 'engineer', 'engineers', 'participant',
  'participants', 'contributor', 'contributors', 'support', 'staff', 'admin', 'admins',
  'moderator', 'moderators', 'author', 'asker', 'starter', 'reply', 'replies',
  'question', 'questions', 'answer', 'answers', 'solution', 'solutions', 'resolution',
  'resolutions', 'issue', 'issues', 'bug', 'bugs', 'error', 'errors', 'fix', 'fixes',
  'workaround', 'workarounds', 'feature', 'features', 'request', 'requests', 'feedback',
  'summary', 'summaries', 'digest', 'digests', 'report', 'reports', 'markdown',
  'export', 'exports', 'exporter', 'analyzer', 'chunk', 'chunks', 'batch', 'batches',
  'window', 'lookback', 'rate', 'limit', 'limits', 'retry', 'timeout', 'timeouts',
  'memory', 'heap', 'garbage', 'collection', 'cpu', 'gpu', 'ram', 'ssd', 'disk',
  'network', 'proxy', 'vpn', 'firewall', 'dns', 'ipv4', 'ipv6', 'localhost', 'port',
  'socket', 'container', 'containers', 'image', 'images', 'volume', 'volumes',
  'compose', 'dockerfile', 'plugin', 'plugins', 'extension', 'extensions', 'settings',
  'config', 'configuration', 'env', 'dotenv', 'variable', 'variables', 'key', 'keys',
  'secret', 'secrets', 'endpoint', 'endpoints', 'model', 'models', 'fallback',
  'prompt', 'prompts', 'context', 'budget', 'truncation', 'pagination', 'snowflake',
  'snowflakes', 'archive', 'archived', 'active', 'public', 'private', 'tag', 'tags',
  'solved', 'resolved', 'confirmed', 'unconfirmed', 'heuristic', 'unanswered',
  'pending', 'open', 'closed', 'overview', 'highlights', 'topics', 'keywords',
  'faq', 'faqs', 'doubts', 'doubt', 'vibe', 'sentiment', 'action', 'items', 'talking',
  'points', 'meeting', 'retrospective', 'phase', 'step', 'steps', 'mode', 'modes',
  'flag', 'flags', 'script', 'scripts', 'test', 'tests', 'unit', 'integration',
  'benchmark', 'benchmarks', 'migration', 'refactoring', 'workflow', 'workflows',
  'terminal', 'shell', 'bash', 'powershell', 'zsh', 'cmd', 'java', 'rust', 'swift',
  'dart', 'flutter', 'scala', 'elixir', 'lua', 'perl', 'csharp', 'cpp', 'dotnet',
  'laravel', 'symfony', 'rails', 'express', 'fastify', 'nestjs', 'llm_provider',
  'deepseek_api_key', 'discord_request_delay_ms', 'llm_base_url', 'llm_model',
  'discord_user_token', 'discord_guild_id', 'retry-after',
  'code', 'air', 'max', 'mellum', 'cloud', 'dev', 'devs', 'mini', 'nano', 'flash',
  'plus', 'ultra', 'coder', 'chat', 'chats', 'voice', 'vision', 'canvas', 'artifacts',
  'worktrees', 'acp', 'a2a', 'trial', 'trials', 'beta', 'alpha', 'rc', 'nightly',
  'stable', 'canary', 'insider', 'insiders', 'toolbox', 'kineto', 'amper', 'kmp',
  'coroutines', 'exposed', 'koog', 'upsource', 'hub', 'datalore', 'writerside',
  'rustrover', 'o1', 'o3', 'v3', 'r1',
]);

const ROLE_OR_TITLE_WORDS = new Set([
  'admin', 'admins', 'moderator', 'moderators', 'mod', 'mods', 'staff', 'support',
  'bot', 'bots', 'member', 'members', 'user', 'users', 'guest', 'guests', 'official',
  'team', 'lead', 'leads', 'manager', 'director', 'engineer', 'engineers', 'developer',
  'developers', 'ambassador', 'ambassadors', 'wizard', 'master', 'captain', 'chief',
  'boss', 'owner', 'founder', 'creator', 'author', 'helper', 'tester', 'reviewer',
  'contributor', 'contributors', 'gaming', 'live', 'real', 'mr', 'mrs', 'ms', 'dr',
  'prof', 'sir', 'speaker', 'speakers', 'participant', 'participants',
]);

const COMMON_CAPITALIZED_NON_NAMES = new Set([
  'however', 'therefore', 'meanwhile', 'furthermore', 'moreover', 'although', 'because',
  'otherwise', 'instead', 'currently', 'previously', 'recently', 'finally', 'overall',
  'generally', 'specifically', 'particularly', 'notably', 'importantly', 'thankfully',
  'hopefully', 'unfortunately', 'apparently', 'obviously', 'clearly', 'simply', 'basically',
  'actually', 'usually', 'normally', 'typically', 'occasionally', 'frequently', 'sometimes',
  'always', 'never', 'perhaps', 'maybe', 'please', 'thanks', 'thank', 'hello', 'welcome',
  'warning', 'caution', 'important', 'note', 'notice', 'summary', 'overview', 'section',
  'chapter', 'part', 'step', 'phase', 'example', 'table', 'figure', 'channel', 'server',
  'forum', 'thread', 'message', 'messages', 'question', 'questions', 'answer', 'answers',
  'solution', 'solutions', 'resolution', 'resolutions', 'confirmed', 'unconfirmed',
  'unanswered', 'heuristic', 'resolved', 'solved', 'pending', 'active', 'archived',
  'public', 'private', 'general', 'support', 'community', 'feedback', 'announcements',
  'rules', 'resources', 'showcase', 'introductions', 'offtopic', 'random', 'english',
  'spanish', 'german', 'french', 'russian', 'chinese', 'japanese', 'korean', 'polish',
  'italian', 'portuguese', 'dutch', 'ukrainian', 'czech', 'turkish', 'arabic', 'hindi',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january',
  'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'spring', 'summer', 'autumn', 'winter', 'europe', 'america',
  'asia', 'africa', 'australia', 'settings', 'preferences', 'options', 'tools', 'window',
  'help', 'file', 'edit', 'view', 'navigate', 'refactor', 'build', 'run', 'debug', 'vcs',
  'terminal', 'profiler', 'services', 'database', 'notifications', 'plugins', 'marketplace',
  'appearance', 'keymap', 'editor', 'project', 'projects', 'structure', 'bookmarks', 'todo',
  'problems', 'hierarchy', 'endpoints', 'commit', 'pull', 'push', 'merge', 'rebase',
  'branch', 'branches', 'stash', 'history', 'log', 'diff', 'patch', 'monthly', 'weekly',
  'daily', 'yearly', 'annual', 'unused', 'additional', 'repeated', 'detailed', 'multiple',
  'several', 'various', 'certain', 'common', 'frequent', 'recurring', 'notable', 'shared',
  'restart', 'update', 'reinstall', 'rollback', 'downgrade', 'upgrade', 'invalidate', 'reset',
  'reload', 'retry', 'rebuild', 'clear', 'disable', 'enable', 'install', 'uninstall', 'delete',
  'remove', 'nobody', 'everybody', 'everyone', 'anyone', 'anybody', 'someone', 'somebody',
  'others', 'other', 'all', 'both', 'folks', 'guys', 'today', 'yesterday', 'tomorrow',
  'tonight', 'weekend', 'morning', 'evening', 'docs', 'customer', 'customers', 'sales',
  'billing', 'security', 'company',
]);

/**
 * Genuine product/company names that must never be treated as participant names, even if a
 * participant's display name happens to equal one of them.
 */
const NEVER_REDACT_PRODUCT_TERMS = new Set([
  'jetbrains', 'junie', 'deepseek', 'deepseek-flash', 'deepseek-chat', 'webstorm',
  'intellij', 'pycharm', 'docker', 'wsl2', 'typescript', 'postgresql',
]);

/**
 * `@participant` syntax used by IDE/chat tools (e.g. `@workspace`, `@terminal`, `@vscode`) and
 * documentation tags (`{@code}`, `{@link}`). These are tool commands, never people.
 */
const TOOL_AT_TOKENS = new Set([
  'workspace', 'terminal', 'vscode', 'github', 'azure', 'docs', 'codebase', 'selection',
  'file', 'editor', 'project', 'web', 'agent', 'ide', 'code', 'link', 'linkplain',
  'inheritdoc', 'author', 'value', 'literal', 'docroot', 'tutorial', 'mcp', 'junie',
  'jetbrains', 'deepseek',
]);

const CODE_ANNOTATION_AND_DIRECTIVE_TERMS = new Set([
  'override', 'deprecated', 'suppresswarnings', 'nullable', 'notnull', 'nonnull',
  'autowired', 'injectable', 'component', 'service', 'repository', 'controller',
  'restcontroller', 'configuration', 'bean', 'transactional', 'entity', 'table',
  'column', 'id', 'generatedvalue', 'onetomany', 'manytoone', 'manytomany',
  'onetoone', 'joincolumn', 'query', 'param', 'returns', 'return', 'type',
  'typedef', 'template', 'property', 'prop', 'example', 'throws', 'exception',
  'see', 'since', 'version', 'readonly', 'internal', 'public', 'private',
  'protected', 'abstract', 'implements', 'extends', 'enum', 'callback', 'async',
  'await', 'media', 'keyframes', 'import', 'charset', 'supports', 'layer',
  'tailwind', 'apply', 'screen', 'config', 'plugin', 'utility', 'variant',
  'custom-variant', 'test', 'beforeeach', 'aftereach', 'beforeall', 'afterall',
  'disabled', 'ignore', 'jvmstatic', 'jvmoverloads', 'jvmfield', 'composable',
  'preview', 'remember', 'dataclass', 'serializable', 'jsonproperty', 'jsonignore',
  'postmapping', 'getmapping', 'putmapping', 'deletemapping', 'patchmapping',
  'requestmapping', 'requestbody', 'requestparam', 'pathvariable',
]);

export const DEFAULT_MAX_TOPIC_CHARS = 450;
export const DEFAULT_MAX_BULLETS_PER_TOPIC = 2;
export const DEFAULT_MAX_DIGEST_CHARS = 2000;

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isProtectedTerm(candidate) {
  if (!candidate) return true;
  const norm = String(candidate).trim().toLowerCase().replace(/^@+/, '');
  if (!norm || norm.length < 2) return true;
  if (norm === 'unknown user' || norm === 'unknown') return true;
  if (PROTECTED_TECH_AND_PRODUCT_TERMS.has(norm)) return true;
  if (/^\d+$/.test(norm)) return true;
  return false;
}

/**
 * Checks whether an `@token` is a language annotation (e.g. `@Override`, `@Deprecated`),
 * JSDoc tag (`@param`, `@type`), or CSS at-rule (`@media`, `@tailwind`) rather than a Discord handle.
 *
 * @param {string} rawHandle
 * @returns {boolean}
 */
function isAnnotationOrDirectiveHandle(rawHandle) {
  if (!rawHandle) return true;
  const clean = String(rawHandle).trim().replace(/^@+/, '');
  if (!clean) return true;
  const lower = clean.toLowerCase();
  if (CODE_ANNOTATION_AND_DIRECTIVE_TERMS.has(lower) || TOOL_AT_TOKENS.has(lower)) {
    return true;
  }
  // PascalCase identifier without underscores, digits, dots, or hyphens (e.g. @Override, @SuppressWarnings, @RestController)
  if (/^[A-Z][a-z]+(?:[A-Z][a-z0-9]*)*$/.test(clean)) {
    return true;
  }
  return false;
}

/**
 * Classifies a known author string (taken verbatim from author metadata or an `@mention`)
 * into a redaction strategy. Annotation/directive heuristics are NEVER applied to author strings.
 *
 * - `strong-cs`: capitalized single-word display name (e.g. "Carlos", "Max"). Redacted everywhere in
 *   prose via an exact, case-sensitive match, so lowercase common words ("max tokens") survive.
 * - `strong-ci`: multi-word names, names with digits/`_`/`.`/`-`, or mixed case (e.g. "The Code Wizard",
 *   "zephyr_lead_77"). Redacted everywhere, case-insensitively.
 * - `weak`: lowercase single-word names (e.g. "pixel", "river", "mark") that are usually ordinary words.
 *   Redacted only in clear person contexts (`@pixel`, speaker labels, "thanks pixel", "pixel confirmed").
 * - `ignored`: product/company names or unusable candidates.
 *
 * @param {string} author
 * @returns {'strong-cs'|'strong-ci'|'weak'|'ignored'}
 */
function classifyAuthorIdentifier(author) {
  const clean = String(author || '').trim().replace(/^@+/, '');
  if (!clean || clean.length < 2) return 'ignored';
  const lower = clean.toLowerCase();
  if (lower === 'unknown user' || lower === 'unknown' || /^\d+$/.test(clean)) return 'ignored';
  if (NEVER_REDACT_PRODUCT_TERMS.has(lower)) return 'ignored';
  // Technical terms can also be display names (for example Rust, Java, or Kotlin).
  // Keep them countable and redact only when surrounding text clearly identifies a person.
  if (
    PROTECTED_TECH_AND_PRODUCT_TERMS.has(lower) &&
    !STOP_WORDS.has(lower) &&
    /^[\p{L}]+$/u.test(clean)
  ) {
    return 'weak';
  }
  if (/\s/.test(clean)) return 'strong-ci';
  if (/[0-9_.-]/.test(clean)) {
    // Config keys / env vars such as LLM_PROVIDER or retry-after are never people
    return PROTECTED_TECH_AND_PRODUCT_TERMS.has(lower) ? 'ignored' : 'strong-ci';
  }
  if (/^\p{Lu}/u.test(clean)) return 'strong-cs';
  if (/\p{Lu}/u.test(clean)) return 'strong-ci';
  return 'weak';
}

const NAME_START = '(?<![\\p{L}\\p{N}_./:@-])';
const NAME_END = '(?![\\p{L}\\p{N}_/:]|[.-][\\p{L}\\p{N}])';
const AT_MENTION_BODY = '[A-Za-z][A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*';
const AT_MENTION_TAIL = '(?![A-Za-z0-9_/:(])';

function nameSource(name) {
  return escapeRegExp(name).replace(/\s+/g, '\\s+');
}

const PERSON_ACTION_VERBS =
  'said|says|confirmed|confirms|reported|reports|mentioned|mentions|noted|notes|asked|asks|suggested|' +
  'suggests|replied|replies|wrote|writes|answered|answers|explained|explains|posted|posts|shared|shares|' +
  'found|finds|fixed|fixes|solved|solves|resolved|resolves|thinks|thought|believes|noticed|notices|' +
  'recommended|recommends|pointed|proposed|proposes|agreed|agrees|reproduced|tested|tried|stated|' +
  'clarified|described|requested|raised|opened|complained|thanked|added|provided|offered|stressed|' +
  'reckons|recalls|figured|discovered|verified|helped|helps|assisted|investigated|debugged|checked|' +
  'discussed|discusses|lead|leads|led|hosted|hosts|presented|demoed|reviewed|merged|deployed|shipped|' +
  'told|warned|advised|reminded|collaborated';
const PERSON_LEAD_IN =
  'thank you to|thank you|thanks to|thank|thanks|thx|tyvm|ty|' +
  'shoutout to|shout-out to|shout out to|kudos to|credit to|props to|hat tip to|' +
  'ask|asked|ping|pinged|dm|dm\'d|cc\'d|cc';
const STRICT_PERSON_LEAD_IN =
  'thank you to|thank you|thanks to|thanks|thx|tyvm|ty|' +
  'shoutout to|shout-out to|shout out to|kudos to|credit to|props to|hat tip to|cc\'d|cc';
const STRICT_PASSIVE_BY_VERBS = 'asked|answered';
const NON_PERSON_DETERMINERS =
  'the|a|an|this|that|these|those|each|every|one|per|of|any|your|my|its|our|their|with|no|some|new|old';
const PRODUCT_VENDOR_PREFIXES =
  'Claude|VS|Visual\\s+Studio|JetBrains|IntelliJ|OpenAI|GitHub|GitLab|Google|Anthropic|DeepSeek|Cursor|Windsurf|Docker|Linux|Windows|Mac|Apple|AWS|Azure|GCP';
const TECH_COMPOUND_NOUNS =
  'plugin|plugins|compiler|compilers|sdk|runtime|library|libraries|package|packages|module|modules|' +
  'version|versions|edition|project|projects|support|code|file|files|ide|ides|api|apis|cli|docs|' +
  'documentation|density|pattern|patterns|shader|shaders|buffer|buffers|grid|format|ratio|stream|' +
  'water|flow|engine|language|framework|tool|tools|server|client|app|application|build|builds|' +
  'test|tests|formatter|plan|plans|tier|tiers|model|models|mode|modes|agent|agents|alpha|beta|preview|' +
  'release|releases|update|updates|quota|quotas|credit|credits|license|licenses|subscription|subscriptions|' +
  'token|tokens|key|keys|endpoint|endpoints|service|services|instance|instances|cluster|clusters|' +
  'environment|environments|workspace|workspaces|session|sessions|context|channel|channels|thread|threads|' +
  'bot|bots|integration|integrations|feature|features|setting|settings|config|configuration|option|options|' +
  'flag|flags|command|commands|script|scripts|pipeline|pipelines|workflow|workflows|system|systems|' +
  'platform|platforms|desktop|mobile|web|cloud|pro|max|plus|ultra|mini|flash|air';

/**
 * Redacts a lowercase single-word or tech-word participant name (e.g. "pixel", "river", "Rust", "Java")
 * only in clear person contexts so ordinary technical prose such as "increase pixel density" or
 * "Rust plugin" stays intact.
 *
 * @param {string} text
 * @param {string} name
 * @returns {string}
 */
function redactWeakAuthor(text, name) {
  const esc = nameSource(name);
  let out = text;
  // **name** (bold standalone name, not followed by a technical compound noun)
  out = out.replace(
    new RegExp(`\\*\\*${esc}\\*\\*(?!:|\\s+(?:${TECH_COMPOUND_NOUNS})\\b)`, 'giu'),
    (match, offset, sourceText) => capitalizeRedactionMarker(sourceText, offset, 'a user')
  );
  // subject position before a speech/confirmation verb ("pixel confirmed ...")
  out = out.replace(
    new RegExp(
      `(?<!\\b(?:${NON_PERSON_DETERMINERS})\\s+)${NAME_START}${esc}'s(?=\\s+(?:fix|suggestion|answer|reply|workaround|solution|post|message|comment|report|advice|tip)\\b)`,
      'giu'
    ),
    (match, offset, sourceText) => capitalizeRedactionMarker(sourceText, offset, "a user's")
  );
  out = out.replace(
    new RegExp(
      `(?<!\\b(?:${NON_PERSON_DETERMINERS})\\s+)${NAME_START}${esc}(?=\\s+(?:${PERSON_ACTION_VERBS})\\b)`,
      'giu'
    ),
    (match, offset, sourceText) => capitalizeRedactionMarker(sourceText, offset, 'a user')
  );
  // person lead-ins ("thanks pixel", "Thanks, river.", "Shoutout to river!", "Ask Rust", "Ping Java")
  out = out.replace(
    new RegExp(
      `(?<=\\b(?:${PERSON_LEAD_IN})(?:,\\s*|\\s+)(?:\\*\\*)?)${esc}${NAME_END}(?!\\s+(?:${TECH_COMPOUND_NOUNS})\\b)`,
      'giu'
    ),
    (match, offset, sourceText) => capitalizeRedactionMarker(sourceText, offset, 'a user')
  );
  return out;
}

function capitalizeRedactionMarker(sourceText, offset, replacement) {
  const prefix = sourceText.slice(0, offset);
  const startsSentence =
    !prefix.trim() ||
    /[.!?]\s+$/.test(prefix) ||
    /(?:^|\n)\s*(?:(?:>[ \t]*)*(?:[-*•]|\d+\.)\s+)?$/.test(prefix);
  return startsSentence
    ? `${replacement.charAt(0).toUpperCase()}${replacement.slice(1)}`
    : replacement;
}

function redactWeakAuthorLeadInLists(text, weakAuthors) {
  if (!weakAuthors.length) return text;
  const names = weakAuthors
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((name) => nameSource(name));
  const weakAlternation = `(?:${names.join('|')})`;
  const itemPattern = `(?:(?:\\*\\*)?${weakAlternation}(?:\\*\\*)?|a user|participants)`;
  const leadInList = new RegExp(
    `(\\b(?:${PERSON_LEAD_IN})(?:,\\s*|\\s+))(${itemPattern}(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+)${itemPattern})+)${NAME_END}(?!\\s+(?:${TECH_COMPOUND_NOUNS})\\b)`,
    'giu'
  );
  const weakTokenRegex = new RegExp(`${NAME_START}${weakAlternation}${NAME_END}`, 'iu');
  return text.replace(leadInList, (fullMatch, leadPrefix, namesText) => {
    if (!weakTokenRegex.test(namesText)) return fullMatch;
    return `${leadPrefix}participants`;
  });
}

function redactWeakAuthorSubjectLists(text, weakAuthors) {
  if (!weakAuthors.length) return text;
  const names = weakAuthors
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((name) => nameSource(name));
  const weakAlternation = `(?:${names.join('|')})`;
  const itemPattern = `(?:(?:\\*\\*)?${weakAlternation}(?:\\*\\*)?|a user|participants)`;
  const subjectList = new RegExp(
    `(?<!\\b(?:${NON_PERSON_DETERMINERS})\\s+)${NAME_START}(${itemPattern}(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+)${itemPattern})+)(?=\\s+(?:${PERSON_ACTION_VERBS})\\b)`,
    'giu'
  );
  const weakTokenRegex = new RegExp(`${NAME_START}${weakAlternation}${NAME_END}`, 'iu');
  return text.replace(subjectList, (fullMatch, namesText, offset, sourceText) => {
    if (!weakTokenRegex.test(namesText)) return fullMatch;
    return capitalizeRedactionMarker(sourceText, offset, 'participants');
  });
}

const VOCATIVE_CONTINUATIONS =
  'yes|yeah|yep|no|nope|ok|okay|sure|try|thanks|thank|thx|ty|please|pls|sorry|hope|check|' +
  'restart|update|make|did|does|do|can|could|would|should|wait|good|great|nice|right|you|i|we';
const VOCATIVE_INTERJECTIONS =
  'yes|yeah|yep|sure|ok|okay|hi|hey|hello|thanks|thank you|ty|thx|right|exactly|agreed';

/**
 * Redacts lowercase or tech-word participant names used as a direct address ("river, yes it resets",
 * "Sure. river, try again", "*Reply*: river, ...", "river here: ...", "Yes river, it resets").
 * Lists of technologies ("Rust, Go, and Java are supported") stay intact because a list item
 * is followed by a capitalized name or is not followed by a continuation word.
 *
 * @param {string} text
 * @param {Array<string>} weakAuthors
 * @returns {string}
 */
function redactWeakVocatives(text, weakAuthors) {
  if (!weakAuthors.length) return text;
  const weakAlternation = `(?:${weakAuthors
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((name) => nameSource(name))
    .join('|')})`;
  const addressedAtStart = new RegExp(
    `(?<=(?:^|\\n|[.!?]\\s+|[>*•:-]\\s*))${weakAlternation}(?=,\\s*(?:${VOCATIVE_CONTINUATIONS})\\b|\\s+here\\b)`,
    'giu'
  );
  const afterInterjection = new RegExp(
    `(?<=\\b(?:${VOCATIVE_INTERJECTIONS}),?\\s+)${weakAlternation}(?=\\s*[!?.:]|,\\s+\\S|\\s+here\\b)`,
    'giu'
  );
  const marked = text.replace(addressedAtStart, (match, offset, sourceText) =>
    capitalizeRedactionMarker(sourceText, offset, 'a user')
  );
  return marked.replace(afterInterjection, (match, offset, sourceText) => {
    const rest = sourceText.slice(offset + match.length);
    const isListItem = /^,\s+\p{Lu}/u.test(rest);
    return isListItem ? match : 'a user';
  });
}

const NON_NAME_SUFFIX_PATTERN =
  /(?:ing|tion|sion|ment|ness|ity|able|ible|ous|ive|ful|less|ize|ise|ify|ated|ered|ware|soft|hub|labs?|db|js|ui|ide|api|cli|sdk)$/i;

/** Makes a literal alternation string case-insensitive (`thanks` -> `[tT][hH]...`) so the name capture stays case-sensitive. */
function caseInsensitiveAlternation(source) {
  return String(source).replace(/[a-z]/gi, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
}

function isPlausibleContextualGivenName(candidate) {
  if (!isEligibleDerivedPersonToken(candidate)) return false;
  const lower = String(candidate).trim().replace(/^@+/, '').toLowerCase();
  if (NEVER_REDACT_PRODUCT_TERMS.has(lower)) return false;
  if (NON_NAME_SUFFIX_PATTERN.test(lower)) return false;
  return true;
}

function isEligibleDerivedPersonToken(candidate) {
  if (!candidate || typeof candidate !== 'string') return false;
  const clean = candidate.trim().replace(/^@+/, '');
  if (!/^\p{Lu}\p{Ll}{2,}$/u.test(clean)) return false;
  if (isProtectedTerm(clean)) return false;
  const lower = clean.toLowerCase();
  if (ROLE_OR_TITLE_WORDS.has(lower)) return false;
  if (COMMON_CAPITALIZED_NON_NAMES.has(lower)) return false;
  return true;
}

function splitMultiWordAuthorTokens(rawAuthor) {
  if (!rawAuthor || typeof rawAuthor !== 'string') return [];
  const trimmed = rawAuthor.trim().replace(/^@+/, '');
  if (!/\s/.test(trimmed)) return [];
  const parts = trimmed.split(/[\s()[\]{}/|,;:-]+/);
  return parts.filter((part) => isEligibleDerivedPersonToken(part));
}

/**
 * Extracts capitalized person-name candidates from high-confidence person contexts ONLY:
 * - strict gratitude/shoutout/cc lead-ins ("Thanks Maria", "Thank you Anton", "Kudos to Elena", "cc Viktor")
 * - human-only passive attributions ("asked by Maria", "answered by Elena")
 *
 * Product-compatible lead-ins ("worked with", "paired with", "according to", "message", "contact",
 * "check with", "ask", "hi") and subject-before-verb patterns are intentionally excluded so products
 * and tools are never mistaken for people. Returns distinct `(candidate, contextKind)` hits within `text`.
 *
 * @param {string} text
 * @returns {Array<string>}
 */
function extractContextualPersonNames(text) {
  if (!text || typeof text !== 'string') return [];
  const hits = [];
  const seenInText = new Set();
  const addHit = (candidate, contextKind) => {
    if (!candidate || typeof candidate !== 'string') return;
    const clean = candidate.trim().replace(/^\*\*|\*\*$/g, '').replace(/^@+/, '');
    if (!isPlausibleContextualGivenName(clean)) return;
    const key = `${clean.toLowerCase()}:${contextKind}`;
    if (seenInText.has(key)) return;
    seenInText.add(key);
    hits.push(clean);
  };

  // 1. Strict gratitude / shoutout / cc lead-ins ("Thanks Maria", "Thank you Anton", "Kudos to Elena and Viktor")
  const leadInRegex = new RegExp(
    `\\b(?:${caseInsensitiveAlternation(STRICT_PERSON_LEAD_IN)})(?:,\\s*|\\s+)(?:\\*\\*)?(\\p{Lu}\\p{Ll}{2,})(?:\\*\\*)?(?:\\s+(?:and|&)\\s+(?:\\*\\*)?(\\p{Lu}\\p{Ll}{2,})(?:\\*\\*)?)?${NAME_END}(?!\\s+(?:${TECH_COMPOUND_NOUNS})\\b)`,
    'gu'
  );
  for (const m of text.matchAll(leadInRegex)) {
    addHit(m[1], 'lead-in');
    if (m[2]) addHit(m[2], 'lead-in');
  }

  // 2. Human-only passive attribution ("asked by Maria", "answered by Elena")
  const passiveByRegex = new RegExp(
    `\\b(?:${caseInsensitiveAlternation(STRICT_PASSIVE_BY_VERBS)})\\s+[bB][yY]\\s+(?:\\*\\*)?(\\p{Lu}\\p{Ll}{2,})(?:\\*\\*)?(?:\\s+(?:and|&)\\s+(?:\\*\\*)?(\\p{Lu}\\p{Ll}{2,})(?:\\*\\*)?)?${NAME_END}(?!\\s+(?:${TECH_COMPOUND_NOUNS})\\b)`,
    'gu'
  );
  for (const m of text.matchAll(passiveByRegex)) {
    addHit(m[1], 'passive-by');
    if (m[2]) addHit(m[2], 'passive-by');
  }

  return hits;
}

/**
 * Collects known participant display names and handles from normalized messages, forum posts,
 * and extra author lists so they can be redacted from prompts and generated reports without
 * touching raw exported JSON or technical/product terms.
 * Also derives capitalized given-name/surname tokens from multi-word display names (excluding
 * protected technical/product terms, stop words, and role titles) and includes non-author
 * contextual person candidates ONLY when they occur in >= 2 independent strict person contexts.
 *
 * @param {Array<object>} [messages=[]]
 * @param {Array<object>} [posts=[]]
 * @param {Array<string>} [extraAuthors=[]]
 * @returns {Array<string>}
 */
export function collectKnownAuthors(messages = [], posts = [], extraAuthors = []) {
  const rawSet = new Set();
  const contextualAuthors = new Map();
  const contextualDisplay = new Map();
  const seenMessageIds = new Set();

  const getAuthorIdentity = (message) => {
    const author = message?.author;
    const id = message?.authorId ?? message?.userId ?? (author && typeof author === 'object' ? author.id : null);
    if (id !== undefined && id !== null && String(id).trim()) return `id:${String(id).trim()}`;
    const displayName =
      typeof author === 'string'
        ? author
        : author?.displayName || author?.globalName || author?.global_name || author?.username || '';
    return typeof displayName === 'string' && displayName.trim()
      ? `name:${displayName.trim().toLowerCase()}`
      : '';
  };

  const addCandidate = (raw) => {
    if (!raw || typeof raw !== 'string') return;
    const trimmed = raw.trim().replace(/^@+/, '');
    if (!trimmed || trimmed.length < 2) return;
    // Keep exact full author strings (unless they are core product/company names like "JetBrains" or "DeepSeek")
    if (classifyAuthorIdentifier(trimmed) !== 'ignored') {
      rawSet.add(trimmed);
    }
    // Derive capitalized person-name tokens from multi-word display names (e.g. "Maria Lopez" -> "Maria", "Lopez")
    for (const part of splitMultiWordAuthorTokens(trimmed)) {
      rawSet.add(part);
    }
  };

  const scanTextMentions = (content, authorIdentity = '') => {
    if (!content || typeof content !== 'string') return;
    // Whole-token @mention match: cannot backtrack into @scope/pkg or match @Annotation(...);
    // trailing sentence punctuation ("thanks @john.") is never part of the handle.
    const matches = content.matchAll(
      new RegExp(`(?<![A-Za-z0-9_./:-])@(${AT_MENTION_BODY})${AT_MENTION_TAIL}`, 'g')
    );
    for (const m of matches) {
      const handle = m[1];
      if (
        handle &&
        handle.length >= 2 &&
        !isProtectedTerm(handle) &&
        !isAnnotationOrDirectiveHandle(handle)
      ) {
        addCandidate(handle);
      }
    }
    if (!authorIdentity) return;
    for (const contextualName of extractContextualPersonNames(content)) {
      const lower = contextualName.toLowerCase();
      if (!contextualAuthors.has(lower)) contextualAuthors.set(lower, new Set());
      contextualAuthors.get(lower).add(authorIdentity);
      if (!contextualDisplay.has(lower)) {
        contextualDisplay.set(lower, contextualName);
      }
    }
  };

  for (const msg of messages || []) {
    if (!msg) continue;
    addCandidate(msg.author);
    const msgId = msg.id ? String(msg.id) : '';
    if (msgId && seenMessageIds.has(msgId)) continue;
    if (msgId) seenMessageIds.add(msgId);
    scanTextMentions(msg.content, getAuthorIdentity(msg));
  }

  for (const post of posts || []) {
    if (!post) continue;
    addCandidate(post.author);
    const hasPostMessages = Array.isArray(post.messages) && post.messages.length > 0;
    const starterContent = hasPostMessages ? String(post.messages[0]?.content || '') : '';
    if (!hasPostMessages || (post.title && !starterContent.includes(post.title))) {
      scanTextMentions(post.title, getAuthorIdentity(post));
    }
    if (!hasPostMessages) {
      scanTextMentions(post.starterQuestion, getAuthorIdentity(post));
    }
    for (const m of post.messages || []) {
      if (!m) continue;
      addCandidate(m.author);
      const msgId = m.id ? String(m.id) : '';
      if (msgId && seenMessageIds.has(msgId)) continue;
      if (msgId) seenMessageIds.add(msgId);
      scanTextMentions(m.content, getAuthorIdentity(m));
    }
  }

  for (const [lower, authorIdentities] of contextualAuthors.entries()) {
    if (authorIdentities.size >= 2) {
      rawSet.add(contextualDisplay.get(lower));
    }
  }

  for (const extra of extraAuthors || []) {
    if (typeof extra === 'string') {
      addCandidate(extra);
    } else if (extra && typeof extra.author === 'string') {
      addCandidate(extra.author);
    }
  }

  return Array.from(rawSet).sort((a, b) => b.length - a.length);
}

/**
 * Redacts/neutralizes participant usernames, @handles, and author attributions from prose or
 * Markdown while preserving technical terms, product/company names, scoped packages (`@types/node`),
 * language annotations (`@Override`), bold config labels (`**LLM_PROVIDER**:`), parentheticals
 * (`(by default)`), and Markdown formatting.
 *
 * @param {string} text
 * @param {Array<string>} [knownAuthors=[]]
 * @returns {string}
 */
export function redactParticipantNames(text, knownAuthors = []) {
  if (!text || typeof text !== 'string') return '';

  const expandedCandidates = new Set();
  for (const raw of knownAuthors || []) {
    const clean = String(raw || '').trim().replace(/^@+/, '');
    if (!clean || clean.length < 2 || clean.toLowerCase() === 'unknown user') continue;
    expandedCandidates.add(clean);
    for (const part of splitMultiWordAuthorTokens(clean)) {
      expandedCandidates.add(part);
    }
  }

  const allKnownAuthors = Array.from(expandedCandidates).sort((a, b) => b.length - a.length);

  const knownAuthorsLower = new Set(allKnownAuthors.map((a) => a.toLowerCase()));
  const strongCsAuthors = allKnownAuthors.filter((a) => classifyAuthorIdentifier(a) === 'strong-cs');
  const strongLowerSet = new Set(strongCsAuthors.map((a) => a.toLowerCase()));
  // A lowercase "@carlos" mention of a known "Carlos" is clearly the same person: treat it as strong.
  const strongCiAuthors = allKnownAuthors.filter((a) => {
    const kind = classifyAuthorIdentifier(a);
    return kind === 'strong-ci' || (kind === 'weak' && strongLowerSet.has(a.toLowerCase()));
  });
  const weakAuthors = allKnownAuthors.filter(
    (a) => classifyAuthorIdentifier(a) === 'weak' && !strongLowerSet.has(a.toLowerCase())
  );
  const strongAuthorEntries = [
    ...strongCsAuthors.map((name) => ({ name, flags: 'gu' })),
    ...strongCiAuthors.map((name) => ({ name, flags: 'giu' })),
  ].sort((a, b) => b.name.length - a.name.length);
  const allAuthorEntries = [
    ...strongAuthorEntries,
    ...weakAuthors.map((name) => ({ name, flags: 'giu', weak: true })),
  ];

  const isTargetHandleOrKnownAuthor = (candidate) => {
    const raw = String(candidate || '').trim();
    if (!raw) return false;
    const hasAt = raw.startsWith('@');
    const clean = raw.replace(/^@+/, '').trim();
    if (!clean) return false;
    if (knownAuthorsLower.has(clean.toLowerCase())) {
      return true;
    }
    if (hasAt) {
      return !isProtectedTerm(clean) && !isAnnotationOrDirectiveHandle(clean);
    }
    return false;
  };

  let out = text;

  // 1. Remove raw Discord mention tags (<@123456>, <@!123456>)
  out = out.replace(/<@!?\d+>/g, 'a user');

  // 2. Remove parenthetical and dash author attributions ONLY when explicitly "asked/reported/posted/raised/opened by <knownAuthor|@handle>"
  out = out.replace(
    /\s*\((?:asked|reported|posted|raised|question|thread|opened|suggested|confirmed|answered)\s+by\s+(?:\*\*)?(@?[A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+){0,3})(?:\*\*)?\)/gi,
    (fullMatch, target) => (isTargetHandleOrKnownAuthor(target) ? '' : fullMatch)
  );
  out = out.replace(
    /\s*[—–-]\s*(?:asked|reported|posted|raised|question|thread|opened|suggested|confirmed|answered)\s+by\s+(?:\*\*)?(@?[A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+){0,3})(?:\*\*)?(?=\s*(?:\[|\(|$|\n))/gi,
    (fullMatch, target) => (isTargetHandleOrKnownAuthor(target) ? '' : fullMatch)
  );

  // 3. Remove contributor roster sentences/lines ("Most active contributors: ...", "Top Active Contributors: ...")
  //    and per-speaker count / "most active" ranking lines ("- Carlos: 133 messages", "- **zephyr_77** most active")
  out = out.replace(
    /[ \t]*Most\s+active(?:\s+contributors|\s+participants|\s+speakers)?\s*:\s*[^\n.]+\.?/gi,
    ''
  );
  out = out.replace(
    /^[ \t]*(?:[-*•]\s+)?(?:\*\*)?(?:Top\s+Active\s+Contributors|Most\s+Active\s+Contributors|Active\s+Contributors|Key\s+Contributors|Top\s+Contributors)(?:\s*\([^)]*\))?(?:\*\*)?\s*:.*$/gim,
    ''
  );
  for (const { name, flags } of allAuthorEntries) {
    const lineFlags = flags.includes('i') ? 'gimu' : 'gmu';
    out = out.replace(
      new RegExp(
        `^[ \\t]*(?:[-*•]|\\d+[.)])\\s+(?:\\*\\*)?@?${nameSource(name)}(?:\\*\\*)?\\s*(?:[:—–-]|\\([^)]*\\)|\\s+(?:is|was|with|had|posted|sent|contributed|led)\\b)?\\s*(?:the\\s+)?(?:most\\s+active\\b|\\d+\\s+(?:in-window\\s+)?(?:messages?|msgs?|posts?|replies|threads?|contributions?)\\b).*$`,
        lineFlags
      ),
      ''
    );
  }
  out = out.replace(
    /^[ \t]*(?:[-*•]|\d+[.)])\s+(?:\*\*)?@[A-Za-z0-9_.-]+(?:\*\*)?\s*(?:[:—–-]|\([^)]*\)|\s+(?:is|was|with|had|posted|sent|contributed|led)\b)?\s*(?:the\s+)?(?:most\s+active\b|\d+\s+(?:in-window\s+)?(?:messages?|msgs?|posts?|replies|threads?|contributions?)\b).*$/gim,
    ''
  );

  // 4. Remove greeting prefixes addressing @handles or known authors when followed by message text ("Hi @carlos_dev! ", "Hey @alice, ")
  out = out.replace(
    /(^|(?<=[.!?]\s)|(?<=\n[ \t]*))(?:Hi|Hey|Hello),?\s+(?:\*\*)?(@[A-Za-z][A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*)(?![A-Za-z0-9_/:(])(?:\*\*)?[!,.]?\s+(?=\S)/gi,
    (fullMatch, prefix, handleWithAt) =>
      isTargetHandleOrKnownAuthor(handleWithAt) ? prefix : fullMatch
  );
  for (const { name, flags } of allAuthorEntries) {
    out = out.replace(
      new RegExp(
        `(^|(?<=[.!?]\\s)|(?<=\\n[ \\t]*))(?:Hi|Hey|Hello),?\\s+(?:\\*\\*)?@?${nameSource(name)}(?:\\*\\*)?${NAME_END}${
          PROTECTED_TECH_AND_PRODUCT_TERMS.has(name.toLowerCase())
            ? `(?!\\s+(?:${TECH_COMPOUND_NOUNS})\\b)`
            : ''
        }[!,.]?\\s+(?=\\S)`,
        flags
      ),
      '$1'
    );
  }

  // 5. Remove explicit "asked by @handle" / "provided by **known_author**" attributions in prose
  out = out.replace(
    /\b(asked|reported|posted|raised|suggested|confirmed|answered|shared|mentioned|noted|provided)\s+by\s+(?:\*\*)?(@[A-Za-z][A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*)(?![A-Za-z0-9_/:(])(?:\*\*)?/gi,
    (fullMatch, verb, handleWithAt) =>
      isTargetHandleOrKnownAuthor(handleWithAt) ? verb : fullMatch
  );
  for (const { name, flags } of allAuthorEntries) {
    out = out.replace(
      new RegExp(
        `\\b(asked|reported|posted|raised|suggested|confirmed|answered|shared|mentioned|noted|provided)\\s+by\\s+(?:\\*\\*)?@?${nameSource(name)}(?:\\*\\*)?${NAME_END}`,
        flags
      ),
      '$1'
    );
  }

  // 6. Remove speaker prefixes on bullets, blockquotes, or lines ONLY when matching an @handle or known author
  //    (e.g. "- **zephyr_lead_77**: ", "**Rust:** ", "> Rust: ", "- **mark**: restart")
  out = out.replace(
    /(^|\n)([ \t]*(?:>[ \t]*)*(?:[-*•]\s+)?)(?:\*\*)?(@[A-Za-z][A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*)(?![A-Za-z0-9_/:(])(?:\*\*\s*:|:\s*\*\*|\s*:)\s+/g,
    (fullMatch, lineStart, bulletPrefix, handleWithAt) =>
      isTargetHandleOrKnownAuthor(handleWithAt) ? `${lineStart}${bulletPrefix}` : fullMatch
  );
  for (const { name, flags } of allAuthorEntries) {
    out = out.replace(
      new RegExp(
        `(^|\\n)([ \\t]*(?:>[ \\t]*)*(?:[-*•]\\s+)?)(?:\\*\\*)?@?${nameSource(name)}(?:\\*\\*\\s*:|:\\s*\\*\\*|\\s*:)\\s+`,
        flags
      ),
      '$1$2'
    );
  }

  // 7. Replace paired distinctive known authors or @handles ("@alice and @bob") with "participants"
  out = out.replace(
    /(?<![A-Za-z0-9_./:-])(?:\*\*)?(@[A-Za-z][A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*)(?![A-Za-z0-9_/:(])(?:\*\*)?\s+and\s+(?:\*\*)?(@[A-Za-z][A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*)(?![A-Za-z0-9_/:(])(?:\*\*)?/gi,
    (fullMatch, h1, h2) =>
      isTargetHandleOrKnownAuthor(h1) && isTargetHandleOrKnownAuthor(h2)
        ? 'participants'
        : fullMatch
  );

  // 8. Replace whole-token @handle mentions that are known participants (or look like plain handles).
  //    Emails, @scope/pkg, @Annotations(...), and tool/chat tokens such as @workspace are preserved,
  //    and trailing sentence punctuation ("Ping @john.") is kept.
  out = out.replace(
    /(?<![A-Za-z0-9_./:-])(\*\*)?@([A-Za-z][A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*)(?![A-Za-z0-9_/:(])(\*\*)?('s)?/g,
    (fullMatch, openBold = '', handle, closeBold = '', possessive = '') => {
      if (!knownAuthorsLower.has(handle.toLowerCase())) {
        if (isProtectedTerm(handle) || isAnnotationOrDirectiveHandle(handle)) {
          return fullMatch;
        }
      }
      // If openBold or closeBold was asymmetric, preserve surrounding bold text cleanly
      const replacement = possessive ? "a user's" : 'a user';
      if (openBold && !closeBold) {
        return `${ openBold }${replacement}`;
      }
      if (!openBold && closeBold) {
        return `${replacement}${closeBold}`;
      }
      return replacement;
    }
  );

  // 9. Replace remaining occurrences of known author names in prose:
  //    - capitalized single-word names: exact case-sensitive match ("Carlos", "Lucia"), guarded against adjacent product/vendor terms
  //    - multi-word / symbolic / mixed-case names: case-insensitive
  //    - lowercase single-word / tech names ("pixel", "river", "Rust", "Max", "Code"): only in clear person contexts
  for (const { name, flags } of strongAuthorEntries) {
    const esc = nameSource(name);
    // Adjacency exemptions ("Claude Code", "Max plan") apply ONLY when the author token itself is a
    // protected tech/product word. Ordinary given names ("Grace update", "Ivan project") are always redacted.
    const isProtectedWordAuthor =
      !/\s/.test(name) &&
      !/[0-9_.-]/.test(name) &&
      PROTECTED_TECH_AND_PRODUCT_TERMS.has(name.toLowerCase());
    const vendorGuard = isProtectedWordAuthor ? `(?<!\\b(?:${PRODUCT_VENDOR_PREFIXES})\\s+)` : '';
    const compoundGuard = isProtectedWordAuthor ? `(?!\\s+(?:${TECH_COMPOUND_NOUNS})\\b)` : '';
    out = out.replace(
      new RegExp(`${vendorGuard}${NAME_START}(\\*\\*)?@?${esc}(\\*\\*)?'s${NAME_END}`, flags),
      (_m, b1 = '', b2 = '', offset, sourceText) => {
        const marker = capitalizeRedactionMarker(sourceText, offset, "a user's");
        return b1 && !b2 ? `${b1}${marker}` : !b1 && b2 ? `${marker}${b2}` : marker;
      }
    );
    out = out.replace(
      new RegExp(`${vendorGuard}${NAME_START}(\\*\\*)?@?${esc}(\\*\\*)?${NAME_END}${compoundGuard}`, flags),
      (_m, b1 = '', b2 = '', offset, sourceText) => {
        const marker = capitalizeRedactionMarker(sourceText, offset, 'a user');
        return b1 && !b2 ? `${b1}${marker}` : !b1 && b2 ? `${marker}${b2}` : marker;
      }
    );
  }
  out = redactWeakAuthorLeadInLists(out, weakAuthors);
  out = redactWeakAuthorSubjectLists(out, weakAuthors);
  for (const name of weakAuthors) {
    out = redactWeakAuthor(out, name);
  }
  out = redactWeakVocatives(out, weakAuthors);

  // 10. Clean up repeated "a user and a user" or "a user, a user, and a user" and drop leftover anonymized ranking lines & per-user count fragments
  out = out.replace(/\b(?:a user|participants)(?:\s*,\s*(?:a user|participants))*\s*,?\s+and\s+(?:a user|participants)\b/gi, (match, offset, sourceText) =>
    capitalizeRedactionMarker(sourceText, offset, 'participants')
  );
  out = out.replace(
    /^[ \t]*(?:[-*•]|\d+[.)])\s+\d+\s+(?:in-window\s+)?(?:messages?|msgs?|posts?|replies|threads?|contributions?)(?:\s*\([^)]*\))?\.?[ \t]*$/gim,
    ''
  );
  out = out.replace(
    /^[ \t]*(?:[-*•]|\d+[.)])?\s*(?:\*\*)?(?:a user|participants)(?:\*\*)?\s*(?:\(\s*\d+\s+(?:in-window\s+)?(?:messages?|msgs?|posts?|replies|threads?|contributions?)\b[^)]*\)\s*\.?|(?:[:—–-]\s*|\s+(?:is|was|were|with|had)\s+)?(?:the\s+)?(?:most\s+active(?:\s+(?:participant|contributor|member|user|speaker)s?)?(?:[^\n.]*\.?)?|\d+\s+(?:in-window\s+)?(?:messages?|msgs?|posts?|replies|threads?|contributions?)\b(?:\s*\([^)]*\))?\s*\.?))[ \t]*$/gim,
    ''
  );
  out = out.replace(
    /\b(a user|participants)(\*\*)?\s*\(\s*\d+\s+(?:in-window\s+)?(?:messages?|msgs?|posts?|replies|threads?|contributions?)\b[^)]*\)/gi,
    '$1$2'
  );
  out = out.replace(/\n{3,}/g, '\n\n');

  return out;
}

function balanceInlineMarkdown(text) {
  let result = String(text || '');
  // Check if there is an unclosed triple-backtick or tilde code fence
  const fenceMatches = result.match(/(?:^|\n)[ \t]*(`{3,}|~{3,})/g) || [];
  if (fenceMatches.length % 2 === 1) {
    const lastFence = fenceMatches[fenceMatches.length - 1].trim().slice(0, 3);
    result = `${result}\n${lastFence}`;
  }
  // Remove fenced code blocks before counting inline single backticks and bold markers
  const withoutFences = result
    .replace(/(?:^|\n)[ \t]*(`{3,}|~{3,})[\s\S]*?(?:\n[ \t]*\1|$)/g, '')
    .replace(/`{3,}/g, '');
  const backticks = (withoutFences.match(/`/g) || []).length;
  if (backticks % 2 === 1) {
    result += '`';
  }
  const boldMarkers = (withoutFences.match(/\*\*/g) || []).length;
  if (boldMarkers % 2 === 1) {
    result += '**';
  }
  return result;
}

function isMarkdownTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(String(line || ''));
}

function isCodeFenceLine(line) {
  return /^\s*(`{3,}|~{3,})/.test(String(line || ''));
}

function boundTableBlock(rows, maxChars = DEFAULT_MAX_TOPIC_CHARS) {
  const cleanRows = (rows || []).map((r) => String(r || '').trim()).filter(Boolean);
  if (cleanRows.length === 0) return '';
  const fullTable = cleanRows.join('\n');
  if (fullTable.length <= maxChars || cleanRows.length <= 2) {
    return fullTable;
  }
  const kept = cleanRows.slice(0, 2);
  let used = kept.join('\n').length;
  for (let i = 2; i < cleanRows.length; i++) {
    const row = cleanRows[i];
    if (used + 1 + row.length > maxChars && kept.length >= 3) {
      break;
    }
    kept.push(row);
    used += 1 + row.length;
  }
  return kept.join('\n');
}

function boundCodeFenceBlock(fenceLines, maxChars = DEFAULT_MAX_TOPIC_CHARS) {
  const rawLines = (fenceLines || []).map((l) => String(l || '').replace(/\s+$/, ''));
  if (rawLines.length === 0) return '';
  const openLine = rawLines[0];
  const fenceMatch = openLine.match(/^(\s*(`{3,}|~{3,}))/);
  const closeFence = fenceMatch ? fenceMatch[1] : '```';
  const lastLine = rawLines[rawLines.length - 1];
  const hasClosingFence = rawLines.length > 1 && isCodeFenceLine(lastLine);
  const innerLines = hasClosingFence ? rawLines.slice(1, -1) : rawLines.slice(1);
  const fullBlock = [...rawLines, ...(hasClosingFence ? [] : [closeFence])].join('\n');
  if (fullBlock.length <= maxChars || innerLines.length <= 1) {
    return fullBlock;
  }
  const reserveForFences = openLine.length + closeFence.length + 2;
  const availInner = Math.max(20, maxChars - reserveForFences);
  const keptInner = [];
  let used = 0;
  for (const line of innerLines) {
    const addLen = (keptInner.length > 0 ? 1 : 0) + line.length;
    if (keptInner.length > 0 && used + addLen > availInner) {
      break;
    }
    keptInner.push(keptInner.length === 0 && line.length > availInner ? line.slice(0, availInner) : line);
    used += addLen;
  }
  return [openLine, ...keptInner, closeFence].join('\n');
}

const KEY_SENTENCE_MARKERS =
  /\b(?:decision|decided|decide|confirmed|unconfirmed|confirm|workaround|fix|fixed|fixes|resolved|unresolved|solution|solved|open\s+question|open\s+issue|still|not\s+yet|unclear|unknown|pending|policy|limit|limits|roll\s+over|rolls?\s+over|carry(?:ies|\s+over)?|no\s+longer|must|rule|rules|caveat)\b/i;

const SUBORDINATE_CLAUSE_BOUNDARY =
  /(?:[;—–]\s+|,\s+(?:especially|particularly|specifically|notably|while|whereas|although|though|even\s+though|since|because|as\s+long\s+as|which|where|when|after|before|including|such\s+as|as\s+well\s+as|depending\s+on|compared\s+to|regardless\s+of|without|for\s+example|e\.g\.)\b)/gi;

/**
 * When a single sentence exceeds `limit`, tries to cut cleanly at a subordinate clause boundary
 * (`; `, ` — `, `, especially ...`, `, after ...`, `, which ...`) and end with `.` instead of `...`.
 *
 * @param {string} raw
 * @param {number} limit
 * @returns {string|null}
 */
function trimAtSubordinateClause(raw, limit) {
  if (!raw || raw.includes('\n') || raw.length <= limit) return null;
  const minCut = Math.max(40, Math.floor(limit * 0.4));
  let bestCut = -1;
  SUBORDINATE_CLAUSE_BOUNDARY.lastIndex = 0;
  let match;
  while ((match = SUBORDINATE_CLAUSE_BOUNDARY.exec(raw)) !== null) {
    if (match.index >= minCut && match.index <= limit - 1) {
      bestCut = match.index;
    }
  }
  if (bestCut < minCut) return null;
  const head = raw
    .slice(0, bestCut)
    .trim()
    .replace(/[,;:\-–—/\\]+$/, '')
    .trim();
  if (head.length < 35) return null;
  const withPeriod = /[.!?]$/.test(head) ? head : `${head}.`;
  return withPeriod.length <= limit ? balanceInlineMarkdown(withPeriod) : null;
}

/**
 * For single-paragraph prose that does not fit `limit`, drops repeated sentences and keeps the
 * most informative ones (decisions, fixes, open questions, caveats, plus the opening and closing
 * sentence) in their original order instead of blindly keeping the opening text.
 *
 * @param {string} raw
 * @param {number} limit
 * @returns {string|null} the bounded text, or null when sentence selection does not apply
 */
function selectPrioritySentences(raw, limit) {
  if (raw.includes('\n')) return null;
  // A leading bullet/bold topic label ("- **Topic**: ...") is always kept verbatim as a prefix.
  const labelMatch = raw.match(/^(?:(?:[-*•]|\d+[.)])\s+)?(?:\*\*[^*\n]+\*\*:?\s*)/);
  const bulletMatch = !labelMatch ? raw.match(/^(?:[-*•]|\d+[.)])\s+/) : null;
  const prefix = labelMatch ? labelMatch[0] : bulletMatch ? bulletMatch[0] : '';
  const body = raw.slice(prefix.length);
  const bodyLimit = limit - prefix.length;
  if (bodyLimit < 40) return null;
  const selected = selectBodySentences(body, bodyLimit);
  return selected ? balanceInlineMarkdown(`${prefix}${selected}`) : null;
}

function selectBodySentences(raw, limit) {
  const parts = raw.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g);
  if (!parts || parts.length < 2) {
    return trimAtSubordinateClause(raw, limit);
  }

  const seen = new Set();
  const sentences = [];
  for (const part of parts) {
    const text = part.trim();
    if (!text) continue;
    const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (key && seen.has(key)) continue;
    seen.add(key);
    sentences.push(text);
  }
  if (sentences.length < 2) {
    if (sentences.length === 1) {
      return sentences[0].length <= limit
        ? sentences[0]
        : trimAtSubordinateClause(sentences[0], limit);
    }
    return null;
  }

  const joinLen = (indices) =>
    indices.reduce((sum, idx, i) => sum + sentences[idx].length + (i > 0 ? 1 : 0), 0);
  const allIndices = sentences.map((_, i) => i);
  if (joinLen(allIndices) <= limit) {
    return sentences.join(' ');
  }

  const lastIdx = sentences.length - 1;
  const scored = sentences.map((text, idx) => ({
    idx,
    score:
      (KEY_SENTENCE_MARKERS.test(text) ? 4 : 0) + (idx === lastIdx ? 2 : 0) + (idx === 0 ? 1 : 0),
  }));
  const ranked = scored
    .filter((s) => sentences[s.idx].length <= limit)
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  const chosen = [];
  // Keep a reasonably short opening sentence (it usually carries the topic label or headline stats)
  if (sentences[0].length <= Math.floor(limit * 0.6)) {
    chosen.push(0);
  }
  for (const cand of ranked) {
    if (chosen.includes(cand.idx)) continue;
    const trial = [...chosen, cand.idx].sort((a, b) => a - b);
    if (joinLen(trial) <= limit) {
      chosen.push(cand.idx);
    }
  }
  if (chosen.length === 0) {
    return trimAtSubordinateClause(sentences[ranked[0]?.idx ?? 0] || raw, limit);
  }
  chosen.sort((a, b) => a - b);
  return chosen.map((i) => sentences[i]).join(' ');
}

/**
 * Clips a single line, bullet, or paragraph to at most `maxChars` characters at a clean
 * sentence or word boundary so no word or inline Markdown marker is ever cut mid-token.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function clipTextCleanly(text, maxChars = DEFAULT_MAX_TOPIC_CHARS) {
  const raw = String(text || '').trim();
  const limit = Math.max(40, maxChars);
  if (raw.length <= limit) {
    return raw;
  }

  // Preserve multi-line code fences or Markdown tables if passed directly
  const lines = raw.split('\n');
  if (lines.length > 1 && isCodeFenceLine(lines[0])) {
    return boundCodeFenceBlock(lines, limit);
  }
  if (lines.length > 1 && lines.every((l) => isMarkdownTableRow(l))) {
    return boundTableBlock(lines, limit);
  }

  const prioritized = selectPrioritySentences(raw, limit);
  if (prioritized) {
    return prioritized;
  }

  const slice = raw.slice(0, limit);
  const minSentenceCut = Math.floor(limit * 0.5);

  // 1. Prefer cutting at the end of a complete sentence (. ! ?)
  let bestSentenceIdx = -1;
  const sentenceRegex = /[.!?](?=\s|$)/g;
  let match;
  while ((match = sentenceRegex.exec(slice)) !== null) {
    if (match.index + 1 >= minSentenceCut) {
      bestSentenceIdx = match.index + 1;
    }
  }
  if (bestSentenceIdx > 0) {
    return balanceInlineMarkdown(slice.slice(0, bestSentenceIdx).trim());
  }

  // 2. Otherwise cut at the last word boundary before `limit - 3`
  const targetLen = Math.max(20, limit - 3);
  const wordSlice = raw.slice(0, targetLen + 1);
  const lastSpace = wordSlice.search(/\s+\S*$/);
  let clipped =
    lastSpace >= Math.floor(targetLen * 0.4)
      ? wordSlice.slice(0, lastSpace).trim()
      : raw.slice(0, targetLen).trim();

  // Strip trailing punctuation or dangling connectors before appending ellipsis
  clipped = clipped
    .replace(/[,;:\-–—/\\]+$/, '')
    .replace(/\s+\b(?:and|or|but|the|a|an|to|of|in|for|with|on|at|by|from)\s*$/i, '')
    .trim();

  return `${balanceInlineMarkdown(clipped)}...`;
}

const CANONICAL_UMBRELLA_HEADING_PATTERN =
  /^(?:chat\s+overview|support\s*(?:&|and)\s*q\s*&\s*a\s+overview|overview|summary|channel\s+summary|executive\s+summary|key\s+topics|main\s+topics|main\s+discussion\s+topics|topics|key\s+themes|main\s+themes|themes|most\s+frequent\s+questions|common\s+doubts|common\s+questions|\bfaq\b|confirmed\s+solutions|answers\s+provided|top\s+keywords|most\s+used\s+keywords|notable\s+highlights|highlights|key\s+takeaways|takeaways|shared\s+ideas|decisions\s*(?:&|and)\s*outcomes|unanswered\s+questions|open\s+questions|pending\s+issues|recurring\s+(?:issues|problems|topics|themes|questions)|action\s+items|talking\s+points|segment\s+\d+|server-wide\s+top\s+keywords|per-channel\s+keyword\s+rankings|deterministic\s+forum)/i;

function isSectionHeadingLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return false;
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;
  if (/^\*\*[^*\n]+\*\*:?\s*$/.test(trimmed)) return true;
  return false;
}

function isCanonicalUmbrellaHeading(headingLine) {
  const clean = String(headingLine || '')
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\*\*|\*\*:?\s*$/g, '')
    .replace(/^\d+\.\s*/, '')
    .trim();
  return CANONICAL_UMBRELLA_HEADING_PATTERN.test(clean);
}

/**
 * Counts how many top-level bold-labelled topic bullets (`- **Topic**: ...`, `1. **Topic**: ...`)
 * or standalone topic header lines (`**Topic**:`) appear in `contentLines` outside code fences and tables.
 */
function countTopLevelStructuredTopics(contentLines) {
  let count = 0;
  let idx = 0;
  while (idx < (contentLines || []).length) {
    const line = String(contentLines[idx] || '');
    const trimmed = line.trim();
    if (!trimmed) {
      idx++;
      continue;
    }
    if (isCodeFenceLine(line)) {
      idx++;
      while (idx < contentLines.length) {
        if (isCodeFenceLine(contentLines[idx])) {
          idx++;
          break;
        }
        idx++;
      }
      continue;
    }
    if (isMarkdownTableRow(line)) {
      idx++;
      while (idx < contentLines.length && isMarkdownTableRow(contentLines[idx])) {
        idx++;
      }
      continue;
    }
    const isIndented = /^\s{2,}/.test(line);
    if (!isIndented) {
      const isBoldTopicBullet = /^(?:[-*•]|\d+[.)])\s+\*\*[^*\n]+\*\*/.test(trimmed);
      const isColonTopicHeader =
        !/^(?:[-*•]|\d+[.)])\s+/.test(trimmed) &&
        /^(?:\*\*[^*\n]+\*\*|[A-Z][^\n:*]{2,80}):\s*$/.test(trimmed);
      const isInlineBoldTopic = /^\*\*[^*\n]+(?::\*\*|\*\*:)\s+\S/.test(trimmed);
      if (isBoldTopicBullet || isColonTopicHeader || isInlineBoldTopic) {
        count++;
      }
    }
    idx++;
  }
  return count;
}

function isFaqTitleEntry(topEntry, restEntries = []) {
  const firstText = String(topEntry?.text || '').trim();
  if (/^(?:[-*•]|\d+[.)])\s+\*\*[^*\n]+\*\*(?:\s*\[[^\]]+\])?(?:\s*\*\([^)]+\)\*)?\s*$/.test(firstText)) {
    return true;
  }
  return restEntries.some(
    (e) =>
      e.isSubBullet &&
      /^\s{2,}(?:[-*•]|\d+[.)])\s+\*(?:Doubt|Question|Reply|Confirmed|Suggested|Answer)/i.test(
        String(e.text || '')
      )
  );
}

function parseTopicEntries(lines) {
  const rawLines = (lines || []).map((l) => String(l || '').replace(/\s+$/, ''));
  const entries = [];
  let idx = 0;
  while (idx < rawLines.length) {
    const line = rawLines[idx];
    const trimmed = line.trim();
    if (!trimmed) {
      if (entries.length > 0 && entries[entries.length - 1].type !== 'blank') {
        entries.push({ type: 'blank', text: '' });
      }
      idx++;
      continue;
    }

    // 1. Fenced code block
    if (isCodeFenceLine(line)) {
      const fenceLines = [line];
      idx++;
      while (idx < rawLines.length) {
        fenceLines.push(rawLines[idx]);
        if (isCodeFenceLine(rawLines[idx])) {
          idx++;
          break;
        }
        idx++;
      }
      entries.push({
        type: 'code',
        isSubBullet: false,
        blankBefore: entries[entries.length - 1]?.type === 'blank',
        lines: fenceLines,
        text: fenceLines.join('\n'),
      });
      continue;
    }

    // 2. Markdown table block
    if (isMarkdownTableRow(line)) {
      const tableRows = [trimmed];
      idx++;
      while (idx < rawLines.length && isMarkdownTableRow(rawLines[idx])) {
        tableRows.push(rawLines[idx].trim());
        idx++;
      }
      entries.push({
        type: 'table',
        isSubBullet: false,
        blankBefore: entries[entries.length - 1]?.type === 'blank',
        rows: tableRows,
        text: tableRows.join('\n'),
      });
      continue;
    }

    // 3. Regular bullet, sub-bullet, or paragraph continuation
    const isBullet = /^(?:[-*•]|\d+\.)\s+/.test(trimmed);
    const isSubBullet = /^\s{2,}(?:[-*•]|\d+\.)\s+/.test(line);
    const isBlockquote = /^\s*>/.test(line);
    const prevEntry = entries[entries.length - 1];
    const blankBefore = prevEntry?.type === 'blank';
    if (
      !prevEntry ||
      prevEntry.type === 'blank' ||
      prevEntry.type !== 'text' ||
      isBullet ||
      isSubBullet ||
      isBlockquote ||
      blankBefore ||
      prevEntry.isBullet ||
      prevEntry.isSubBullet
    ) {
      entries.push({
        type: 'text',
        isSubBullet,
        isBullet,
        isBlockquote,
        blankBefore,
        text: line,
      });
    } else {
      prevEntry.text += `\n${line}`;
    }
    idx++;
  }
  return entries;
}

function trimBlankOuterLines(lines) {
  const arr = (lines || []).map((l) => String(l || '').replace(/\s+$/, ''));
  let start = 0;
  let end = arr.length;
  while (start < end && !arr[start].trim()) start++;
  while (end > start && !arr[end - 1].trim()) end--;
  return arr.slice(start, end);
}

/**
 * Checks whether a single topic block (with optional heading) already satisfies both
 * `maxTopicChars` and `maxBulletsPerTopic` so compliant Markdown can be preserved byte-for-byte.
 */
function isTopicBlockCompliant(
  lines,
  {
    heading = '',
    maxBulletsPerTopic = DEFAULT_MAX_BULLETS_PER_TOPIC,
    maxTopicChars = DEFAULT_MAX_TOPIC_CHARS,
    maxTotalChars = DEFAULT_MAX_DIGEST_CHARS,
  } = {}
) {
  const trimmedLines = trimBlankOuterLines(lines);
  const headingStr = String(heading || '').trim();
  const fullText = [headingStr, ...trimmedLines].filter(Boolean).join('\n');
  if (!fullText) return true;

  if (trimmedLines.length > 0 && trimmedLines.every((l) => isMarkdownTableRow(l))) {
    return fullText.length <= Math.max(maxTopicChars, maxTotalChars);
  }
  if (fullText.length > maxTopicChars) {
    return false;
  }

  const contentEntries = parseTopicEntries(trimmedLines).filter((e) => e.type !== 'blank');
  const topBulletCount = contentEntries.filter(
    (e) => e.type === 'text' && e.isBullet && !e.isSubBullet
  ).length;
  const subBulletCount = contentEntries.filter((e) => e.type === 'text' && e.isSubBullet).length;

  if (
    topBulletCount === 1 &&
    subBulletCount > 0 &&
    contentEntries[0]?.isBullet &&
    !contentEntries[0]?.isSubBullet
  ) {
    const isTopicOrFaqHeader =
      !headingStr || isFaqTitleEntry(contentEntries[0], contentEntries.slice(1));
    const allowedSubBullets = isTopicOrFaqHeader
      ? Math.max(1, maxBulletsPerTopic)
      : Math.max(0, maxBulletsPerTopic - 1);
    return subBulletCount <= allowedSubBullets;
  }

  return topBulletCount + subBulletCount <= Math.max(1, maxBulletsPerTopic);
}

const HIGH_PRIORITY_BULLET_PREFIX =
  /^\s*(?:[-*•]|\d+[.)])\s+(?:\*\*|\*)?(?:decision|decided|outcome|policy|workaround|fix|fixed|solution|resolved|resolution|confirmed(?:\s+answer|\s+solution|\s+fix)?|suggested(?:\s+answer|\s+fix)?|answer|open\s+question|open\s+issue|unconfirmed|unanswered|unresolved|caveat|action\s+item|takeaway)\b/i;

const HIGH_PRIORITY_BULLET_MARKER =
  /\b(?:decision|decided|workaround|fix|fixed|fixes|solution|solved|resolved|resolution|open\s+question|open\s+issue|unconfirmed|unanswered|unresolved|still\s+(?:unconfirmed|unclear|open|pending|unresolved)|not\s+yet\s+(?:confirmed|resolved)|roll\s+over|rolls?\s+over|carry\s+over|carries\s+over)\b/i;

const FAQ_DOUBT_PREFIX = /^\s*(?:[-*•]|\d+[.)])\s+\*(?:Doubt|Question)\*/i;

function extractCoreFactSentence(rawBulletText, maxLen) {
  const body = String(rawBulletText || '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
    .trim();
  if (!body) return '';
  const limit = Math.max(45, maxLen);

  const parts = body.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g);
  let chosen = body;
  if (parts && parts.length > 1) {
    const scoredParts = parts
      .map((p) => p.trim())
      .filter(Boolean)
      .map((s, idx) => ({
        s,
        idx,
        score:
          (HIGH_PRIORITY_BULLET_PREFIX.test(`- ${s}`) ? 6 : 0) +
          (HIGH_PRIORITY_BULLET_MARKER.test(s) ? 4 : 0) +
          (KEY_SENTENCE_MARKERS.test(s) ? 2 : 0) +
          (idx === 0 ? 1 : 0),
      }))
      .sort((a, b) => b.score - a.score || a.idx - b.idx);
    if (scoredParts.length > 0) {
      chosen = scoredParts[0].s;
    }
  }

  let bounded = chosen;
  if (bounded.length > limit) {
    bounded = trimAtSubordinateClause(bounded, limit) || clipTextCleanly(bounded, limit);
  }
  bounded = bounded.trim();
  if (bounded && !/[.!?]$/.test(bounded)) {
    bounded = `${bounded.replace(/[,;:\-–—]+$/, '').trim()}.`;
  }
  return balanceInlineMarkdown(bounded);
}

/**
 * Selects up to `limitCount` bullets from `bulletEntries` in their original order, ranking by
 * decision / fix / workaround / open-question priority (plus the closing bullet). When there are
 * more high-priority bullets than `limitCount` (e.g. Workaround + Decision + Open question with
 * `limitCount === 2`), compresses and merges the extra high-priority bullets into the final kept
 * bullet so all high-priority facts survive within the per-topic budget.
 */
function selectAndMergePriorityBullets(bulletEntries, limitCount, availChars) {
  const cap = Math.max(1, limitCount);
  if (!Array.isArray(bulletEntries) || bulletEntries.length <= cap) {
    return bulletEntries || [];
  }

  const seenKeys = new Set();
  const deduped = [];
  for (const entry of bulletEntries) {
    const normKey = String(entry.text || '')
      .toLowerCase()
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    if (normKey && seenKeys.has(normKey)) continue;
    if (normKey) seenKeys.add(normKey);
    deduped.push(entry);
  }
  if (deduped.length <= cap) {
    return deduped;
  }

  const lastIdx = deduped.length - 1;
  const scored = deduped.map((entry, idx) => {
    const text = String(entry.text || '');
    const hasPrefix = HIGH_PRIORITY_BULLET_PREFIX.test(text);
    const hasMarker = HIGH_PRIORITY_BULLET_MARKER.test(text);
    const isFaqDoubt = FAQ_DOUBT_PREFIX.test(text);
    const hasGeneralKey = KEY_SENTENCE_MARKERS.test(text);
    const isHighPriority = hasPrefix || hasMarker;
    const score =
      (hasPrefix ? 8 : 0) +
      (hasMarker ? 5 : 0) +
      (isFaqDoubt ? 4 : 0) +
      (hasGeneralKey ? 2 : 0) +
      (idx === lastIdx ? 2 : 0) +
      (idx === 0 ? 1 : 0);
    return { entry, idx, score, isHighPriority };
  });

  const highPriority = scored.filter((item) => item.isHighPriority);
  if (highPriority.length > cap) {
    const topHigh = highPriority
      .slice()
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .slice(0, Math.min(highPriority.length, cap + 2))
      .sort((a, b) => a.idx - b.idx);

    const totalFacts = topHigh.length;
    const perFactBudget = Math.max(55, Math.floor((availChars - cap * 6) / totalFacts));
    const headCount = Math.max(0, cap - 1);
    const result = [];

    for (let i = 0; i < headCount; i++) {
      const item = topHigh[i];
      const prefixMatch = String(item.entry.text || '').match(/^(\s*(?:[-*•]|\d+[.)])\s+)/);
      const bulletPrefix = prefixMatch ? prefixMatch[1] : item.entry.isSubBullet ? '  - ' : '- ';
      const fact = extractCoreFactSentence(item.entry.text, perFactBudget);
      result.push({
        ...item.entry,
        text: `${bulletPrefix}${fact}`,
        mergedCount: 1,
      });
    }

    const mergeGroup = topHigh.slice(headCount);
    if (mergeGroup.length > 0) {
      const firstMerge = mergeGroup[0];
      const prefixMatch = String(firstMerge.entry.text || '').match(/^(\s*(?:[-*•]|\d+[.)])\s+)/);
      const bulletPrefix = prefixMatch
        ? prefixMatch[1]
        : firstMerge.entry.isSubBullet
          ? '  - '
          : '- ';
      const mergedFacts = mergeGroup
        .map((m) => extractCoreFactSentence(m.entry.text, perFactBudget))
        .filter(Boolean);
      result.push({
        ...firstMerge.entry,
        text: `${bulletPrefix}${mergedFacts.join(' ')}`,
        mergedCount: mergeGroup.length,
      });
    }
    return result;
  }

  return scored
    .slice()
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, cap)
    .sort((a, b) => a.idx - b.idx)
    .map((item) => item.entry);
}

/**
 * Formats and bounds a single topic block (either a specific topic section or a bulleted topic item
 * with optional sub-bullets) to at most `maxBulletsPerTopic` bullets and `maxTopicChars` characters,
 * while keeping Markdown tables and fenced code blocks intact on their own lines.
 */
function boundSingleTopicBlock(
  lines,
  {
    heading = '',
    maxBulletsPerTopic = DEFAULT_MAX_BULLETS_PER_TOPIC,
    maxTopicChars = DEFAULT_MAX_TOPIC_CHARS,
  } = {}
) {
  const headingStr = String(heading || '').trim();
  const availForBody = headingStr
    ? Math.max(80, maxTopicChars - headingStr.length - 1)
    : maxTopicChars;

  const entries = parseTopicEntries(lines);
  if (entries.length === 0) {
    return headingStr ? clipTextCleanly(headingStr, maxTopicChars) : '';
  }

  // Select entries: preserve 'table' and 'code' blocks and cap 'text' bullets to maxBulletsPerTopic
  const contentEntries = entries.filter((e) => e.type !== 'blank');
  const hasStructuredBlock = contentEntries.some((e) => e.type === 'table' || e.type === 'code');
  const firstIsHeaderWithSubs =
    contentEntries.length > 1 &&
    contentEntries[0] &&
    !contentEntries[0].isSubBullet &&
    contentEntries.slice(1).some((e) => e.isSubBullet);
  const isFaqItem =
    firstIsHeaderWithSubs && isFaqTitleEntry(contentEntries[0], contentEntries.slice(1));
  const treatFirstBulletAsHeader = firstIsHeaderWithSubs && (!headingStr || isFaqItem);
  const effectiveNestedLimit = isFaqItem
    ? Math.max(2, maxBulletsPerTopic)
    : treatFirstBulletAsHeader
      ? Math.max(1, maxBulletsPerTopic)
      : Math.max(0, maxBulletsPerTopic - 1);

  let selectedEntries;
  if (hasStructuredBlock) {
    let topicBulletCount = 0;
    let nestedBulletCount = 0;
    selectedEntries = contentEntries.filter((e) => {
      if (e.type === 'table' || e.type === 'code' || (!e.isBullet && !e.isSubBullet)) return true;
      if (e.isSubBullet) {
        nestedBulletCount++;
        return nestedBulletCount <= effectiveNestedLimit;
      }
      topicBulletCount++;
      return topicBulletCount <= Math.max(1, maxBulletsPerTopic);
    });
  } else if (firstIsHeaderWithSubs) {
    // The top-level item is the topic/FAQ header; nested bullets are its details.
    const headerEntry = contentEntries[0];
    const subBudget = Math.max(100, availForBody - String(headerEntry.text || '').length - 1);
    const subBullets = contentEntries.slice(1).filter((e) => e.isSubBullet);
    const chosenSubs = selectAndMergePriorityBullets(subBullets, effectiveNestedLimit, subBudget);
    const chosenSubSet = new Set(chosenSubs);
    const nonSubEntries = contentEntries.slice(1).filter((e) => !e.isSubBullet);
    selectedEntries = [headerEntry, ...nonSubEntries.slice(0, 1), ...chosenSubs];
    if (chosenSubSet.size === 0 && nonSubEntries.length === 0) {
      selectedEntries = [headerEntry];
    }
  } else {
    const nonBullets = contentEntries.filter((e) => !e.isBullet && !e.isSubBullet);
    const bullets = contentEntries.filter((e) => e.isBullet || e.isSubBullet);
    const chosenBullets = selectAndMergePriorityBullets(
      bullets,
      Math.max(1, maxBulletsPerTopic),
      availForBody
    );
    selectedEntries = [...nonBullets.slice(0, 1), ...chosenBullets];
  }

  const outLines = [];
  let usedChars = 0;

  for (let i = 0; i < selectedEntries.length; i++) {
    const entry = selectedEntries[i];
    const remaining = availForBody - usedChars - (outLines.length > 0 ? 1 : 0);
    if (remaining < 45 && entry.type === 'text') break;

    let renderedEntry;
    if (entry.type === 'table') {
      renderedEntry = boundTableBlock(entry.rows, Math.max(remaining, 160));
    } else if (entry.type === 'code') {
      renderedEntry = boundCodeFenceBlock(entry.lines, Math.max(remaining, 120));
    } else {
      const restEntries = selectedEntries.slice(i);
      const restTotalRawLen = restEntries.reduce(
        (sum, e, idx) => sum + String(e.text || '').length + (idx > 0 ? 1 : 0),
        0
      );
      let entryBudget;
      if (restTotalRawLen <= remaining || i === selectedEntries.length - 1) {
        entryBudget = remaining;
      } else if (i === 0 && firstIsHeaderWithSubs) {
        const subReserve = Math.min(260, Math.floor(remaining * 0.65));
        entryBudget = Math.max(60, remaining - subReserve);
      } else {
        const currentWeight = entry.mergedCount || 1;
        const totalRemainingWeight = restEntries.reduce((sum, e) => sum + (e.mergedCount || 1), 0);
        const laterRawLen = restEntries
          .slice(1)
          .reduce((sum, e) => sum + String(e.text || '').length + 1, 0);
        const proportionalShare = Math.floor(
          ((remaining - (restEntries.length - 1)) * currentWeight) /
            Math.max(1, totalRemainingWeight)
        );
        entryBudget = Math.max(
          70,
          Math.min(remaining - Math.min(laterRawLen, Math.max(70, remaining - proportionalShare)), proportionalShare + 30)
        );
      }
      const indentation = String(entry.text || '').match(/^\s*/)?.[0] || '';
      renderedEntry = `${indentation}${clipTextCleanly(
        String(entry.text || '').slice(indentation.length),
        Math.max(40, entryBudget - indentation.length)
      )}`;
    }

    if (renderedEntry) {
      const separator = outLines.length === 0 ? '' : entry.blankBefore ? '\n\n' : '\n';
      outLines.push(`${separator}${renderedEntry}`);
      usedChars += renderedEntry.length + separator.length;
    }
  }

  const body = outLines.join('');
  if (!headingStr) {
    return body;
  }
  return body ? `${headingStr}\n${body}` : clipTextCleanly(headingStr, maxTopicChars);
}

function groupUmbrellaSectionLines(contentLines) {
  const topicGroups = [];
  let activeTopicHeader = false;
  let idx = 0;

  while (idx < contentLines.length) {
    const line = contentLines[idx];
    const trimmed = line.trim();

    if (!trimmed) {
      if (topicGroups.length > 0) topicGroups[topicGroups.length - 1].push('');
      idx++;
      continue;
    }

    // Keep fenced code block together in current or new topic group
    if (isCodeFenceLine(line)) {
      const fenceBlock = [line];
      idx++;
      while (idx < contentLines.length) {
        fenceBlock.push(contentLines[idx]);
        if (isCodeFenceLine(contentLines[idx])) {
          idx++;
          break;
        }
        idx++;
      }
      if (topicGroups.length > 0) {
        topicGroups[topicGroups.length - 1].push(...fenceBlock);
      } else {
        topicGroups.push(fenceBlock);
      }
      continue;
    }

    // Keep Markdown table rows together as a dedicated group
    if (isMarkdownTableRow(line)) {
      const tableBlock = [trimmed];
      idx++;
      while (idx < contentLines.length && isMarkdownTableRow(contentLines[idx])) {
        tableBlock.push(contentLines[idx].trim());
        idx++;
      }
      topicGroups.push(tableBlock);
      activeTopicHeader = false;
      continue;
    }

    const isIndented = /^\s{2,}/.test(line);
    const isBoldTopicBullet = !isIndented && /^(?:[-*•]|\d+[.)])\s+\*\*[^*\n]+\*\*/.test(trimmed);
    const isColonTopicHeader =
      !isIndented &&
      !/^(?:[-*•]|\d+[.)])\s+/.test(trimmed) &&
      /^(?:\*\*[^*\n]+\*\*|[A-Z][^\n:*]{2,80}):\s*$/.test(trimmed);
    const isTopBullet = !isIndented && /^(?:[-*•]|\d+[.)])\s+/.test(trimmed);
    const isInlineBoldTopic =
      !isIndented && /^\*\*[^*\n]+(?::\*\*|\*\*:)\s+\S/.test(trimmed);

    if (isColonTopicHeader) {
      topicGroups.push([line]);
      activeTopicHeader = true;
    } else if (isBoldTopicBullet || isInlineBoldTopic) {
      topicGroups.push([line]);
      activeTopicHeader = false;
    } else if (isTopBullet) {
      if (activeTopicHeader && topicGroups.length > 0) {
        topicGroups[topicGroups.length - 1].push(`  ${trimmed}`);
      } else {
        topicGroups.push([line]);
        activeTopicHeader = false;
      }
    } else if (isIndented && topicGroups.length > 0) {
      topicGroups[topicGroups.length - 1].push(line);
    } else if (topicGroups.length === 0) {
      topicGroups.push([line]);
    } else {
      topicGroups[topicGroups.length - 1].push(line);
    }
    idx++;
  }

  return topicGroups;
}

/**
 * Checks whether a sanitized digest string already complies with both the total character budget
 * (`maxTotalChars`) and the per-topic character & bullet budgets (`maxTopicChars`, `maxBulletsPerTopic`).
 */
function isDigestWithinBudget(
  sanitized,
  {
    maxTopicChars = DEFAULT_MAX_TOPIC_CHARS,
    maxBulletsPerTopic = DEFAULT_MAX_BULLETS_PER_TOPIC,
    maxTopicsPerSection = Number.POSITIVE_INFINITY,
    maxTotalChars = DEFAULT_MAX_DIGEST_CHARS,
  } = {}
) {
  if (!sanitized || typeof sanitized !== 'string') return true;
  if (sanitized.length > maxTotalChars || Number.isFinite(maxTopicsPerSection)) {
    return false;
  }

  const rawLines = sanitized.split('\n');
  const sections = [];
  let currentSection = { heading: '', lines: [] };
  let inFence = false;

  for (const line of rawLines) {
    if (isCodeFenceLine(line)) {
      inFence = !inFence;
      currentSection.lines.push(line);
      continue;
    }
    if (!inFence && isSectionHeadingLine(line)) {
      if (currentSection.heading || currentSection.lines.some((l) => l.trim())) {
        sections.push(currentSection);
      }
      currentSection = { heading: line.trim(), lines: [] };
    } else {
      currentSection.lines.push(line);
    }
  }
  if (currentSection.heading || currentSection.lines.some((l) => l.trim())) {
    sections.push(currentSection);
  }

  const classifySection = (sec, contentLines) => {
    const structuredTopicCount = countTopLevelStructuredTopics(contentLines);
    if (structuredTopicCount >= 2) {
      return 'umbrella';
    }
    if (sec.heading && /\b(?:overview|vibe)\b/i.test(sec.heading) && structuredTopicCount === 0) {
      return 'overview';
    }
    if (!sec.heading || isCanonicalUmbrellaHeading(sec.heading)) {
      return 'umbrella';
    }
    return 'single-topic';
  };

  return sections.every((sec) => {
    const nonEmptyLines = sec.lines.filter((l) => l.trim().length > 0);
    if (!sec.heading && nonEmptyLines.length === 0) return true;
    const contentLines = sec.lines.filter(
      (l) => !/^_Note:/i.test(l.trim()) && !/^-\s*\*\.\.\.and\s+\d+\s+more\s+topic/i.test(l.trim())
    );
    const kind = classifySection(sec, contentLines);
    if (kind === 'overview') {
      const overviewText = contentLines.map((l) => l.trim()).join(' ');
      return overviewText.length <= Math.min(340, maxTopicChars);
    }
    if (kind === 'single-topic') {
      return isTopicBlockCompliant(contentLines, {
        heading: sec.heading,
        maxBulletsPerTopic,
        maxTopicChars,
        maxTotalChars,
      });
    }
    const topicGroups = groupUmbrellaSectionLines(contentLines);
    return topicGroups.every((grp) =>
      isTopicBlockCompliant(grp, {
        heading: '',
        maxBulletsPerTopic,
        maxTopicChars,
        maxTotalChars,
      })
    );
  });
}

/**
 * Enforces a presentation-friendly, concise Channel Digest with explicit per-topic and total
 * character budgets (default: max 2 bullets/topic, <= 450 chars/topic, <= 2,000 chars total),
 * redacting any participant names/handles, preserving Markdown tables and fenced code blocks,
 * keeping all topics when within the total character budget, and appending a transparent
 * "...and N more topics omitted for brevity." note if topics ever have to be cut to fit budget.
 *
 * @param {string} rawSummary
 * @param {object} [options]
 * @param {number} [options.maxTopicChars=450]
 * @param {number} [options.maxBulletsPerTopic=2]
 * @param {number} [options.maxTopicsPerSection=Infinity]
 * @param {number} [options.maxTotalChars=2000]
 * @param {Array<string>} [options.knownAuthors=[]]
 * @returns {string}
 */
export function enforceConciseDigest(
  rawSummary,
  {
    maxTopicChars = DEFAULT_MAX_TOPIC_CHARS,
    maxBulletsPerTopic = DEFAULT_MAX_BULLETS_PER_TOPIC,
    maxTopicsPerSection = Number.POSITIVE_INFINITY,
    maxTotalChars = DEFAULT_MAX_DIGEST_CHARS,
    knownAuthors = [],
  } = {}
) {
  if (!rawSummary || typeof rawSummary !== 'string') {
    return '';
  }

  const sanitized = redactParticipantNames(rawSummary, knownAuthors);
  if (!sanitized) {
    return '';
  }

  // Byte-for-byte fast path: only when the total digest AND every individual section/topic block
  // already comply with `maxTopicChars`, `maxBulletsPerTopic`, and `maxTopicsPerSection`.
  if (
    isDigestWithinBudget(sanitized, {
      maxTopicChars,
      maxBulletsPerTopic,
      maxTopicsPerSection,
      maxTotalChars,
    })
  ) {
    return sanitized;
  }

  const rawLines = sanitized.split('\n');
  const sections = [];
  let currentSection = { heading: '', lines: [] };
  let inFence = false;

  for (const line of rawLines) {
    if (isCodeFenceLine(line)) {
      inFence = !inFence;
      currentSection.lines.push(line);
      continue;
    }
    if (!inFence && isSectionHeadingLine(line)) {
      if (currentSection.heading || currentSection.lines.some((l) => l.trim())) {
        sections.push(currentSection);
      }
      currentSection = { heading: line.trim(), lines: [] };
    } else {
      currentSection.lines.push(line);
    }
  }
  if (currentSection.heading || currentSection.lines.some((l) => l.trim())) {
    sections.push(currentSection);
  }

  const classifySection = (sec, contentLines) => {
    const structuredTopicCount = countTopLevelStructuredTopics(contentLines);
    if (structuredTopicCount >= 2) {
      return 'umbrella';
    }
    if (sec.heading && /\b(?:overview|vibe)\b/i.test(sec.heading) && structuredTopicCount === 0) {
      return 'overview';
    }
    if (!sec.heading || isCanonicalUmbrellaHeading(sec.heading)) {
      return 'umbrella';
    }
    return 'single-topic';
  };

  const renderSections = (topicCharLimit, bulletsPerTopicLimit, topicsPerSecLimit) => {
    const rendered = [];
    let standaloneTopicCount = 0;
    let omittedStandaloneTopics = 0;
    const preserveCompliantVerbatim =
      topicCharLimit === maxTopicChars && bulletsPerTopicLimit === maxBulletsPerTopic;

    for (const sec of sections) {
      const nonEmptyLines = sec.lines.filter((l) => l.trim().length > 0);
      if (!sec.heading && nonEmptyLines.length === 0) continue;

      // Separate trailing italic note line if present
      const noteLines = nonEmptyLines.filter(
        (l) => /^_Note:/i.test(l.trim()) || /^-\s*\*\.\.\.and\s+\d+\s+more\s+topic/i.test(l.trim())
      );
      const contentLines = sec.lines.filter(
        (l) => !/^_Note:/i.test(l.trim()) && !/^-\s*\*\.\.\.and\s+\d+\s+more\s+topic/i.test(l.trim())
      );
      const kind = classifySection(sec, contentLines);

      // Single-topic section (e.g. "### EAP licensing, quota, credits, and top-up policy")
      if (kind === 'single-topic') {
        standaloneTopicCount++;
        if (Number.isFinite(topicsPerSecLimit) && standaloneTopicCount > topicsPerSecLimit) {
          omittedStandaloneTopics++;
          continue;
        }
        const boundedTopic =
          preserveCompliantVerbatim &&
          isTopicBlockCompliant(contentLines, {
            heading: sec.heading,
            maxBulletsPerTopic: bulletsPerTopicLimit,
            maxTopicChars: topicCharLimit,
            maxTotalChars,
          })
            ? [sec.heading, ...trimBlankOuterLines(contentLines)].filter(Boolean).join('\n')
            : boundSingleTopicBlock(contentLines, {
                heading: sec.heading,
                maxBulletsPerTopic: bulletsPerTopicLimit,
                maxTopicChars: topicCharLimit,
              });
        rendered.push(
          noteLines.length > 0 ? `${boundedTopic}\n\n${noteLines[0].trim()}` : boundedTopic
        );
        continue;
      }

      // Overview section: keep 1-2 sentences, <= 340 chars
      if (kind === 'overview') {
        const overviewLimit = Math.min(340, topicCharLimit);
        const rawOverview = trimBlankOuterLines(contentLines).join('\n');
        const overviewText = contentLines.map((l) => l.trim()).join(' ');
        const clippedOverview =
          preserveCompliantVerbatim && rawOverview.length <= overviewLimit
            ? rawOverview
            : overviewText
              ? clipTextCleanly(overviewText, overviewLimit)
              : '';
        const block = [sec.heading, clippedOverview].filter(Boolean).join('\n');
        rendered.push(
          noteLines.length > 0 ? `${block}\n\n${noteLines[0].trim()}` : block
        );
        continue;
      }

      // Umbrella section (detected by >= 2 bold-labelled topic items or canonical umbrella heading)
      const topicGroups = groupUmbrellaSectionLines(contentLines);

      const effectiveGroupLimit = Number.isFinite(topicsPerSecLimit)
        ? Math.max(1, topicsPerSecLimit)
        : topicGroups.length;
      const omittedInSec = Math.max(0, topicGroups.length - effectiveGroupLimit);

      const boundedTopics = topicGroups
        .slice(0, effectiveGroupLimit)
        .map((grp) => {
          const isPureTable = grp.every((l) => isMarkdownTableRow(l));
          const effectiveLimit = isPureTable
            ? Math.max(topicCharLimit, maxTotalChars)
            : topicCharLimit;
          if (
            preserveCompliantVerbatim &&
            isTopicBlockCompliant(grp, {
              heading: '',
              maxBulletsPerTopic: bulletsPerTopicLimit,
              maxTopicChars: effectiveLimit,
              maxTotalChars,
            })
          ) {
            return trimBlankOuterLines(grp).join('\n');
          }
          return boundSingleTopicBlock(grp, {
            heading: '',
            maxBulletsPerTopic: bulletsPerTopicLimit,
            maxTopicChars: effectiveLimit,
          });
        })
        .filter(Boolean);

      if (omittedInSec > 0) {
        boundedTopics.push(
          `- *...and ${omittedInSec} more ${omittedInSec === 1 ? 'topic' : 'topics'} omitted for brevity.*`
        );
      }

      const secBody = boundedTopics.join('\n');
      const secBlock = [sec.heading, secBody].filter(Boolean).join('\n');
      rendered.push(
        noteLines.length > 0 ? `${secBlock}\n\n${noteLines[0].trim()}` : secBlock
      );
    }

    if (omittedStandaloneTopics > 0) {
      rendered.push(
        `- *...and ${omittedStandaloneTopics} more ${omittedStandaloneTopics === 1 ? 'topic' : 'topics'} omitted for brevity.*`
      );
    }

    return rendered.filter(Boolean).join('\n\n').trim();
  };

  // Pass 1: Keep all topics (unless caller explicitly set maxTopicsPerSection), bounding each topic to maxTopicChars
  let result = renderSections(maxTopicChars, maxBulletsPerTopic, maxTopicsPerSection);

  // Pass 2: If over maxTotalChars, first tighten per-topic length and bullets per topic while still keeping all topics
  if (result.length > maxTotalChars) {
    const scale = Math.max(0.45, maxTotalChars / result.length);
    const tighterTopicChars = Math.max(180, Math.floor(maxTopicChars * scale));
    result = renderSections(tighterTopicChars, maxBulletsPerTopic, maxTopicsPerSection);
  }

  if (result.length > maxTotalChars) {
    const scale = Math.max(0.4, maxTotalChars / result.length);
    const singleBulletTopicChars = Math.max(170, Math.min(260, Math.floor(maxTopicChars * scale)));
    result = renderSections(singleBulletTopicChars, 1, maxTopicsPerSection);
  }

  // Pass 3: Only if still over maxTotalChars, progressively cap topic count per section (which transparently adds "...and N more topics omitted for brevity.")
  if (result.length > maxTotalChars) {
    for (const topicCap of [8, 6, 5, 4, 3, 2]) {
      if (topicCap > maxTopicsPerSection) continue;
      const capTopicChars = Math.max(180, Math.min(280, Math.floor((maxTotalChars - 120) / topicCap)));
      result = renderSections(capTopicChars, 1, topicCap);
      if (result.length <= maxTotalChars) {
        break;
      }
    }
  }

  if (result.length > maxTotalChars) {
    result = clipTextCleanly(result, maxTotalChars);
  }

  return result;
}

const NEGATED_CONFIRMATION_PATTERN =
  /\b(?:not|never|no|isn'?t|aren'?t|wasn'?t|weren'?t|didn'?t|doesn'?t|don'?t|can'?t|cannot|won'?t|still\s+not|yet\s+to\s+be|un|non[-\s]?)\s*(?:solved|resolved|fixed|answered|working|works|work|helped|resuelto|solucionado)\b|\b(?:unresolved|unsolved|unanswered|unfixed|still\s+broken|still\s+crashing|still\s+failing|still\s+having|still\s+persists|still\s+spikes|(?:does|do|did)\s+not\s+work|(?:doesn'?t|don'?t|didn'?t)\s+work|(?:does|do|did)\s+not\s+help|(?:doesn'?t|don'?t|didn'?t)\s+help|not\s+work(?:ing)?|(?:not\s+work(?:ing)?|(?:does|do|did)\s+not\s+work|(?:doesn'?t|don'?t|didn'?t)\s+work|no\s+luck|fails?|failed)\s+either|sin\s+resolver|no\s+funciona)\b/i;

const NOISE_OR_ME_TOO_REPLY_PATTERN =
  /^(?:\+1|me\s+too|same|same\s+here|same\s+issue|same\s+problem|same\s+error|i\s+have\s+the\s+same|having\s+the\s+same|also\s+(?:having|getting|experiencing|crashing|broken|failing|seeing)|bump|following|any\s+update|any\s+news)\b|\b(?:same\s+(?:here|issue|problem|error|bug|for\s+me)|me\s+too|(?:i\s+)?need\s+this\s+too|i\s+also\s+need\s+this|looking\s+for\s+this\s+too|happens\s+to\s+me\s+too|also\s+(?:crashing|broken|failing|getting\s+this)|i'?m\s+having\s+the\s+same)\b/i;

const EXPLICIT_CONFIRMATION_PATTERN =
  /\b(?:that\s+fixed\s+it|fixed\s+it\s+immediately|fixed\s+the\s+(?:issue|problem|bug|error)|solved\s+(?:it|my|the)|resolved\s+(?:it|the\s+issue|the\s+problem|the\s+disconnects)|confirmed\s+that\s+.*\b(?:resolved|fixed|works|working)|(?:it\s+)?works\s+now|working\s+now|that\s+worked|figured\s+it\s+out|i\s+(?:solved|resolved|fixed)\s+it|ya\s+lo\s+solucion[eé]|ya\s+funciona|funcion[oó]\s+perfectamente)\b/i;

const SOLVED_TITLE_OR_TAG_PATTERN =
  /(?:\[(?:solved|resolved|answered|fixed)\]|\((?:solved|resolved|answered|fixed)\)|✅|✔️)/i;

const SOLVED_TAG_WORD_PATTERN =
  /\b(?:solved|resolved|answered|fixed|completed|done|resuelto|solucionado)\b/i;

export const SYSTEM_PROMPT = `You are an expert community manager and technical scribe for a Discord server.
Your task is to analyze a chronological chat transcript and produce a basic, concise, presentation-friendly summary in English.

Follow this exact Markdown structure:
**Overview**
1-2 sentences summarizing the overall vibe and main focus of the conversation.

**Key Topics Discussed**
- Group related discussions into at most 4–6 key topics (max 2 bullets per topic and <= 400 characters per topic) describing the main subjects and technical context.

**Most Used Keywords & Themes**
- Highlight the most repeated keywords and technical concepts in the conversation.

**Decisions & Outcomes**
- Concise bullet points of any conclusions, agreements, or answers reached (or state "None recorded" if casual chat).

**Open Questions & Action Items**
- Concise bullet points of unresolved questions, blockers, or next steps mentioned (or "None").

Guidelines:
- Keep it brief, objective, and easy to scan (at most 4–6 topics per section, max 2 bullets per topic, 300–450 characters per topic, and 1,500–2,000 characters maximum in total).
- Include NO person names at all (including participants, staff, or people mentioned), usernames, or @handles; refer to people generically (e.g., "users", "developers", "team members", "support staff").
- Do not invent facts outside the provided transcript.`;

export const GENERAL_CHAT_SYSTEM_PROMPT = `You are an expert community analyst summarizing a General Chat channel from a Discord server.
Your goal is to produce a basic, concise, presentation-friendly summary of the main discussion topics, recurring themes, and most frequently used keywords.

Follow this exact Markdown structure:
**Chat Overview & Community Vibe**
1-2 sentences describing the tone, activity level, and general focus of the chat.

**Main Discussion Topics**
- Synthesize discussions into at most 4–6 core topics (at most 2 concise bullets per topic and 300–450 characters per topic) covering primary subjects, key facts, decisions, and open uncertainties.

**Top Keywords & Trending Terms**
- Incorporate the provided exact keyword frequency rankings (word count and message count) and briefly explain their context.

**Notable Highlights & Shared Ideas**
- At most 2 concise bullet points of key takeaways, feedback, or tips shared in the chat.

Guidelines:
- Keep the entire channel digest concise (at most 4–6 topics per section, 300–450 characters per topic, and 1,500–2,000 characters maximum in total) and presentation-ready.
- Include NO person names at all (including participants, staff, or people mentioned), usernames, or @handles; refer to people generically.
- Use only the facts and exact keyword counts provided in the prompt without inventing metrics.`;

export const QA_SYSTEM_PROMPT = `You are a Senior Technical Support Analyst summarizing a Q&A / Support Forum or Question channel from a Discord server.
Your goal is to analyze structured Forum Posts (Question + Replies units) or Q&A transcripts to produce a basic, concise digest of the most frequent user doubts (FAQ), recurring technical problems, answers/workarounds offered, and unanswered questions.

Follow this exact Markdown structure:
**Support & Q&A Overview**
1-2 sentences summarizing the volume of questions/posts, main areas of confusion, and resolution breakdown (distinguishing explicitly confirmed fixes from heuristic/unconfirmed answer replies and unanswered posts).

**Most Frequent Questions & Common Doubts (FAQ)**
- Group the most common doubts and recurring questions into at most 4–6 FAQ topics (at most 2 bullets per topic and 300–450 characters per topic), noting the thread/post topic and why users are running into them.

**Confirmed Solutions & Answers Provided**
- Concise bullet points mapping questions/issues to the answers or workarounds provided (at most 4–6 topics, max 2 bullets per topic).
- Strictly distinguish between **Confirmed Resolutions** (where the asker or a solved tag explicitly confirmed the fix worked) and **Suggested Answers / Unconfirmed Replies** (heuristic matches where a reply offered guidance, but resolution was not confirmed). Never claim a reply is a confirmed solution based solely on heuristic \`answered\` status.

**Unanswered Questions & Pending Issues**
- Concise bullet points of forum posts or questions that remain unresolved or need team follow-up.

Guidelines:
- Treat each Forum Post (Title + Starter Question + Replies) as a single cohesive unit.
- Keep the entire channel digest concise (at most 4–6 topics per section, 300–450 characters per topic, and 1,500–2,000 characters maximum in total).
- Include NO person names at all (including participants, staff, or people mentioned), usernames, or @handles; refer to people generically.
- Do not invent facts or confirmed resolutions outside the provided transcript and deterministic metrics.`;

/**
 * Determines whether the first message in `post.messages` is the thread's starter message
 * (as opposed to a reply when the original starter message was deleted/missing).
 *
 * @param {object} post
 * @returns {boolean}
 */
export function hasPostStarterMessage(post) {
  if (!post || !Array.isArray(post.messages) || post.messages.length === 0) {
    return false;
  }
  if (post.missingStarter === true || post._missingStarter === true) {
    return false;
  }
  if (post.missingStarter === false) {
    return true;
  }
  const firstMsg = post.messages[0];
  if (!firstMsg) return false;

  const postIdStr = String(post.postId ?? post.id ?? '').trim();
  const firstIdStr = String(firstMsg.id ?? '').trim();

  if (postIdStr && firstIdStr && postIdStr === firstIdStr) {
    return true;
  }
  if (/^\[Forum Post:\s*"/i.test(String(firstMsg.content || ''))) {
    return true;
  }

  if (typeof post.replyCount === 'number' && !post.partCount) {
    if (post.replyCount === post.messages.length) {
      return false;
    }
    if (post.replyCount === post.messages.length - 1) {
      return true;
    }
  }

  if (post.partCount && post.partCount > 1 && postIdStr && firstIdStr && postIdStr !== firstIdStr) {
    return false;
  }

  return true;
}

/**
 * Determines whether a Forum Post's resolution is explicitly confirmed (via solved tag/title,
 * explicit boolean, or non-negated starter-author confirmation) rather than merely having a
 * heuristic guidance reply.
 *
 * @param {object} post
 * @param {object|null} starterMsg
 * @param {Array<object>} replyMessages
 * @param {string} postAuthor
 * @returns {boolean}
 */
function isForumPostConfirmed(post, starterMsg, replyMessages, postAuthor) {
  if (post?.confirmed === true || post?.resolved === true) {
    return true;
  }
  if (post?.confirmed === false) {
    return false;
  }

  // If the starter author's latest follow-up explicitly states the issue is still broken/not working, it is not confirmed
  const normPostAuthor = String(postAuthor || '')
    .trim()
    .toLowerCase();
  const hasKnownAuthor =
    Boolean(normPostAuthor) &&
    normPostAuthor !== 'unknown user' &&
    !normPostAuthor.startsWith('user:');

  const authorFollowUps = hasKnownAuthor
    ? replyMessages.filter(
        (m) => String(m?.author || '').trim().toLowerCase() === normPostAuthor
      )
    : [];

  if (authorFollowUps.length > 0) {
    const lastFollowUpText = String(
      authorFollowUps[authorFollowUps.length - 1]?.content || ''
    ).trim();
    if (NEGATED_CONFIRMATION_PATTERN.test(lastFollowUpText)) {
      return false;
    }
  }

  const title = String(post?.title || post?.name || '');
  if (!NEGATED_CONFIRMATION_PATTERN.test(title) && SOLVED_TITLE_OR_TAG_PATTERN.test(title)) {
    return true;
  }

  const resolvedTagNames = resolveForumAppliedTagNames(post);
  for (const tagName of resolvedTagNames) {
    if (
      !NEGATED_CONFIRMATION_PATTERN.test(tagName) &&
      SOLVED_TAG_WORD_PATTERN.test(tagName)
    ) {
      return true;
    }
  }

  for (const followUp of authorFollowUps) {
    const text = String(followUp?.content || '').trim();
    if (!text || NEGATED_CONFIRMATION_PATTERN.test(text)) {
      continue;
    }
    if (EXPLICIT_CONFIRMATION_PATTERN.test(text)) {
      return true;
    }
  }

  return false;
}

const WRAPPED_BASE64_LINE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const WRAPPED_BASE64_WIDTHS = new Set([64, 76]);
const ENCODED_BLOB_MIN_LENGTH = 128;

/**
 * Checks whether a long run has high entropy plus corroborating base64 characteristics
 * (padding, mixed case with digits, or base64 delimiters).
 *
 * @param {string} run
 * @returns {boolean}
 */
function hasStrongEncodedEvidence(run) {
  const frequencies = new Map();
  for (const character of run) {
    frequencies.set(character, (frequencies.get(character) || 0) + 1);
  }
  const entropy = Array.from(frequencies.values()).reduce((sum, frequency) => {
    const probability = frequency / run.length;
    return sum - probability * Math.log2(probability);
  }, 0);
  const hasMixedCase = /[a-z]/.test(run) && /[A-Z]/.test(run);
  const hasDigit = /\d/.test(run);
  const hasBase64Delimiter = /[+/]/.test(run);
  const hasPadding = /={1,2}$/.test(run);
  const hasEncodingEvidence =
    hasPadding ||
    (hasDigit && hasMixedCase) ||
    (hasMixedCase && hasBase64Delimiter) ||
    (hasDigit && hasBase64Delimiter);

  return entropy >= 4.2 && hasEncodingEvidence;
}

/**
 * Returns the index just after a wrapped base64 block (PEM 64-char or MIME/CLI 76-char lines,
 * with an optional shorter final line) starting at `start`, or `start` when no encoded block begins there.
 *
 * @param {Array<string>} lines
 * @param {number} start
 * @returns {number}
 */
function findWrappedBase64BlockEnd(lines, start) {
  const firstLine = lines[start].trim();
  const width = firstLine.length;
  if (!WRAPPED_BASE64_WIDTHS.has(width) || !WRAPPED_BASE64_LINE_PATTERN.test(firstLine)) {
    return start;
  }

  const blockLines = [firstLine];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!WRAPPED_BASE64_LINE_PATTERN.test(line) || line.length > width) break;
    blockLines.push(line);
    if (line.length < width) break;
  }

  const blob = blockLines.join('');
  if (blockLines.length < 2 || blob.length < ENCODED_BLOB_MIN_LENGTH || !hasStrongEncodedEvidence(blob)) {
    return start;
  }
  return start + blockLines.length;
}

/**
 * Removes whole wrapped base64 blocks (consecutive base64-alphabet lines of one fixed width,
 * as found in code fences and PEM envelopes) before any whitespace splitting.
 *
 * @param {string} text
 * @returns {string}
 */
function stripWrappedBase64Blocks(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let index = 0;
  while (index < lines.length) {
    const blockEnd = findWrappedBase64BlockEnd(lines, index);
    if (blockEnd > index) {
      kept.push(' ');
      index = blockEnd;
    } else {
      kept.push(lines[index]);
      index += 1;
    }
  }
  return kept.join('\n');
}

/**
 * Strips whitespace-separated runs that have strong evidence of being encoded blobs
 * BEFORE word tokenization, so characters like `+`, `/`, and `=` cannot split a base64
 * paste into short alphanumeric fragments. Wrapped base64 blocks (fenced or PEM lines)
 * are removed as a whole first. Longness or punctuation alone is not enough:
 * legitimate slash-separated names, KEY=value settings, and hyphenated terms survive.
 *
 * @param {string} text
 * @returns {string}
 */
function stripEncodedRunsBeforeTokenization(text) {
  return stripWrappedBase64Blocks(String(text || ''))
    .split(/\s+/)
    .filter((rawRun) => {
      if (!rawRun) return false;
      // Strip surrounding punctuation like quotes, brackets, parens, commas, periods, backticks
      const run = rawRun.replace(/^[^A-Za-z0-9+/=_-]+|[^A-Za-z0-9+/=_-]+$/g, '');
      if (!run) return false;

      // Long hexadecimal hashes are unambiguous enough to discard before tokenization.
      if (run.length >= 32 && /^[0-9a-f]+$/i.test(run) && /\d/.test(run)) {
        return false;
      }

      // A long token is considered encoded only when it also has high entropy and
      // corroborating base64 characteristics. This avoids treating ordinary technical
      // vocabulary as noise just because it contains '/', '=', or '-'.
      if (run.length >= ENCODED_BLOB_MIN_LENGTH && /^[A-Za-z0-9+/=_-]+$/.test(run) && hasStrongEncodedEvidence(run)) {
        return false;
      }

      return true;
    })
    .join(' ');
}

/**
 * Checks whether a candidate token looks like a random hash, hexadecimal ID, UUID,
 * base64/encoded blob, or excessively long unbroken string rather than a natural or
 * technical keyword.
 *
 * @param {string} token
 * @param {number} [maxLength=30]
 * @returns {boolean}
 */
function isNoiseOrEncodedToken(token, maxLength = 30) {
  if (!token || token.length > maxLength) return true;
  if (/^\d+$/.test(token)) return true;
  if (/(.)\1{4,}/u.test(token)) return true;

  // Hexadecimal / hash strings or hyphenated hex IDs
  if (token.length >= 8 && /^[0-9a-f]+$/i.test(token) && /\d/.test(token)) {
    return true;
  }
  if (/^[0-9a-f]{4,}(?:[-_][0-9a-f]{2,})+$/i.test(token) && /\d/.test(token)) {
    return true;
  }

  // Tokens mixing letters and digits: only allow canonical technical patterns
  // (e.g. oauth2, ipv4, ipv6, http2, web3, sha256, utf8, base64, v1, v2, 3d, 2fa, deepseek-v3, postgresql16, i18n, l10n, k8s, a11y, x86, x64, arm64)
  if (/\d/.test(token) && /\p{L}/u.test(token)) {
    const isCanonicalTechWithDigits =
      /^[a-z]{2,}(?:[-_][a-z]+)*-?v?\d{1,4}$/i.test(token) ||
      /^(?:v\d{1,3}|[23]d|2fa|i18n|l10n|k8s|a11y|x86|x64|h264|h265|mp3|mp4|s3|ec2)$/i.test(token);
    if (!isCanonicalTechWithDigits) {
      return true;
    }
  }

  // Repeated transitions between letters and digits (e.g. base64/hashes like a1b2c3, eyj1a2b)
  const alphaNumTransitions = (token.match(/\p{L}\d|\d\p{L}/gu) || []).length;
  const overlapTransitions = (token.match(/(?=(\p{L}\d|\d\p{L}))/gu) || []).length;
  if (Math.max(alphaNumTransitions, overlapTransitions) >= 2) {
    return true;
  }

  // Any unbroken segment between hyphens/underscores longer than 20 chars
  const segments = token.split(/[-_]/);
  if (segments.some((seg) => seg.length > 20)) {
    return true;
  }

  // 5+ consecutive ASCII consonants (typical of base64/minified blobs)
  if (/[bcdfghjklmnpqrstvwxz]{5,}/i.test(token)) {
    return true;
  }

  // Long tokens with abnormal vowel ratios
  if (token.length >= 10) {
    const letters = (token.match(/\p{L}/gu) || []).length;
    const vowels = (token.match(/[aeiouáéíóúü]/gi) || []).length;
    if (letters >= 8 && (vowels / letters < 0.2 || vowels / letters > 0.72)) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts the most frequently used meaningful keywords across an array of normalized messages.
 * Excludes out-of-window `contextOnly: true` messages by default so deterministic window keyword
 * rankings strictly reflect in-window activity, deduplicates message counts across continuation
 * parts of the same message ID, and filters out oversized/base64/hash tokens.
 *
 * @param {Array<object>} messages
 * @param {object} [options]
 * @param {number} [options.limit=10]
 * @param {number} [options.minLength=4]
 * @param {number} [options.maxLength=30]
 * @param {boolean} [options.includeContextOnly=false]
 * @returns {Array<{ word: string, count: number, messageCount: number }>}
 */
export function extractTopKeywords(
  messages = [],
  { limit = 10, minLength = 4, maxLength = 30, includeContextOnly = false, extraAuthors = [] } = {}
) {
  const wordFreq = new Map();
  const wordMsgCount = new Map();
  const seenByMsgId = new Map();

  // Only unmistakable participant identifiers (capitalized/symbolic/mixed-case single tokens) are
  // excluded from keyword counts; lowercase single-word names that are ordinary words ("pixel",
  // "river") stay countable so deterministic technical metrics are not distorted.
  const knownAuthorList = collectKnownAuthors(messages, [], extraAuthors);
  const knownAuthorLowerSet = new Set(knownAuthorList.map((a) => a.toLowerCase()));
  const authorHandleTokens = new Set();
  for (const author of knownAuthorList) {
    const kind = classifyAuthorIdentifier(author);
    const norm = author.toLowerCase().replace(/^[-_]+|[-_]+$/g, '');
    if (norm && !/\s/.test(norm) && (kind === 'strong-cs' || kind === 'strong-ci')) {
      authorHandleTokens.add(norm);
    }
  }

  for (let idx = 0; idx < (messages || []).length; idx++) {
    const msg = messages[idx];
    if (!msg) continue;
    if (!includeContextOnly && msg.contextOnly) continue;

    const rawContent = stripEncodedRunsBeforeTokenization(
      String(msg.content || '')
        .replace(/^\[Forum Post:\s*"[^"]*"\]\s*/i, '')
        .replace(/^\[(?:Reply\s+)?Part\s+\d+\/\d+\]\s*/i, '')
        .replace(/\[Attach(?:ed|ments):[^\]]*\]/gi, '')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/<a?:[\w-]+:\d+>/g, ' ')
        .replace(/<[@#!&]\d+>/g, ' ')
        .replace(
          new RegExp(`(?<![A-Za-z0-9_./:-])@(${AT_MENTION_BODY})${AT_MENTION_TAIL}`, 'g'),
          (fullMatch, handle) =>
            knownAuthorLowerSet.has(handle.toLowerCase()) ||
            !(isProtectedTerm(handle) || isAnnotationOrDirectiveHandle(handle))
              ? ' '
              : fullMatch
        )
    );

    const tokens = rawContent.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
    const msgKey =
      msg.id !== undefined && msg.id !== null && String(msg.id).trim() !== ''
        ? `id:${String(msg.id).trim()}`
        : `idx:${idx}`;
    let seenInMsg = seenByMsgId.get(msgKey);
    if (!seenInMsg) {
      seenInMsg = new Set();
      seenByMsgId.set(msgKey, seenInMsg);
    }

    for (const rawToken of tokens) {
      const token = rawToken.replace(/^[-_]+|[-_]+$/g, '');
      if (!token) continue;
      if (STOP_WORDS.has(token)) continue;
      if (authorHandleTokens.has(token)) continue;
      if (token.length < minLength && !SHORT_TECH_TERMS.has(token)) continue;
      if (isNoiseOrEncodedToken(token, maxLength)) continue;

      wordFreq.set(token, (wordFreq.get(token) || 0) + 1);
      if (!seenInMsg.has(token)) {
        seenInMsg.add(token);
        wordMsgCount.set(token, (wordMsgCount.get(token) || 0) + 1);
      }
    }
  }

  return Array.from(wordFreq.entries())
    .map(([word, count]) => ({
      word,
      count,
      messageCount: wordMsgCount.get(word) || 1,
    }))
    .sort((a, b) => b.count - a.count || b.messageCount - a.messageCount || a.word.localeCompare(b.word))
    .slice(0, limit);
}

/**
 * Extracts questions, common doubts, and forum post statistics from a channel's messages and forum posts.
 * Distinguishes confirmed resolutions (`confirmed: true`) from heuristic answer replies (`answered: true, confirmed: false`),
 * and preserves out-of-window starter questions (`starterContextOnly: true`) and missing starters (`missingStarter: true`).
 *
 * @param {Array<object>} messages - Normalized messages
 * @param {Array<object>} [posts=[]] - Optional forum posts (threads) array from a GuildForum channel
 * @returns {{
 *   totalQuestions: number,
 *   answeredCount: number,
 *   confirmedCount: number,
 *   heuristicAnsweredCount: number,
 *   unansweredCount: number,
 *   outOfWindowStarterCount: number,
 *   missingStarterCount: number,
 *   questions: Array<{
 *     id: string,
 *     title: string,
 *     author: string,
 *     question: string,
 *     replyCount: number,
 *     answered: boolean,
 *     confirmed: boolean,
 *     resolutionStatus: 'confirmed'|'heuristic'|'unanswered',
 *     starterContextOnly: boolean,
 *     missingStarter: boolean,
 *     answerPreview: string
 *   }>,
 *   questionKeywords: Array<{ word: string, count: number, messageCount: number }>
 * }}
 */
export function extractQuestionsAndDoubts(messages = [], posts = [], { extraAuthors = [] } = {}) {
  const extracted = [];
  const knownAuthors = collectKnownAuthors(messages, posts, extraAuthors);

  if (Array.isArray(posts) && posts.length > 0) {
    const seenPostIds = new Set();
    const uniquePosts = posts.filter((p) => {
      const pid = String(p?.postId ?? p?.id ?? '').trim();
      if (!pid) {
        return !(p?.partIndex && p.partIndex > 1);
      }
      if (seenPostIds.has(pid)) {
        return false;
      }
      seenPostIds.add(pid);
      return true;
    });

    for (const post of uniquePosts) {
      const postMessages = Array.isArray(post.messages) ? post.messages : [];
      const hasStarter = hasPostStarterMessage(post);
      const starterMsg = hasStarter ? postMessages[0] : null;
      const replyMessages = hasStarter ? postMessages.slice(1) : postMessages;
      const postAuthor = post.author || starterMsg?.author || 'Unknown User';
      const normAuthor = String(postAuthor).trim().toLowerCase();

      const rawQuestion =
        typeof post.starterQuestion === 'string' && post.starterQuestion.trim()
          ? post.starterQuestion.trim()
          : (starterMsg?.content || post.title || '');
      const cleanQuestion = redactParticipantNames(
        String(rawQuestion)
          .replace(/^\[Forum Post:\s*"[^"]*"\]\s*/i, '')
          .trim() ||
          post.title ||
          'Forum Question',
        knownAuthors
      );
      const cleanTitle =
        redactParticipantNames(post.title || 'Forum Question', knownAuthors) || 'Forum Question';

      const replyCount =
        typeof post.replyCount === 'number'
          ? post.replyCount
          : replyMessages.filter((m) => !m?.continuationPart).length;

      const confirmed = isForumPostConfirmed(post, starterMsg, replyMessages, postAuthor);
      const computedAnswered =
        typeof post.answered === 'boolean'
          ? post.answered
          : determineForumPostAnswered(
              hasStarter
                ? post
                : { ...post, _missingStarter: true, author: postAuthor },
              postMessages
            );
      const answered = Boolean(confirmed || computedAnswered);
      const resolutionStatus = confirmed
        ? 'confirmed'
        : answered
          ? 'heuristic'
          : 'unanswered';

      const bestReply =
        replyMessages.find((m) => {
          const text = String(m?.content || '').trim();
          const isOther = String(m?.author || '').trim().toLowerCase() !== normAuthor;
          return (
            isOther &&
            Boolean(text) &&
            !NOISE_OR_ME_TOO_REPLY_PATTERN.test(text) &&
            !NEGATED_CONFIRMATION_PATTERN.test(text)
          );
        }) ||
        replyMessages.find(
          (m) => String(m?.author || '').trim().toLowerCase() !== normAuthor
        ) ||
        replyMessages[0] ||
        null;

      const replyPreviewText = bestReply
        ? redactParticipantNames(
            String(bestReply.content || '')
              .replace(/^\[Forum Post:\s*"[^"]*"\]\s*/i, '')
              .replace(/^\[(?:Reply\s+)?Part\s+\d+\/\d+\]\s*/i, '')
              .trim(),
            knownAuthors
          )
        : '';

      const postTags = resolveForumAppliedTagNames(post);

      extracted.push({
        id: String(post.postId || post.id || extracted.length + 1),
        title: cleanTitle,
        author: '',
        question: cleanQuestion,
        replyCount,
        answered,
        confirmed,
        resolutionStatus,
        tags: postTags,
        starterContextOnly: Boolean(starterMsg?.contextOnly),
        missingStarter: !hasStarter,
        answerPreview: replyPreviewText ? clipTextCleanly(replyPreviewText, 180) : '',
      });
    }
  } else {
    const windowMessages = (messages || []).filter(
      (m) => m && !m.contextOnly && !m.continuationPart
    );
    const questionPattern =
      /\?|¿|\b(how|what|why|where|when|can i|could|is there|does anyone|anyone know|help|issue|error|problem|timeout|bug|crash|fails|failing|cómo|como|por qué|qué|donde|dónde|alguien sabe|ayuda|duda)\b/i;

    const consumedConfirmationIndices = new Set();

    for (let i = 0; i < windowMessages.length; i++) {
      if (consumedConfirmationIndices.has(i)) continue;
      const msg = windowMessages[i];
      const text = String(msg.content || '')
        .replace(/^\[(?:Reply\s+)?Part\s+\d+\/\d+\]\s*/i, '')
        .trim();
      if (!text) continue;
      if (NOISE_OR_ME_TOO_REPLY_PATTERN.test(text)) continue;

      const isExplicitQuestion = text.includes('?') || text.includes('¿');
      const isInitialIssueReport = i === 0 && questionPattern.test(text);
      if (!isExplicitQuestion && !isInitialIssueReport) {
        continue;
      }

      const lookahead = windowMessages.slice(i + 1, i + 6);
      const substantiveReplies = lookahead.filter((m) => {
        if (!m || m.author === msg.author) return false;
        const replyText = String(m.content || '').trim();
        if (!replyText || replyText.endsWith('?') || replyText.endsWith('¿')) return false;
        if (NOISE_OR_ME_TOO_REPLY_PATTERN.test(replyText)) return false;
        if (NEGATED_CONFIRMATION_PATTERN.test(replyText)) return false;
        return true;
      });

      const nextReply = substantiveReplies[0] || null;
      let confirmed = false;

      if (nextReply) {
        for (let j = i + 1; j < Math.min(windowMessages.length, i + 6); j++) {
          const followUp = windowMessages[j];
          const followText = String(followUp?.content || '').trim();
          if (!followText) continue;
          if (
            followUp.author === msg.author &&
            EXPLICIT_CONFIRMATION_PATTERN.test(followText) &&
            !NEGATED_CONFIRMATION_PATTERN.test(followText)
          ) {
            confirmed = true;
            consumedConfirmationIndices.add(j);
            break;
          }
        }
      }

      const answered = Boolean(confirmed || nextReply);
      const resolutionStatus = confirmed
        ? 'confirmed'
        : answered
          ? 'heuristic'
          : 'unanswered';

      const cleanText = redactParticipantNames(text, knownAuthors);
      const cleanAnswer = nextReply
        ? redactParticipantNames(String(nextReply.content || ''), knownAuthors)
        : '';

      extracted.push({
        id: String(msg.id || i + 1),
        title: clipTextCleanly(cleanText, 90),
        author: '',
        question: cleanText,
        replyCount: substantiveReplies.length,
        answered,
        confirmed,
        resolutionStatus,
        starterContextOnly: false,
        missingStarter: false,
        answerPreview: cleanAnswer ? clipTextCleanly(cleanAnswer, 180) : '',
      });
    }
  }

  const questionSourceMessages = extracted.map((q) => ({
    author: q.author,
    content: `${q.title} ${q.question}`,
  }));
  const questionKeywords = extractTopKeywords(questionSourceMessages, {
    limit: 8,
    extraAuthors: knownAuthors,
    includeContextOnly: true,
  });

  const answeredCount = extracted.filter((q) => q.answered).length;
  const confirmedCount = extracted.filter((q) => q.confirmed).length;
  const heuristicAnsweredCount = Math.max(0, answeredCount - confirmedCount);
  const unansweredCount = extracted.length - answeredCount;
  const outOfWindowStarterCount = extracted.filter((q) => q.starterContextOnly).length;
  const missingStarterCount = extracted.filter((q) => q.missingStarter).length;

  return {
    totalQuestions: extracted.length,
    answeredCount,
    confirmedCount,
    heuristicAnsweredCount,
    unansweredCount,
    outOfWindowStarterCount,
    missingStarterCount,
    questions: extracted,
    questionKeywords,
  };
}

/**
 * Formats an array of Forum Posts into a structured thread-by-thread transcript (Title + Author +
 * Starter Question + Replies + Resolution Status) for LLM consumption, bounded by character limits.
 *
 * @param {Array<object>} posts
 * @param {Array<object>} [fallbackMessages=[]]
 * @param {object} [options]
 * @param {number} [options.maxPromptChars=24000]
 * @param {number} [options.maxMessageChars=4000]
 * @returns {string}
 */
export function buildForumTranscript(
  posts = [],
  fallbackMessages = [],
  { maxPromptChars = 24000, maxMessageChars, extraAuthors = [] } = {}
) {
  const charBudget = Math.max(400, maxPromptChars);
  const msgCap =
    typeof maxMessageChars === 'number' && maxMessageChars > 0
      ? Math.max(200, maxMessageChars)
      : Math.max(200, charBudget - 250);
  const knownAuthors = collectKnownAuthors(fallbackMessages, posts, extraAuthors);

  if (!Array.isArray(posts) || posts.length === 0) {
    const { transcript } = buildTranscriptAndStats(fallbackMessages, {
      includeAuthors: false,
      contentFormatter: (txt) => redactParticipantNames(txt, knownAuthors),
    });
    return transcript.length > charBudget
      ? `${transcript.slice(0, charBudget)}\n...[transcript truncated at context budget]`
      : transcript;
  }

  const blocks = [];
  let totalChars = 0;

  for (let idx = 0; idx < posts.length; idx++) {
    const post = posts[idx];
    const postMessages = Array.isArray(post.messages) ? post.messages : [];
    const hasStarter = hasPostStarterMessage(post);
    const starterMsg = hasStarter ? postMessages[0] : null;
    const replyMessages = hasStarter ? postMessages.slice(1) : postMessages;
    const postAuthor = post.author || starterMsg?.author || 'Unknown User';

    const rawStarterQuestion =
      typeof post.starterQuestion === 'string' && post.starterQuestion.trim()
        ? post.starterQuestion.trim()
        : (starterMsg?.content || post.title || '');
    const cleanStarterQuestion = redactParticipantNames(
      String(rawStarterQuestion)
        .replace(/^\[Forum Post:\s*"[^"]*"\]\s*/i, '')
        .trim(),
      knownAuthors
    ).slice(0, msgCap);
    const cleanPostTitle =
      redactParticipantNames(post.title || 'Untitled', knownAuthors) || 'Untitled';

    const confirmed = isForumPostConfirmed(post, starterMsg, replyMessages, postAuthor);
    const answered =
      typeof post.answered === 'boolean'
        ? post.answered
        : Boolean(
            confirmed ||
              determineForumPostAnswered(
                hasStarter ? post : { ...post, _missingStarter: true, author: postAuthor },
                postMessages
              )
          );
    const statusLabel = confirmed
      ? 'Confirmed Resolution (verified by author or solved tag)'
      : answered
        ? 'Answered (Heuristic — guidance reply provided, unconfirmed by author)'
        : 'Unanswered';

    const postTags = resolveForumAppliedTagNames(post);
    const tagsSuffix = postTags.length > 0 ? ` | Tags: ${postTags.join(', ')}` : '';

    const replyCount =
      typeof post.replyCount === 'number' ? post.replyCount : replyMessages.length;
    const partSuffix =
      post.partCount && post.partCount > 1
        ? ` [Part ${post.partIndex || 1}/${post.partCount}]`
        : '';

    const createdDate = post.createdAt
      ? new Date(post.createdAt)
      : hasStarter && starterMsg?.timestamp
        ? new Date(starterMsg.timestamp)
        : null;
    const createdStr =
      createdDate && !Number.isNaN(createdDate.getTime())
        ? `${createdDate.toISOString().replace('T', ' ').slice(0, 16)} UTC`
        : 'Unknown Date';

    let starterLine;
    if (!hasStarter) {
      starterLine = `Starter Question (original starter message deleted; inferred from thread title): ${cleanStarterQuestion}`;
    } else if (starterMsg?.contextOnly) {
      const note =
        post.partIndex && post.partIndex > 1
          ? 'thread starter context from Part 1; excluded from part message count'
          : 'created prior to lookback window — retained for question context only, excluded from window message counts';
      starterLine = `Starter Question (${note}): [${createdStr}] ${cleanStarterQuestion}`;
    } else {
      starterLine = `Starter Question: [${createdStr}] ${cleanStarterQuestion}`;
    }

    const replyLines = [];
    if (replyMessages.length === 0) {
      replyLines.push('  - (No replies in this window)');
    } else {
      for (const reply of replyMessages) {
        const ts =
          reply.timestamp instanceof Date ? reply.timestamp : new Date(reply.timestamp);
        const timeStr = !Number.isNaN(ts.getTime())
          ? `${ts.toISOString().replace('T', ' ').slice(0, 16)} UTC`
          : 'Unknown Time';
        const content = redactParticipantNames(String(reply.content || ''), knownAuthors).slice(
          0,
          msgCap
        );
        const attachmentSuffix =
          reply.attachments &&
          reply.attachments.length > 0 &&
          !content.startsWith('[Attached:')
            ? ` [Attachments: ${reply.attachments.join(', ')}]`
            : '';
        replyLines.push(`  - [${timeStr}] ${content}${attachmentSuffix}`);
      }
    }

    const block = [
      `=== Forum Post #${idx + 1}: "${cleanPostTitle}" (ID: ${post.postId || post.id || idx + 1})${partSuffix} ===`,
      `Created: ${createdStr} | Total Replies: ${replyCount}${tagsSuffix} | Status: ${statusLabel}`,
      starterLine,
      'Replies:',
      ...replyLines,
    ].join('\n');

    if (blocks.length > 0 && totalChars + block.length > charBudget) {
      blocks.push('...[additional forum posts truncated to stay within prompt character budget]');
      break;
    }

    const clampedBlock =
      block.length > charBudget
        ? `${block.slice(0, charBudget)}\n...[post truncated at prompt character budget]`
        : block;
    blocks.push(clampedBlock);
    totalChars += clampedBlock.length + 2;
  }

  return blocks.join('\n\n');
}

/**
 * Generates a deterministic local fallback summary tailored to either:
 * - `'forum'` / `'qa'` channels (frequent questions, common doubts, answers, unresolved items)
 * - `'chat'` channels (main discussion topics, top keywords with counts, highlights)
 *
 * @param {Array<object>} messages - Normalized messages
 * @param {object} stats - Output from buildTranscriptAndStats().stats
 * @param {object} [options]
 * @param {'chat'|'qa'|'forum'} [options.channelType='chat']
 * @param {Array<object>} [options.posts=[]]
 * @returns {string} Formatted Markdown summary
 */
export function generateLocalFallbackSummary(
  messages,
  stats,
  { channelType = 'chat', posts = [], extraAuthors = [] } = {}
) {
  const windowMessages = (messages || []).filter((m) => m && !m.contextOnly);
  const hasForumPosts = Array.isArray(posts) && posts.length > 0;

  if (windowMessages.length === 0 && !hasForumPosts) {
    return 'No messages found in the selected time window.';
  }

  const effectiveStats =
    stats && typeof stats.totalMessages === 'number'
      ? stats
      : buildTranscriptAndStats(windowMessages).stats;

  const topKeywords = extractTopKeywords(windowMessages, { limit: 10, extraAuthors });
  const keywordBadges = topKeywords.map(
    (k) => `\`${k.word}\` (${k.count} in ${k.messageCount} ${k.messageCount === 1 ? 'msg' : 'msgs'})`
  );
  const knownAuthors = collectKnownAuthors(windowMessages, posts, [
    ...(effectiveStats.participants || []),
    ...extraAuthors,
  ]);

  if (channelType === 'forum' || channelType === 'qa') {
    const qaData = extractQuestionsAndDoubts(windowMessages, posts, { extraAuthors });
    const frequentDoubtsLines =
      qaData.questions.length > 0
        ? qaData.questions.slice(0, 4).map((q) => {
            const statusBadge = q.confirmed
              ? `[Confirmed Resolution • ${q.replyCount} ${q.replyCount === 1 ? 'reply' : 'replies'}]`
              : q.answered
                ? `[Answered (Heuristic / Unconfirmed) • ${q.replyCount} ${q.replyCount === 1 ? 'reply' : 'replies'}]`
                : `[Unanswered${q.replyCount > 0 ? ` • ${q.replyCount} ${q.replyCount === 1 ? 'reply' : 'replies'}` : ''}]`;
            const contextNote = q.starterContextOnly
              ? ' *(starter created prior to window; context only)*'
              : q.missingStarter
                ? ' *(original starter message deleted)*'
                : '';
            const cleanQ = clipTextCleanly(q.question, 140);
            const replyLabel = q.confirmed
              ? 'Confirmed Solution/Reply'
              : 'Suggested Answer/Reply (Unconfirmed)';
            return `- **${q.title}** ${statusBadge}${contextNote}\n  - *Doubt*: "${cleanQ}"${q.answerPreview ? `\n  - *${replyLabel}*: ${clipTextCleanly(q.answerPreview, 140)}` : ''}`;
          })
        : ['- No explicit questions detected in this window.'];

    const answeredQuestions = qaData.questions.filter((q) => q.answered && q.answerPreview);
    const solutionLines =
      answeredQuestions.length > 0
        ? answeredQuestions.slice(0, 4).map((q) => {
            const tag = q.confirmed
              ? '**[Confirmed Resolution]**'
              : '**[Suggested Answer / Unconfirmed Reply (Heuristic)]**';
            return `- ${tag} **${q.title}** — ${clipTextCleanly(q.answerPreview, 140)}`;
          })
        : ['- No confirmed solutions or candidate answer replies recorded in this window.'];

    const unansweredLines = qaData.questions
      .filter((q) => !q.answered)
      .slice(0, 4)
      .map((q) => `- "${q.title}"`);

    const qKeywords =
      qaData.questionKeywords && qaData.questionKeywords.length > 0
        ? qaData.questionKeywords.map((k) => `\`${k.word}\` (${k.count})`)
        : keywordBadges;

    const contextNotes = [];
    if (qaData.outOfWindowStarterCount > 0) {
      contextNotes.push(
        `${qaData.outOfWindowStarterCount} post starter(s) created before the lookback window (retained as question context only, excluded from in-window message counts)`
      );
    }
    if (qaData.missingStarterCount > 0) {
      contextNotes.push(
        `${qaData.missingStarterCount} post(s) had a deleted/missing starter message`
      );
    }

    const lines = [
      '**Support & Q&A Overview**',
      `Analyzed **${effectiveStats.totalMessages}** in-window messages across **${effectiveStats.participants.length}** participants (` +
        `**${qaData.totalQuestions}** questions/posts: **${qaData.confirmedCount}** confirmed resolved, **${qaData.heuristicAnsweredCount}** with heuristic/unconfirmed answer replies, **${qaData.unansweredCount}** unanswered).` +
        (contextNotes.length > 0 ? ` Note: ${contextNotes.join('; ')}.` : ''),
      '',
      '**Most Frequent Questions & Common Doubts (FAQ)**',
      ...frequentDoubtsLines,
      '',
      '**Confirmed Solutions & Answers Provided**',
      ...solutionLines,
      '',
      '**Top Keywords in Questions**',
      qKeywords.length > 0
        ? `- Most repeated terms in doubts: ${qKeywords.join(', ')}`
        : '- No dominant technical keywords detected.',
      '',
      '**Unanswered Questions & Pending Issues**',
      ...(unansweredLines.length > 0
        ? unansweredLines
        : ['- All recorded questions received at least one candidate answer reply.']),
      '',
      '_Note: Generated using the built-in local analyzer (configure `DEEPSEEK_API_KEY` in `.env` for AI-powered abstractive summaries)._',
    ];

    return enforceConciseDigest(lines.join('\n'), { knownAuthors });
  }

  // Normal / General Chat channel summary (topics + top keywords, without participant names)
  const highlights = [];
  for (const msg of windowMessages) {
    const text = redactParticipantNames(String(msg.content || '').trim(), knownAuthors);
    if (text.length >= 20 && highlights.length < 4) {
      highlights.push(`- ${clipTextCleanly(text, 160)}`);
    }
  }

  const lines = [
    '**Overview**',
    `Captured **${effectiveStats.totalMessages}** in-window messages across **${effectiveStats.participants.length}** participants.`,
    '',
    '**Main Discussion Topics & Highlights**',
    ...(highlights.length > 0
      ? highlights
      : ['- Casual conversation with short messages.']),
    '',
    '**Most Used Keywords (Word Frequency)**',
    keywordBadges.length > 0
      ? `- Top keywords: ${keywordBadges.join(', ')}`
      : '- General conversation without repeated keywords.',
    '',
    '_Note: Generated using the built-in local analyzer (configure `DEEPSEEK_API_KEY` in `.env` for AI-powered abstractive summaries)._',
  ];

  return enforceConciseDigest(lines.join('\n'), { knownAuthors });
}

/**
 * Checks whether a remote/Ollama LLM configuration has a supported provider and valid credentials.
 *
 * @param {object} [llmConfig]
 * @returns {boolean}
 */
export function isRemoteLLMConfigured(llmConfig = config.llm) {
  if (!llmConfig || typeof llmConfig !== 'object') return false;
  const provider = String(llmConfig.provider || '').toLowerCase();
  const baseUrl = String(llmConfig.baseUrl || '');
  const apiKey = String(llmConfig.apiKey || '').trim();
  const isLocalOllama =
    baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');
  const placeholderKeys = new Set(['your_deepseek_api_key_here', 'your_openai_api_key_here']);
  const hasValidApiKey = Boolean(apiKey) && !placeholderKeys.has(apiKey);
  const supportedRemoteProviders = new Set(['deepseek', 'openai']);
  return supportedRemoteProviders.has(provider) && (hasValidApiKey || isLocalOllama);
}

/**
 * Calls an OpenAI-compatible Chat Completions endpoint (DeepSeek, OpenAI, Ollama, Groq, etc.).
 *
 * @param {string} transcript - Formatted chat transcript
 * @param {object} options
 * @param {string} [options.channelName] - Name of the Discord channel
 * @param {string} [options.topicFilter] - Optional topic focus
 * @param {object} [options.llmConfig] - Override LLM configuration
 * @param {Function} [options.fetchImpl] - Custom fetch implementation for testing
 * @returns {Promise<string>} Summary markdown
 */
export async function callOpenAICompatibleLLM(
  transcript,
  {
    channelName = 'general',
    topicFilter = '',
    systemPrompt = SYSTEM_PROMPT,
    customUserPrompt = '',
    maxPromptChars = 24000,
    llmConfig = config.llm,
    fetchImpl = globalThis.fetch,
  } = {}
) {
  if (!isRemoteLLMConfigured(llmConfig)) {
    throw new Error('Remote LLM provider or API key is not configured.');
  }

  const endpoint = `${llmConfig.baseUrl}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
  };

  if (llmConfig.apiKey) {
    headers.Authorization = `Bearer ${llmConfig.apiKey}`;
  }

  const focusInstruction = topicFilter
    ? `\nPay special attention to discussions related to "${topicFilter}".`
    : '';

  const charLimit = Math.max(1000, maxPromptChars);
  const rawUserPrompt =
    customUserPrompt || `Channel: #${channelName}${focusInstruction}\n\nTranscript:\n${transcript}`;
  const userPrompt =
    rawUserPrompt.length > charLimit
      ? `${rawUserPrompt.slice(0, charLimit)}\n...[prompt truncated at context budget]`
      : rawUserPrompt;

  const sendRequest = (modelName) =>
    fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelName,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

  let response = await sendRequest(llmConfig.model);

  // If using DeepSeek API with "deepseek-flash" and the official endpoint expects "deepseek-chat", retry seamlessly
  if (
    !response.ok &&
    (response.status === 400 || response.status === 404) &&
    llmConfig.model === 'deepseek-flash'
  ) {
    response = await sendRequest('deepseek-chat');
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`LLM API responded with status ${response.status}: ${errorBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('LLM API returned an empty summary response.');
  }

  return content;
}

export const DIGEST_RECOMPRESSION_SYSTEM_PROMPT = `You are a senior technical editor.
The provided channel digest draft exceeds the presentation budget (either over 2,000 characters total or containing an individual topic over 450 characters / 2 bullets).
Rewrite and compress it in English so the entire digest is between 1,200 and 1,800 characters total and every individual topic is within 250–400 characters while preserving all distinct topics, confirmed vs. heuristic/unconfirmed resolution statuses, key facts, final decisions, open uncertainties, and exact keyword counts.

Rules:
- Keep every topic block to at most 2 concise bullets and 250–400 characters (<= 450 characters maximum), synthesizing key decisions and open questions from the end of long topics rather than dropping them.
- Preserve existing section headings, Markdown tables, and code fences intact.
- Include NO person names at all (including participants, staff, or people mentioned), usernames, or @handles; refer to people generically.
- Do not invent facts or drop core topics when they can be expressed more concisely.`;

/**
 * When an LLM-generated channel digest exceeds `maxTotalChars` or contains any individual topic
 * block exceeding `maxTopicChars` / `maxBulletsPerTopic`, and a valid remote LLM provider/key
 * is configured, asks the LLM once to recompress it in a content-aware manner (preserving all
 * topics and end-of-topic decisions concisely) before applying `enforceConciseDigest` as a
 * deterministic safety net.
 *
 * @param {string} rawSummary
 * @param {object} [options]
 * @returns {Promise<string>}
 */
export async function compressOversizedDigestWithLLM(
  rawSummary,
  {
    channelName = 'general',
    knownAuthors = [],
    maxTopicChars = DEFAULT_MAX_TOPIC_CHARS,
    maxBulletsPerTopic = DEFAULT_MAX_BULLETS_PER_TOPIC,
    maxTotalChars = DEFAULT_MAX_DIGEST_CHARS,
    maxPromptChars = 24000,
    llmConfig = config.llm,
    fetchImpl = globalThis.fetch,
  } = {}
) {
  const sanitized = redactParticipantNames(String(rawSummary || ''), knownAuthors);
  if (!sanitized) return '';

  const needsCompression = !isDigestWithinBudget(sanitized, {
    maxTopicChars,
    maxBulletsPerTopic,
    maxTotalChars,
  });

  if (needsCompression && isRemoteLLMConfigured(llmConfig)) {
    try {
      const safeChannel = String(channelName || 'general').slice(0, 120);
      const recompressed = await callOpenAICompatibleLLM(sanitized, {
        channelName: safeChannel,
        systemPrompt: DIGEST_RECOMPRESSION_SYSTEM_PROMPT,
        customUserPrompt: `Channel: #${safeChannel}\nCompress the following channel digest so the entire output stays under ${Math.max(1200, maxTotalChars - 150)} characters total (at most ${maxBulletsPerTopic} bullets and <= ${maxTopicChars} characters per topic, preserving all distinct topics, final decisions, open questions, and exact metrics, with no person names at all):\n\n${sanitized}`,
        maxPromptChars,
        llmConfig,
        fetchImpl,
      });
      if (recompressed && recompressed.trim()) {
        return enforceConciseDigest(recompressed, {
          maxTopicChars,
          maxBulletsPerTopic,
          maxTotalChars,
          knownAuthors,
        });
      }
    } catch {
      // Fall through to deterministic bounding safety net
    }
  }

  return enforceConciseDigest(sanitized, {
    maxTopicChars,
    maxBulletsPerTopic,
    maxTotalChars,
    knownAuthors,
  });
}

/**
 * High-level function to summarize an array of normalized Discord messages or Forum posts.
 *
 * @param {Array<object>} messages - Normalized messages
 * @param {object} options
 * @param {string} [options.channelName]
 * @param {'chat'|'qa'|'forum'} [options.channelType='chat']
 * @param {Array<object>} [options.posts=[]]
 * @param {string} [options.topicFilter]
 * @param {number} [options.maxPromptChars=24000]
 * @param {object} [options.llmConfig]
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<{ summary: string, stats: object, topKeywords: Array<object>, qaStats: object|null, providerUsed: string }>}
 */
export async function summarizeMessages(
  messages,
  {
    channelName = 'general',
    channelType = 'chat',
    posts = [],
    topicFilter = '',
    maxPromptChars = 24000,
    llmConfig = config.llm,
    fetchImpl = globalThis.fetch,
    extraAuthors = [],
  } = {}
) {
  const safePosts = Array.isArray(posts) ? posts : [];
  const directWindowMessages = (messages || []).filter((m) => m && !m.contextOnly);
  const windowMessages =
    directWindowMessages.length > 0 || safePosts.length === 0
      ? directWindowMessages
      : safePosts.flatMap((p) => (p.messages || []).filter((m) => m && !m.contextOnly));

  const knownAuthors = collectKnownAuthors(messages, safePosts, extraAuthors);
  const { transcript, stats } = buildTranscriptAndStats(windowMessages, {
    includeAuthors: false,
    contentFormatter: (txt) => redactParticipantNames(txt, knownAuthors),
  });
  const topKeywords = extractTopKeywords(windowMessages, { limit: 10, extraAuthors: knownAuthors });
  const qaStats =
    channelType === 'forum' || channelType === 'qa'
      ? extractQuestionsAndDoubts(windowMessages, safePosts, { extraAuthors: knownAuthors })
      : null;

  if (windowMessages.length === 0 && safePosts.length === 0) {
    return {
      summary: 'No user messages were found in the specified time range.',
      stats,
      topKeywords,
      qaStats,
      providerUsed: 'none',
    };
  }

  const shouldUseLLM = isRemoteLLMConfigured(llmConfig);

  const selectedSystemPrompt =
    channelType === 'forum' || channelType === 'qa'
      ? QA_SYSTEM_PROMPT
      : GENERAL_CHAT_SYSTEM_PROMPT;

  const isStructuredForum = channelType === 'forum' && safePosts.length > 0;
  const transcriptHeading = isStructuredForum
    ? 'Structured Forum Posts (Question + Replies Units):'
    : 'Transcript:';

  const maxHeaderBudget = Math.min(2200, Math.max(400, Math.floor(maxPromptChars * 0.15)));
  const headingSuffix = `\n\n${transcriptHeading}\n`;
  const maxPrefixWithoutHeading = Math.max(200, maxHeaderBudget - headingSuffix.length);

  const safeChannelName = String(channelName || 'general').slice(0, 120);
  const countDescription =
    stats.totalMessages === 0 && windowMessages.length > 0
      ? `${windowMessages.length} continuation message part(s)`
      : `${stats.totalMessages} in-window messages, ${stats.participants.length} participants`;

  const qaContext =
    qaStats && qaStats.totalQuestions > 0
      ? `\nChannel Type: ${channelType.toUpperCase()} (${qaStats.totalQuestions} questions/posts: ${qaStats.confirmedCount} confirmed resolved, ${qaStats.heuristicAnsweredCount} with heuristic/unconfirmed answer replies, ${qaStats.unansweredCount} unanswered` +
        (qaStats.outOfWindowStarterCount > 0
          ? `, ${qaStats.outOfWindowStarterCount} out-of-window starter context`
          : '') +
        (qaStats.missingStarterCount > 0
          ? `, ${qaStats.missingStarterCount} missing starter`
          : '') +
        ')'
      : `\nChannel Type: ${channelType.toUpperCase()}`;

  const maxKeywordContextChars = Math.min(600, Math.max(120, Math.floor(maxPrefixWithoutHeading * 0.45)));
  let keywordContext = '';
  if (topKeywords.length > 0) {
    const kwItems = [];
    let kwLen = 52;
    const knownAuthorLowerSet = new Set(knownAuthors.map((a) => a.toLowerCase()));
    for (const k of topKeywords) {
      const wordLower = String(k.word || '').toLowerCase();
      const safeWord = knownAuthorLowerSet.has(wordLower)
        ? 'a user'
        : redactParticipantNames(String(k.word || '').slice(0, 30), knownAuthors);
      const entry = `${safeWord} (${k.count} occurrences across ${k.messageCount} ${k.messageCount === 1 ? 'message' : 'messages'})`;
      if (kwItems.length > 0 && kwLen + entry.length + 2 > maxKeywordContextChars) {
        break;
      }
      kwItems.push(entry);
      kwLen += entry.length + 2;
    }
    if (kwItems.length > 0) {
      keywordContext = `\nTop Measured Keywords (exact in-window frequency): ${kwItems.join(', ')}`;
    }
  }

  const focusInstruction = topicFilter
    ? `\nPay special attention to discussions related to "${String(topicFilter).slice(0, 160)}".`
    : '';

  const rawBaseHeaderPrefix = `Channel: #${safeChannelName} (${countDescription})${qaContext}${keywordContext}${focusInstruction}`;
  const baseHeaderPrefix =
    rawBaseHeaderPrefix.length > maxPrefixWithoutHeading
      ? rawBaseHeaderPrefix.slice(0, maxPrefixWithoutHeading)
      : rawBaseHeaderPrefix;

  let extractedQaDigestBlock = '';
  if (channelType === 'qa' && !isStructuredForum && qaStats && qaStats.questions.length > 0) {
    const maxQaDigestChars = Math.min(
      1400,
      maxPrefixWithoutHeading - baseHeaderPrefix.length
    );
    if (maxQaDigestChars > 120) {
      const qLines = [];
      let usedQaChars = 40;
      for (let idx = 0; idx < Math.min(qaStats.questions.length, 15); idx++) {
        const q = qaStats.questions[idx];
        const status = q.confirmed
          ? 'Confirmed Resolution'
          : q.answered
            ? 'Answered (Heuristic / Unconfirmed Reply)'
            : 'Unanswered';
        // Defensive second pass: nothing identity-bearing may reach the LLM prompt
        const qPreview = clipTextCleanly(
          redactParticipantNames(String(q.question || ''), knownAuthors),
          140
        );
        const aPreview = q.answerPreview
          ? ` -> Reply: ${clipTextCleanly(redactParticipantNames(String(q.answerPreview), knownAuthors), 140)}`
          : '';
        const line = `  ${idx + 1}. [${status}] "${qPreview}"${aPreview}`;
        if (usedQaChars + line.length + 1 > maxQaDigestChars) {
          break;
        }
        qLines.push(line);
        usedQaChars += line.length + 1;
      }
      if (qLines.length > 0) {
        extractedQaDigestBlock = `\nExtracted Question & Reply Pairs:\n${qLines.join('\n')}\n`;
      }
    }
  }

  const promptPrefix = `${baseHeaderPrefix}${extractedQaDigestBlock}${headingSuffix}`;
  const availableTranscriptChars = Math.max(400, maxPromptChars - promptPrefix.length);

  const effectiveTranscript = isStructuredForum
    ? buildForumTranscript(safePosts, windowMessages, {
        maxPromptChars: availableTranscriptChars,
        extraAuthors: knownAuthors,
      })
    : transcript.length > availableTranscriptChars
      ? `${transcript.slice(0, Math.max(200, availableTranscriptChars - 50))}\n...[transcript truncated at context budget]`
      : transcript;

  if (shouldUseLLM) {
    try {
      const customUserPrompt = `${promptPrefix}${effectiveTranscript}`;
      const rawSummary = await callOpenAICompatibleLLM(effectiveTranscript, {
        channelName,
        topicFilter,
        systemPrompt: selectedSystemPrompt,
        customUserPrompt,
        maxPromptChars,
        llmConfig,
        fetchImpl,
      });
      const summary = redactParticipantNames(rawSummary, knownAuthors);
      return {
        summary,
        stats,
        topKeywords,
        qaStats,
        providerUsed: `${llmConfig.provider} (${llmConfig.model})`,
      };
    } catch (error) {
      console.warn(`[Summarizer] LLM call failed (${error.message}). Falling back to local analyzer.`);
      const fallback = generateLocalFallbackSummary(windowMessages, stats, {
        channelType,
        posts: safePosts,
        extraAuthors: knownAuthors,
      });
      return {
        summary: fallback,
        stats,
        topKeywords,
        qaStats,
        providerUsed: 'local-fallback (after LLM error)',
      };
    }
  }

  return {
    summary: generateLocalFallbackSummary(windowMessages, stats, {
      channelType,
      posts: safePosts,
      extraAuthors: knownAuthors,
    }),
    stats,
    topKeywords,
    qaStats,
    providerUsed: 'local-fallback',
  };
}
