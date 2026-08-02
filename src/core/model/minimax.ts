export const MINIMAX_PROVIDER = 'minimax' as const;
export const MINIMAX_DEFAULT_MODEL = 'MiniMax-M3';

export const MINIMAX_MODELS = [
  {
    model_id: 'MiniMax-M3',
    context_window: 1_000_000,
    pricing_usd_per_million_tokens: { input: 0.6, output: 2.4, cache_read: 0.12, cache_write: null },
    input_modalities: ['text', 'image', 'video'],
    thinking: ['adaptive', 'disabled'],
  },
  {
    model_id: 'MiniMax-M2.7',
    context_window: 204_800,
    pricing_usd_per_million_tokens: { input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0.375 },
    input_modalities: ['text'],
    thinking: ['always_on'],
  },
] as const;

export const MINIMAX_ENDPOINTS = {
  global_en: {
    openai_base_url: 'https://api.minimax.io/v1',
    anthropic_base_url: 'https://api.minimax.io/anthropic',
    docs_root: 'https://platform.minimax.io/docs',
  },
  cn_zh: {
    openai_base_url: 'https://api.minimaxi.com/v1',
    anthropic_base_url: 'https://api.minimaxi.com/anthropic',
    docs_root: 'https://platform.minimaxi.com/docs',
  },
} as const;

export type MiniMaxRegion = keyof typeof MINIMAX_ENDPOINTS;

const MINIMAX_MODEL_IDS = new Set<string>(MINIMAX_MODELS.map((model) => model.model_id));

export function miniMaxModelId(value: unknown): string {
  return typeof value === 'string' && MINIMAX_MODEL_IDS.has(value)
    ? value
    : MINIMAX_DEFAULT_MODEL;
}

export function miniMaxOpenAiBaseUrl(options: Record<string, unknown> = {}, explicitBaseUrl?: string): string {
  if (explicitBaseUrl) return explicitBaseUrl;
  const region = miniMaxRegion(options.region);
  const configured = region === 'cn_zh' ? options.cn_openai_base_url : options.openai_base_url;
  return typeof configured === 'string' && configured.trim()
    ? configured.trim()
    : MINIMAX_ENDPOINTS[region].openai_base_url;
}

export function miniMaxRegion(value: unknown): MiniMaxRegion {
  return value === 'cn_zh' ? 'cn_zh' : 'global_en';
}
