import type { DSHCredentials } from '@src/dsh/credentials';

const defaultBaseUrl = 'https://api.deepseek.com';

const modelListUrl = (baseUrl?: string): string => `${(baseUrl || defaultBaseUrl).replace(/\/+$/, '')}/models`;

export const listAvailableModels = async (credentials: DSHCredentials): Promise<string[]> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  timeout.unref();

  try {
    const response = await fetch(modelListUrl(credentials.baseUrl), {
      headers: { Authorization: `Bearer ${credentials.apiKey}` },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error('model list request failed');
    }

    const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = payload.data?.map(item => (typeof item.id === 'string' ? item.id.trim() : '')).filter(Boolean) ?? [];

    if (models.length === 0) {
      throw new Error('model list is empty');
    }

    return [...new Set(models)].sort((left, right) => left.localeCompare(right));
  } finally {
    clearTimeout(timeout);
  }
};
