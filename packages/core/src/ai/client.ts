import { HttpClient } from '../providers/http.js';
import { assertSafeUrl } from '../net/ssrf.js';

/** BYO-key LLM config: any OpenAI-compatible endpoint (OpenRouter, Ollama, …). */
export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Allow loopback and LAN addresses, as a self-hosted Ollama needs. */
  allowPrivateHost?: boolean;
}

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
}

/**
 * Minimal OpenAI-compatible chat client. One code path serves OpenRouter (any
 * model) and local endpoints (Ollama / LM Studio / vLLM) — only baseUrl + model
 * + apiKey differ. Kept deliberately small: a single JSON chat completion.
 */
export class LlmClient {
  private readonly http: HttpClient;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly allowPrivateHost: boolean;
  private checked?: Promise<void>;

  constructor(cfg: LlmConfig) {
    this.model = cfg.model;
    this.baseUrl = cfg.baseUrl;
    this.allowPrivateHost = cfg.allowPrivateHost ?? false;
    this.http = new HttpClient({
      baseUrl: cfg.baseUrl.replace(/\/$/, ''),
      minIntervalMs: 0,
      maxRetries: 1,
      timeoutMs: 60_000,
      // The user picks this host, so a redirect must not carry the request
      // somewhere the guard already refused.
      followRedirects: false,
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'user-agent': 'Watchmuse',
      },
    });
  }

  /**
   * The endpoint is user-supplied, so it is checked before anything is sent.
   * Resolved once per client, which is as long as any single operation lives.
   */
  private ensureSafe(): Promise<void> {
    this.checked ??= assertSafeUrl(this.baseUrl, { allowPrivate: this.allowPrivateHost });
    return this.checked;
  }

  /** Single completion; returns the assistant message text (may be empty). */
  async complete(system: string, user: string, opts?: { temperature?: number }): Promise<string> {
    await this.ensureSafe();
    const res = await this.http.post<ChatResponse>('/chat/completions', {
      model: this.model,
      temperature: opts?.temperature ?? 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return res.choices?.[0]?.message?.content ?? '';
  }
}
