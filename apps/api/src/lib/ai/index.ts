import { config } from '@/config';
import { AnthropicProvider } from './anthropic';
import { OpenAICompatibleProvider } from './openai-compatible';
import { NullProvider, type AiProvider } from './provider';

let provider: AiProvider | null = null;

export function aiProvider(): AiProvider {
  if (provider) return provider;
  if (config.AI_PROVIDER === 'anthropic' && config.ANTHROPIC_API_KEY) provider = new AnthropicProvider(config.ANTHROPIC_API_KEY, config.AI_MODEL);
  else if (config.AI_PROVIDER === 'openai_compatible' && config.OPENAI_COMPATIBLE_BASE_URL) provider = new OpenAICompatibleProvider(config.OPENAI_COMPATIBLE_BASE_URL, config.OPENAI_COMPATIBLE_API_KEY, config.AI_MODEL);
  else provider = new NullProvider();
  return provider;
}

export const aiEnabled = () => aiProvider().name !== 'none';
export * from './provider';
