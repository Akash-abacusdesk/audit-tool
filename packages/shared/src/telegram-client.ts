/**
 * Section-9 Telegram operations — OUTBOUND client (PRD §2.1.6, §14): "Telegram
 * provides alerts, approvals, reminders, and request initiation." Everything
 * else in telegram.ts is the INBOUND side (verifying callbacks FROM Telegram);
 * this is the only thing in the platform allowed to call OUT to the Telegram
 * Bot API to send an alert/approval prompt/reminder.
 *
 * Telegram alone never authorizes a final production break-glass override
 * (PRD §14.1) — this client only sends messages, it grants nothing.
 */
import { ApiError } from './errors.js';

export interface TelegramClientConfig {
  /** Bot token from @BotFather. Never logged; treat as a secret. */
  botToken: string;
  /** Telegram Bot API base URL. Override only for testing against a stub. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface SendMessageOptions {
  /** Telegram parse mode; omit for plain text. */
  parseMode?: 'MarkdownV2' | 'HTML';
  /** Inline keyboard buttons, one row per array — e.g. approve/reject. */
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>;
  /** Suppress the link-preview card for URLs in the message. */
  disableWebPagePreview?: boolean;
}

export interface TelegramSendResult {
  ok: true;
  messageId: number;
}

/**
 * Thin client over the Telegram Bot API's `sendMessage` call. No retry/outbox
 * logic here by design — that's a durability concern for the caller (the
 * PRD's `notification_outbox`/`notification_delivery_attempts` tables are not
 * yet implemented; this client is the delivery primitive they would wrap).
 */
export class TelegramClient {
  constructor(private readonly config: TelegramClientConfig) {}

  async sendMessage(chatId: string | number, text: string, opts?: SendMessageOptions): Promise<TelegramSendResult> {
    const f = this.config.fetchImpl ?? fetch;
    const base = this.config.baseUrl ?? 'https://api.telegram.org';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10_000);

    let res: Response;
    try {
      res = await f(`${base}/bot${this.config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: opts?.parseMode,
          disable_web_page_preview: opts?.disableWebPagePreview,
          reply_markup: opts?.inlineKeyboard ? { inline_keyboard: opts.inlineKeyboard } : undefined,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ApiError('UNAVAILABLE', `telegram sendMessage unreachable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
    }

    const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string; result?: { message_id?: number } } | null;
    if (!res.ok || !body?.ok) {
      throw new ApiError('UNAVAILABLE', `telegram sendMessage failed: ${body?.description ?? res.status}`);
    }
    return { ok: true, messageId: body.result?.message_id ?? 0 };
  }
}
