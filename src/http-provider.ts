import type { SendOutcome, SocialAction, SocialAdapter } from './adapter.js';
import { BEARER_VALUE } from './http-boundary.js';
import { ConfigurationError } from './runtime.js';

const MAX_RECEIPT_RESPONSE_BYTES = 1_024;

async function readReceipt(response: Response): Promise<string | null> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;

  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > MAX_RECEIPT_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (typeof body !== 'object' || body === null || !('receipt' in body)) return null;
    const { receipt } = body;
    return typeof receipt === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(receipt) ? receipt : null;
  } catch {
    return null;
  }
}

export class FakeHttpSocialAdapter implements SocialAdapter {
  readonly #endpoint: URL;
  readonly #token: string;

  constructor(endpoint: string, token: string) {
    const url = URL.parse(endpoint);
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new ConfigurationError('PROVIDER_URL must be an HTTP or HTTPS fixture endpoint');
    }
    if (!BEARER_VALUE.test(token)) {
      throw new ConfigurationError('PROVIDER_TOKEN must be a bearer token');
    }
    this.#endpoint = url;
    this.#token = token;
  }

  async send(action: SocialAction, signal: AbortSignal): Promise<SendOutcome> {
    try {
      const response = await fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': action.id,
        },
        body: JSON.stringify(action),
        redirect: 'error',
        signal,
      });

      if (response.status === 200) {
        const receipt = await readReceipt(response);
        return receipt
          ? { kind: 'sent', receipt }
          : { kind: 'uncertain', code: 'invalid_provider_receipt' };
      }

      await response.body?.cancel().catch(() => {});
      // These meanings are part of the local fixture contract.
      if (response.status === 410) {
        return { kind: 'rejected', code: 'window_expired' };
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter && /^\d{1,5}$/.test(retryAfter) ? Number(retryAfter) : 0;
        return seconds > 0
          ? { kind: 'retry', code: 'rate_limited', retryAfterMs: seconds * 1_000 }
          : { kind: 'retry', code: 'rate_limited' };
      }
      if ([400, 403, 422].includes(response.status)) {
        return { kind: 'rejected', code: 'provider_rejected' };
      }
      return { kind: 'uncertain', code: 'unconfirmed_provider_response' };
    } catch {
      return { kind: 'uncertain', code: 'unconfirmed_provider_response' };
    }
  }
}
