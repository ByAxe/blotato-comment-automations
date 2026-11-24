import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import {
  BEARER_VALUE, createJsonServer, hashToken, HttpError, invalidRequest,
  json, presentedCredentials, readBody, requestUrl, stringField, utcDate, UUID,
} from './http-boundary.js';
import { readParticipantContext } from './participant-context.js';
import { ConfigurationError, databaseReady } from './runtime.js';
import { forgetParticipantContext, ingest, publish, setEnabled } from './workflow.js';

const PATH_ID = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,255}$/;

interface DemoAccess {
  tenantId: string;
  accountId: string;
  controlToken: string;
  adapterToken: string;
}

type Scope = 'control' | 'adapter';

function pathId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    invalidRequest();
  }
  if (!PATH_ID.test(decoded)) invalidRequest();
  return decoded;
}

function buildAuthorizer(access: DemoAccess) {
  if (!PATH_ID.test(access.tenantId) || !PATH_ID.test(access.accountId)) {
    throw new ConfigurationError('DEMO_TENANT_ID and DEMO_ACCOUNT_ID must be URL-safe IDs');
  }
  if (!BEARER_VALUE.test(access.controlToken) || !BEARER_VALUE.test(access.adapterToken) ||
      access.controlToken === access.adapterToken) {
    throw new ConfigurationError('DEMO_CONTROL_TOKEN and DEMO_ADAPTER_TOKEN must be distinct bearer tokens');
  }
  const control = hashToken(access.controlToken);
  const adapter = hashToken(access.adapterToken);

  return (req: IncomingMessage, tenantId: string, scope: Scope): void => {
    const presented = presentedCredentials(req);
    const controlMatch = timingSafeEqual(control, presented);
    const adapterMatch = timingSafeEqual(adapter, presented);
    if (!controlMatch && !adapterMatch) throw new HttpError(401, 'unauthorized');
    if (tenantId !== access.tenantId || !(scope === 'control' ? controlMatch : adapterMatch)) {
      throw new HttpError(403, 'forbidden');
    }
  };
}

function checkAccount(requested: string, access: DemoAccess): void {
  if (requested !== access.accountId) throw new HttpError(403, 'forbidden');
}

function optionalStringField(body: Record<string, unknown>, key: string, max: number): string | null {
  return body[key] === undefined || body[key] === null ? null : stringField(body, key, max);
}

async function checkedWorkflowRequest<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) invalidRequest();
    throw error;
  }
}

async function runStatus(pool: Pool, access: DemoAccess, url: URL) {
  const runIds = url.searchParams.getAll('runId');
  const runId = runIds[0];
  if (url.searchParams.size !== 1 || !runId || !UUID.test(runId)) invalidRequest();
  const result = await pool.query<{
    id: string;
    accountId: string;
    state: string;
    actions: Array<{ kind: string; status: string; attempts: number }>;
  }>(`
    SELECT r.id, r.account_id AS "accountId", r.state,
           COALESCE(
             (SELECT json_agg(json_build_object('kind', o.kind, 'status', o.status, 'attempts', o.attempts)
                              ORDER BY o.created_at, o.id)
                FROM outbox o WHERE o.run_id = r.id),
             '[]'::json
           ) AS actions
      FROM runs r
     WHERE r.tenant_id = $1 AND r.account_id = $2 AND r.id = $3
  `, [access.tenantId, access.accountId, runId]);
  const run = result.rows[0];
  if (!run) throw new HttpError(404, 'not_found');
  return run;
}

