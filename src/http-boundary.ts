import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { TextDecoder } from 'node:util';
import { logFailure } from './runtime.js';

const MAX_BODY_BYTES = 128 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const BEARER_VALUE = /^[A-Za-z0-9._~+/-]{1,256}={0,4}$/;
export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
type Body = Record<string, unknown>;

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export function invalidRequest(): never {
  throw new HttpError(400, 'invalid_request');
}

export function utcDate(value: unknown): Date {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) invalidRequest();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalidRequest();
  return date;
}

export function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

export function requestUrl(req: IncomingMessage): URL {
  if (!req.url?.startsWith('/') || req.url.startsWith('//')) invalidRequest();
  return new URL(req.url, 'http://localhost');
}

export function hashToken(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function presentedCredentials(req: IncomingMessage): Buffer {
  const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (!token || !BEARER_VALUE.test(token)) throw new HttpError(401, 'unauthorized');
  return hashToken(token);
}

export async function readBody(req: IncomingMessage, fields: readonly string[]): Promise<Body> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type');
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    throw new HttpError(413, 'body_too_large');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  // Keep the socket writable so an oversized chunked request can receive a 413.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');
    chunks.push(bytes);
  }

  let value: unknown;
  try {
    value = JSON.parse(utf8.decode(Buffer.concat(chunks)));
  } catch {
    invalidRequest();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidRequest();
  if (Object.keys(value).some((key) => !fields.includes(key))) invalidRequest();
  return value as Body;
}

export function stringField(body: Body, key: string, max: number, allowEmpty = false): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length > max ||
      value.includes('\u0000') || (!allowEmpty && value.trim().length === 0)) {
    invalidRequest();
  }
  return value;
}

export function createJsonServer(
  route: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Server {
  return createServer({
    headersTimeout: 5_000,
    requestTimeout: 10_000,
    connectionsCheckingInterval: 1_000,
  }, (req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (!req.complete) res.setHeader('Connection', 'close');
      if (error instanceof HttpError) {
        if (error.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
        json(res, error.status, { error: error.code });
        return;
      }
      logFailure('request_failed');
      json(res, 500, { error: 'internal_error' });
    });
  });
}
