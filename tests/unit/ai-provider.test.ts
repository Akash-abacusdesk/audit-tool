import { describe, expect, it, vi } from 'vitest';
import { AnthropicRemediationProvider, redactForProvider } from '@platform/shared';

const input = {
  findingId: '11111111-1111-4111-8111-111111111111',
  findingSummary: 'Hardcoded secret in src/config.js',
  codeContext: 'const key = "ghp_1234567890123456789012345678901234";',
};

function provider(fetchImpl: typeof fetch) {
  return new AnthropicRemediationProvider({
    apiKey: 'test-key',
    model: 'claude-x',
    allowedModels: ['claude-x'],
    fetchImpl,
  });
}

describe('redactForProvider', () => {
  it('redacts known secret patterns and long opaque tokens', () => {
    const out = redactForProvider('token=ghp_1234567890123456789012345678901234 plain=hello');
    expect(out).not.toContain('ghp_');
    expect(out).toContain('plain=hello');
  });
});

describe('AnthropicRemediationProvider', () => {
  it('refuses construction with a model outside the allow-list', () => {
    expect(() => new AnthropicRemediationProvider({ apiKey: 'k', model: 'not-allowed', allowedModels: ['claude-x'] })).toThrow(
      /not in the allowed-model list/
    );
  });

  it('sends the auth header, system prompt, and redacted context', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('claude-x');
      expect(body.messages[0].content).not.toContain('ghp_1234567890123456789012345678901234');
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'PATCH:\n--- a\n+++ b\n\nEXPLANATION:\nFix.\n\nTEST GUIDANCE:\nRun tests.' }] }),
        { status: 200 }
      );
    });
    const result = await provider(fetchImpl as unknown as typeof fetch).generatePatch(input);
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-x');
    expect(result.patch).toContain('--- a');
    expect(result.explanation).toBe('Fix.');
    expect(result.testGuidance).toBe('Run tests.');
  });

  it('throws UNAVAILABLE on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }));
    await expect(provider(fetchImpl as unknown as typeof fetch).generatePatch(input)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });

  it('throws UNAVAILABLE on a network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    });
    await expect(provider(fetchImpl as unknown as typeof fetch).generatePatch(input)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
});
