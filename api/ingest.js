import { MAX_CLOUD_RUN_BYTES } from '../dist/cloud.js';
import { ingestCloudRun } from '../dist/cloud-ingest.js';

async function readBody(request) {
  if (typeof request.body === 'string') return request.body;
  if (Buffer.isBuffer(request.body)) return request.body.toString('utf8');
  if (request.body !== undefined) return JSON.stringify(request.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_CLOUD_RUN_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(request, response) {
  const body = await readBody(request);
  const result = body === null
    ? { status: 413, body: { ok: false, error: 'Payload too large' } }
    : await ingestCloudRun({
        method: request.method,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body,
      }, process.env, fetch);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.status(result.status).end(JSON.stringify(result.body));
}