import { Buffer } from 'node:buffer';

import { MAX_CLOUD_RESPONSE_BYTES } from '../dist/public-dashboard.js';

export function sendPublicJson(response, status, value) {
  let code = status;
  let body = JSON.stringify(value);
  if (Buffer.byteLength(body, 'utf8') > MAX_CLOUD_RESPONSE_BYTES) {
    code = 413;
    body = JSON.stringify({ error: 'Response too large' });
  }
  response.setHeader(
    'Cache-Control',
    code === 200 ? 'public, max-age=0, s-maxage=15, stale-while-revalidate=45' : 'no-store',
  );
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.status(code).end(body);
}