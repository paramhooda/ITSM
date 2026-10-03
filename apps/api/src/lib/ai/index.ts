import { config } from '@/config';
import { AnthropicProvider } from './anthropic';
import { OpenAICompatibleProvider, normaliseBaseUrl } from './openai-compatible';
import { NullProvider, type AiProvider } from './provider';

const OPENAI_DEFAULT_URL = 'https://api.openai.com/v1';
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
const looksLikeClaude = (m: string) => /^claude/i.test(m);
const looksLikeOpenAi = (m: string) => /^(gpt|o\d|chatgpt)/i.test(m);

export interface ResolvedAiConfig {
  provider: 'anthropic' | 'openai_compatible' | 'none';
  model: string;
  baseUrl: string | null;
  hasKey: boolean;
  /** Why this configuration was chosen (shown in the startup log and the admin screen). */
  notes: string[];
}

/**
 * Resolves the effective AI configuration from the environment.
 *
 * AI_PROVIDER is authoritative when set to a provider. When it is unset or
 * "none" but a key is present, the provider is inferred so that the common
 * "I just pasted my OpenAI key" setup works. The model default follows the
 * provider: a Claude id is never sent to OpenAI and vice versa.
 */
export function resolveAiConfig(env: Pick<typeof config, 'AI_PROVIDER' | 'AI_MODEL' | 'ANTHROPIC_API_KEY' | 'OPENAI_COMPATIBLE_BASE_URL' | 'OPENAI_COMPATIBLE_API_KEY' | 'OPENAI_API_KEY' | 'OPENAI_BASE_URL'> = config): ResolvedAiConfig {
  const notes: string[] = [];
  const openaiKey = env.OPENAI_COMPATIBLE_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || '';
  const openaiUrl = env.OPENAI_COMPATIBLE_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim() || '';
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim() || '';
  let provider: ResolvedAiConfig['provider'] = env.AI_PROVIDER;
  if (provider === 'none') {
    if (openaiKey || openaiUrl) {
      provider = 'openai_compatible';
      notes.push('AI_PROVIDER not set; using openai_compatible because an OpenAI key or base URL is present');
    } else if (anthropicKey) {
      provider = 'anthropic';
      notes.push('AI_PROVIDER not set; using anthropic because ANTHROPIC_API_KEY is present');
    }
  }
  const explicitModel = (env.AI_MODEL ?? '').trim();
  const modelIsDefault = !explicitModel || explicitModel === ANTHROPIC_DEFAULT_MODEL;
  if (provider === 'openai_compatible') {
    let baseUrl = openaiUrl;
    if (!baseUrl) {
      if (openaiKey) {
        baseUrl = OPENAI_DEFAULT_URL;
        notes.push(`no base URL set; using ${OPENAI_DEFAULT_URL}`);
      } else {
        return { provider: 'none', model: '', baseUrl: null, hasKey: false, notes: ['openai_compatible selected but OPENAI_COMPATIBLE_BASE_URL (or OPENAI_BASE_URL) is empty'] };
      }
    }
    baseUrl = normaliseBaseUrl(baseUrl);
    const isOpenAi = /api\.openai\.com/i.test(baseUrl);
    let model = explicitModel;
    if (modelIsDefault || (isOpenAi && looksLikeClaude(model))) {
      model = OPENAI_DEFAULT_MODEL;
      notes.push(`AI_MODEL ${explicitModel ? `"${explicitModel}" is not an OpenAI model` : 'not set'}; using ${OPENAI_DEFAULT_MODEL}`);
    }
    if (isOpenAi && !openaiKey) notes.push('api.openai.com requires OPENAI_COMPATIBLE_API_KEY (or OPENAI_API_KEY)');
    return { provider, model, baseUrl, hasKey: !!openaiKey, notes };
  }
  if (provider === 'anthropic') {
    if (!anthropicKey) return { provider: 'none', model: '', baseUrl: null, hasKey: false, notes: ['anthropic selected but ANTHROPIC_API_KEY is empty'] };
    let model = explicitModel || ANTHROPIC_DEFAULT_MODEL;
    if (looksLikeOpenAi(model)) {
      notes.push(`AI_MODEL "${model}" is not a Claude model; using ${ANTHROPIC_DEFAULT_MODEL}`);
      model = ANTHROPIC_DEFAULT_MODEL;
    }
    return { provider, model, baseUrl: 'https://api.anthropic.com', hasKey: true, notes };
  }
  return { provider: 'none', model: '', baseUrl: null, hasKey: false, notes };
}

let provider: AiProvider | null = null;
let resolved: ResolvedAiConfig | null = null;

export function aiConfig(): ResolvedAiConfig {
  if (!resolved) resolved = resolveAiConfig();
  return resolved;
}

export function aiProvider(): AiProvider {
  if (provider) return provider;
  const c = aiConfig();
  if (c.provider === 'anthropic') provider = new AnthropicProvider(config.ANTHROPIC_API_KEY!.trim(), c.model);
  else if (c.provider === 'openai_compatible') provider = new OpenAICompatibleProvider(c.baseUrl!, (config.OPENAI_COMPATIBLE_API_KEY?.trim() || config.OPENAI_API_KEY?.trim()) || undefined, c.model);
  else provider = new NullProvider();
  return provider;
}

export const aiEnabled = () => aiProvider().name !== 'none';
export * from './provider';
