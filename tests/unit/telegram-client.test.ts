import { describe, expect, it, vi } from 'vitest';
import { TelegramClient } from '@platform/shared';

function client(fetchImpl: typeof fetch) {
  return new TelegramClient({ botToken: 'test-token', fetchImpl });
}

describe('TelegramClient (outbound alerts/approvals/reminders)', () => {
  it('POSTs to the bot sendMessage endpoint with the token in the path', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
      const body = JSON.parse(init.body as string);
      expect(body.chat_id).toBe('123');
      expect(body.text).toBe('hello');
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    });
    const result = await client(fetchImpl as unknown as typeof fetch).sendMessage('123', 'hello');
    expect(result).toEqual({ ok: true, messageId: 42 });
  });

  it('includes an inline keyboard when provided (approve/reject buttons)', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.reply_markup.inline_keyboard).toEqual([[{ text: 'Approve', callback_data: 'deploy_approve:1' }]]);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    await client(fetchImpl as unknown as typeof fetch).sendMessage('123', 'approve?', {
      inlineKeyboard: [[{ text: 'Approve', callback_data: 'deploy_approve:1' }]],
    });
  });

  it('throws UNAVAILABLE when Telegram reports ok:false', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 }));
    await expect(client(fetchImpl as unknown as typeof fetch).sendMessage('bad', 'hi')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });

  it('throws UNAVAILABLE on a network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    });
    await expect(client(fetchImpl as unknown as typeof fetch).sendMessage('123', 'hi')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
});
