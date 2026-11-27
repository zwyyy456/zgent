import { query, type ModelInfo, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../../policy/config.ts';
import { iso, type Snapshot } from '../../core/values.ts';

export function claudeEnvironment(config: Config) {
  const service = config.claude_sdk;
  if (!service) return;
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH, HOME: service.home, CLAUDE_CONFIG_DIR: service.home,
    LANG: 'en_US.UTF-8', DISABLE_NONESSENTIAL_MODEL_CALLS: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '0',
  };
  if (service.authentication === 'api_key') {
    if (!process.env.ANTHROPIC_API_KEY) return;
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  } else if (service.authentication === 'bedrock') {
    env.CLAUDE_CODE_USE_BEDROCK = '1';
    for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
      'AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN']) env[key] = process.env[key];
  } else {
    env.CLAUDE_CODE_USE_VERTEX = '1';
    for (const key of ['ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'GOOGLE_APPLICATION_CREDENTIALS']) env[key] = process.env[key];
  }
  return env;
}

export const userMessage = (text: string): SDKUserMessage => ({
  type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '',
});

const boundedOptions = (env: NonNullable<ReturnType<typeof claudeEnvironment>>): Options => ({
  env, settingSources: [], strictMcpConfig: true, tools: [], agents: {}, plugins: [],
  mcpServersDelivery: 'initialize', includePartialMessages: true,
});

export function sdkQuery(prompt: AsyncIterable<SDKUserMessage>, options: Options, env: NonNullable<ReturnType<typeof claudeEnvironment>>) {
  return query({ prompt, options: { ...boundedOptions(env), ...options } });
}

export async function claudeCatalog(config: Config, cwd: string) {
  const env = claudeEnvironment(config);
  if (!env) return { status: 'requires_login' as const, reason: 'Configure separate Claude SDK credentials.' };
  const controller = new AbortController();
  const session = sdkQuery((async function* () { await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true })); })(),
    { cwd, abortController: controller, persistSession: false }, env);
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const account = await session.accountInfo();
    if (account.apiProvider === 'firstParty' && !account.apiKeySource && !env.ANTHROPIC_API_KEY) {
      return { status: 'requires_login' as const, reason: 'Configure separate Claude SDK credentials.' };
    }
    const models: ModelInfo[] = await session.supportedModels();
    return { status: 'available' as const, models: models.map(model => ({ id: model.value, label: model.displayName })) };
  } catch {
    return { status: 'unavailable' as const, reason: 'Claude Agent SDK could not initialize.' };
  } finally {
    clearTimeout(timer);
    controller.abort();
    session.close();
  }
}

export function claudeUsage(message: { usage: { input_tokens: number; output_tokens: number;
  cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }; total_cost_usd?: number }): NonNullable<Snapshot['actual_usage']> {
  const usage = message.usage;
  const cached = usage.cache_read_input_tokens ?? 0;
  const input = usage.input_tokens + cached + (usage.cache_creation_input_tokens ?? 0);
  return { as_of: iso(), status: 'reported', source: 'runtime', scope: 'attempt',
    input_tokens: input, output_tokens: usage.output_tokens, cached_input_tokens: cached,
    total_tokens: input + usage.output_tokens,
    ...(Number.isFinite(message.total_cost_usd) && message.total_cost_usd! >= 0
      ? { reported_cost: { amount: message.total_cost_usd!.toFixed(8), currency: 'USD' } } : {}) };
}

export function claudeFailure(error: string | undefined) {
  switch (error) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'verification_required': return 'PROVIDER_AUTH_REQUIRED';
    case 'rate_limit': return 'PROVIDER_RATE_LIMITED';
    case 'overloaded': return 'PROVIDER_UNAVAILABLE';
    case 'model_not_found': return 'MODEL_UNAVAILABLE';
    case 'billing_error':
    case 'account_on_hold': return 'PROVIDER_BILLING_REQUIRED';
    case 'connection_error': return 'PROVIDER_NETWORK_ERROR';
  }
}
