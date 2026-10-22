// Каталог бесплатных провайдеров (OpenAI-совместимые API).
// Один источник правды: используется и сервером (/api/providers), и доками.
//
// Идея навеяана FreeLLMAPI (https://github.com/tashfeenahmed/freellmapi) —
// агрегатором бесплатных тарифов LLM-провайдеров (~7.4 млрд токенов/мес).
// Здесь — лёгкая версия: лучшие провайдеры + авто-фейловер на клиенте.

module.exports = [
  {
    id: 'google',
    name: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyless: false,
    free: 'десятки запросов/день на Flash, контекст до 1M',
    note: 'Самый сильный бесплатный тариф: свежие Gemini Flash без карты, ключ за пару кликов по Google-аккаунту.',
    picks: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'],
    filter: /embed|aqa|imagen|veo|tts|live|image|video|gemma|learnlm/i,
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    keyless: false,
    free: '~30 запросов/мин, тысячи запросов/день',
    note: 'Самая быстрая инференс-платформа: GPT-OSS, Llama, Qwen, Kimi на спецуровнях.',
    picks: ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-thinking', 'moonshotai/kimi-k2-instruct', 'qwen/qwen3-32b', 'llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    filter: /whisper|tts|guard|embed/i,
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyUrl: 'https://cloud.cerebras.ai',
    keyless: false,
    free: '~30 запросов/мин, 60k токенов/мин',
    note: 'Вейферы Cerebras — ответы стримятся быстрее, чем успеваешь читать.',
    picks: ['gpt-oss-120b', 'qwen-3-235b-a22b-instruct', 'qwen-3-32b', 'llama-3.3-70b', 'llama3.1-8b'],
    filter: /embed|rerank|guard/i,
  },
  {
    id: 'mistral',
    name: 'Mistral La Plateforme',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    keyless: false,
    free: '1 запрос/сек, ~1 млрд токенов/мес',
    note: 'Бесплатный тариф официального API Mistral: Mistral Small/Medium, Codestral для кода.',
    picks: ['mistral-medium-latest', 'mistral-small-latest', 'codestral-latest', 'magistral-small-latest'],
    filter: /embed|moderation|ocr|ocr3/i,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (:free)',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyless: false,
    free: '50 запросов/день (до 1000 с пополнением $10)',
    note: 'Сотни моделей с суффиксом :free — DeepSeek, Qwen, GLM, Llama и другие.',
    picks: ['deepseek/deepseek-v4-flash-0731free:free', 'deepseek/deepseek-chat-v3.1:free', 'qwen/qwen3.8-max:free', 'z-ai/glm-5.3:free', 'meta-llama/llama-3.3-70b-instruct:free'],
    onlyFree: true,
    filter: /embed/i,
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyUrl: 'https://build.nvidia.com/explore/discover',
    keyless: false,
    free: 'десятки/сотни запросов в день на модель',
    note: 'Бесплатный доступ к открытым моделям на GPU NVIDIA (DeepSeek, Llama, Qwen).',
    picks: ['deepseek-ai/deepseek-v3.1', 'meta/llama-3.3-70b-instruct', 'qwen/qwen3-coder-480b-a35b-instruct', 'openai/gpt-oss-120b'],
    filter: /embed|rerank|nemo|guard|safety|ocr/i,
  },
  {
    id: 'ovh',
    name: 'OVHcloud AI Endpoints',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    keyUrl: '',
    keyless: true,
    free: 'без ключа, скромные лимиты',
    note: 'Работает сразу, без регистрации — Qwen и другие открытые модели от OVHcloud.',
    picks: ['Qwen3.8-27B', 'Qwen2.5-72B-Instruct', 'qwen3-32b', 'Qwen2.5-Coder-32B-Instruct', 'Meta-Llama-3_3-70B-Instruct'],
    filter: /embed|guard/i,
  },
];

// Порядок провайдеров в авто-цепочке (лучшие — первыми)
module.exports.PRIORITY = ['google', 'groq', 'cerebras', 'mistral', 'openrouter', 'nvidia', 'ovh'];
