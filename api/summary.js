import { readCloudRuns, summarizeCloudRuns } from '../dist/public-dashboard.js';
import { sendPublicJson } from './_dashboard.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    sendPublicJson(response, 405, { error: 'Method not allowed' });
    return;
  }
  if (!request.url || request.url.length > 2048) {
    sendPublicJson(response, 414, { error: 'Request URI too long' });
    return;
  }
  const url = new URL(request.url, 'https://dashboard.local');
  if ([...url.searchParams].length > 0) {
    sendPublicJson(response, 400, { error: 'Query not supported' });
    return;
  }
  try {
    const rows = await readCloudRuns(process.env, fetch);
    sendPublicJson(response, 200, summarizeCloudRuns(rows));
  } catch {
    sendPublicJson(response, 503, { error: 'Live metrics unavailable' });
  }
}