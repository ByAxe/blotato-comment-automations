import { timingSafeEqual } from 'node:crypto';
import type { SocialAction } from '../src/adapter.js';
import {
  BEARER_VALUE, createJsonServer, hashToken, HttpError, invalidRequest,
  json, presentedCredentials, readBody, requestUrl, stringField, utcDate, UUID,
} from '../src/http-boundary.js';
import { ConfigurationError, integerEnv, logFailure, requiredEnv, runServer } from '../src/runtime.js';

const MAX_RECORDS = 1_000;
const SEND_FIELDS = [
  'id', 'runId', 'tenantId', 'accountId', 'participantId', 'commentId', 'kind', 'text', 'sendBefore',
];

interface Recording {
  action: SocialAction;
  receipt: string;
}

async function main(): Promise<void> {
  const token = requiredEnv('PROVIDER_TOKEN');
  if (!BEARER_VALUE.test(token)) throw new ConfigurationError('PROVIDER_TOKEN must be a bearer token');
  const tokenHash = hashToken(token);
  const host = process.env.PROVIDER_HOST ?? '127.0.0.1';
  const port = integerEnv('PROVIDER_PORT', 3_001, 0, 65_535);
  const recordings = new Map<string, Recording>();

  const server = createJsonServer(async (req, res) => {
    const url = requestUrl(req);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, { ready: true });
      return;
    }

    if (!timingSafeEqual(tokenHash, presentedCredentials(req))) {
      throw new HttpError(401, 'unauthorized');
    }
    if (req.method === 'GET' && url.pathname === '/records') {
      const limit = url.searchParams.get('limit') ?? '100';
      if (url.searchParams.size > (url.searchParams.has('limit') ? 1 : 0) ||
          !/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100) invalidRequest();

      json(res, 200, {
        total: recordings.size,
        records: Array.from(recordings.values()).slice(-Number(limit)),
      });
      return;
    }

    if (req.method !== 'POST' || url.pathname !== '/send') {
      throw new HttpError(404, 'not_found');
    }

    const body = await readBody(req, SEND_FIELDS);
    const { kind } = body;
    const id = stringField(body, 'id', 36);
    const runId = stringField(body, 'runId', 36);
    if (!UUID.test(id) || !UUID.test(runId) || req.headers['idempotency-key'] !== id ||
        (kind !== 'comment_reply' && kind !== 'email_prompt' && kind !== 'link_dm')) invalidRequest();

    const sendBefore = utcDate(body.sendBefore);
    const action: SocialAction = {
      id,
      runId,
      tenantId: stringField(body, 'tenantId', 255),
      accountId: stringField(body, 'accountId', 255),
      participantId: stringField(body, 'participantId', 255),
      commentId: stringField(body, 'commentId', 255),
      kind,
      text: stringField(body, 'text', 2_048),
      sendBefore: sendBefore.toISOString(),
    };
    const prior = recordings.get(id);
    if (prior) {
      if (JSON.stringify(prior.action) !== JSON.stringify(action)) {
        throw new HttpError(409, 'idempotency_conflict');
      }
      json(res, 200, { receipt: prior.receipt });
      return;
    }

    if (Date.now() >= sendBefore.getTime()) throw new HttpError(410, 'window_expired');
    if (recordings.size >= MAX_RECORDS) {
      res.setHeader('Retry-After', '60');
      throw new HttpError(429, 'fixture_capacity_reached');
    }
    const receipt = `fixture-${id}`;
    recordings.set(id, { action, receipt });
    json(res, 200, { receipt });
  });

  await runServer(server, host, port, 'recording_provider_listening');
}

void main().catch((error: unknown) => {
  logFailure('recording_provider_startup_or_runtime_error', error);
  process.exitCode = 1;
});