export function createHttpServer(pool: Pool, access: DemoAccess): Server {
  const authorize = buildAuthorizer(access);
  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = requestUrl(req);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const ready = await databaseReady(pool).catch(() => false);
      json(res, ready ? 200 : 503, { ready });
      return;
    }

    const [, version, collection, tenant, ...resource] = url.pathname.split('/');
    if (version !== 'v1' || collection !== 'tenants' || !tenant) {
      throw new HttpError(404, 'not_found');
    }
    const tenantId = pathId(tenant);

    if (req.method === 'POST' && resource.join('/') === 'automations') {
      authorize(req, tenantId, 'control');
      const body = await readBody(req, [
        'accountId', 'keyword', 'publicReply', 'emailPrompt', 'linkUrl', 'postId',
        'collectParticipantContext', 'returningEmailPrompt',
      ]);
      const accountId = stringField(body, 'accountId', 255);
      checkAccount(accountId, access);
      const { collectParticipantContext = false } = body;
      if (typeof collectParticipantContext !== 'boolean') invalidRequest();
      const versionId = await checkedWorkflowRequest(publish(pool, {
        tenantId,
        accountId,
        keyword: stringField(body, 'keyword', 128),
        publicReply: stringField(body, 'publicReply', 2_000),
        emailPrompt: stringField(body, 'emailPrompt', 2_000),
        collectParticipantContext,
        returningEmailPrompt: optionalStringField(body, 'returningEmailPrompt', 2_000),
        linkUrl: stringField(body, 'linkUrl', 2_048),
        postId: optionalStringField(body, 'postId', 255),
      }));
      json(res, 201, { versionId });
      return;
    }

    const [collectionName, account, operation, subresource] = resource;
    if (req.method === 'PUT' && resource.length === 3 &&
        collectionName === 'automations' && account && operation === 'enabled') {
      authorize(req, tenantId, 'control');
      const accountId = pathId(account);
      checkAccount(accountId, access);
      const body = await readBody(req, ['enabled']);
      if (typeof body.enabled !== 'boolean') invalidRequest();
      const updated = await setEnabled(pool, tenantId, accountId, body.enabled);
      if (!updated) throw new HttpError(404, 'not_found');
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    if (req.method === 'POST' && collectionName === 'automations' && account && operation === 'participant-context' &&
        (resource.length === 3 || (resource.length === 4 && subresource === 'deletions'))) {
      authorize(req, tenantId, 'control');
      const accountId = pathId(account);
      checkAccount(accountId, access);
      const body = await readBody(req, ['participantId']);
      const participantId = stringField(body, 'participantId', 255);
      if (resource.length === 3) {
        json(res, 200, await readParticipantContext(pool, tenantId, accountId, participantId));
      } else {
        await forgetParticipantContext(pool, tenantId, accountId, participantId);
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
      }
      return;
    }

    if (req.method === 'POST' && resource.join('/') === 'adapter/events') {
      authorize(req, tenantId, 'adapter');
      const body = await readBody(req, [
        'accountId', 'participantId', 'eventId', 'objectId', 'postId',
        'kind', 'text', 'occurredAt', 'platform', 'isSelf',
      ]);
      const accountId = stringField(body, 'accountId', 255);
      checkAccount(accountId, access);
      const { kind, platform, isSelf = false } = body;
      if ((kind !== 'comment' && kind !== 'message') ||
          platform !== 'instagram' || typeof isSelf !== 'boolean' ||
          (kind === 'message' && Object.hasOwn(body, 'postId'))) {
        invalidRequest();
      }
      const result = await checkedWorkflowRequest(ingest(pool, {
        tenantId,
        accountId,
        participantId: stringField(body, 'participantId', 255),
        eventId: stringField(body, 'eventId', 255),
        objectId: stringField(body, 'objectId', 255),
        kind,
        ...(kind === 'comment' && { postId: optionalStringField(body, 'postId', 255) }),
        text: stringField(body, 'text', 16_000, true),
        occurredAt: utcDate(body.occurredAt),
        platform,
        isSelf,
      }));
      json(res, 200, result);
      return;
    }

    if (req.method === 'GET' && resource.join('/') === 'status') {
      authorize(req, tenantId, 'control');
      json(res, 200, await runStatus(pool, access, url));
      return;
    }

    throw new HttpError(404, 'not_found');
  };

  return createJsonServer(route);
}
