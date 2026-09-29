import { MAX_TELEMETRY_BYTES } from '../dist/telemetry.js';
import { ingestTelemetry } from '../dist/community.js';

async function readBody(request) {
  if (typeof request.body === 'string') return request.body;
  if (Buffer.isBuffer(request.body)) return request.body.toString('utf8');
  if (request.body !== undefined) return JSON.stringify(request.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_TELEMETRY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(request, response) {
  const body = await readBody(request);
  const result = body === null
    ? { status: 413, body: { ok: false, error: 'Payload too large' } }
    : await ingestTelemetry({
        method: request.method,
        contentType: request.headers['content-type'],
        forwardedFor: request.headers['x-forwarded-for'],
        body,
      }, process.env, fetch);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.status(result.status).end(JSON.stringify(result.body));
}
