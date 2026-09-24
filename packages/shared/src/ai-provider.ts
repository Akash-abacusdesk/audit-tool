/**
 * Section-20 AI Provider Abstraction (PRD §8.4, §8.5): developer-triggered,
 * finding-scoped synthetic patch generation. Human-triggered only — the
 * platform never autonomously patches production. AI-generated changes never
 * bypass normal PR/security gates (enforced by the caller, not this module:
 * a patch produced here is a proposal for human review, nothing more).
 *
 * Provider selection is policy/configuration driven (PRD §8.5); this module
 * ships the interface plus one reference implementation (Anthropic). Adding
 * OpenAI/Gemini is the same shape again, not a redesign.
 */
import { ApiError } from './errors.js';

export interface AiRemediationInput {
  findingId: string;
  /** Short human-readable finding summary (rule/title/severity) — never the raw secret/evidence. */
  findingSummary: string;
  /** Minimum code context needed to propose a fix — the caller decides how much. */
  codeContext: string;
  stackMetadata?: string;
  projectPolicy?: string;
}

export interface AiRemediationResult {
  patch: string;
  explanation: string;
  testGuidance: string;
  provider: string;
  model: string;
}

export interface AiRemediationProvider {
  generatePatch(input: AiRemediationInput): Promise<AiRemediationResult>;
}

// ---- Redaction (PRD §8.5: "redaction of unrelated secrets") -------------
// Deliberately self-contained (no cross-package dependency) — same intent as
// packages/scanner/src/normalize.ts's redactSecrets, smaller surface here
// since this only guards outbound provider context, not scanner evidence.

const KNOWN_SECRET_RE =
  /(?<![A-Za-z0-9])(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_\-]{35}|glpat-[A-Za-z0-9_\-]{20,})(?![A-Za-z0-9])/gi;
const LONG_TOKEN_RE = /(?<![A-Za-z0-9])([A-Za-z0-9_\-]{24,})(?![A-Za-z0-9])/g;

export function redactForProvider(text: string): string {
  return text.replace(KNOWN_SECRET_RE, (m) => `<redacted:${m.length}>`).replace(LONG_TOKEN_RE, (m) => `<redacted:${m.length}>`);
}

// ---- Anthropic reference implementation ----------------------------------

export interface AnthropicProviderConfig {
  apiKey: string;
  /** Model allow-list (PRD §8.5) — generatePatch refuses any model not in this list. */
  allowedModels: readonly string[];
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT =
  'You are a security remediation assistant. Given a finding and minimal code context, propose the smallest correct patch (unified diff), a short explanation, and test guidance. Never invent context you were not given. Never include secrets or credentials in your response.';

export class AnthropicRemediationProvider implements AiRemediationProvider {
  constructor(private readonly config: AnthropicProviderConfig) {
    if (!config.allowedModels.includes(config.model)) {
      throw new ApiError('VALIDATION_ERROR', `model ${config.model} is not in the allowed-model list`);
    }
  }

  async generatePatch(input: AiRemediationInput): Promise<AiRemediationResult> {
    const f = this.config.fetchImpl ?? fetch;
    const base = this.config.baseUrl ?? 'https://api.anthropic.com';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 60_000);

    const userMessage = [
      `Finding: ${redactForProvider(input.findingSummary)}`,
      input.stackMetadata ? `Stack: ${redactForProvider(input.stackMetadata)}` : null,
      input.projectPolicy ? `Project policy: ${redactForProvider(input.projectPolicy)}` : null,
      `Code context:\n${redactForProvider(input.codeContext)}`,
      '\nRespond with exactly three sections: PATCH (a unified diff), EXPLANATION, TEST GUIDANCE.',
    ]
      .filter(Boolean)
      .join('\n\n');

    let res: Response;
    try {
      res = await f(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens ?? 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ApiError('UNAVAILABLE', `AI provider unreachable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
    }

    const body = (await res.json().catch(() => null)) as
      | { content?: Array<{ type: string; text?: string }>; error?: { message?: string } }
      | null;
    if (!res.ok) {
      throw new ApiError('UNAVAILABLE', `AI provider request failed: ${body?.error?.message ?? res.status}`);
    }
    const text = body?.content?.find((c) => c.type === 'text')?.text ?? '';
    return { ...parseSections(text), provider: 'anthropic', model: this.config.model };
  }
}

function parseSections(text: string): { patch: string; explanation: string; testGuidance: string } {
  const section = (name: string, next?: string): string => {
    const re = new RegExp(`${name}:?\\s*([\\s\\S]*?)${next ? `(?=${next}:)` : '$'}`, 'i');
    return re.exec(text)?.[1]?.trim() ?? '';
  };
  return {
    patch: section('PATCH', 'EXPLANATION'),
    explanation: section('EXPLANATION', 'TEST GUIDANCE'),
    testGuidance: section('TEST GUIDANCE'),
  };
}
