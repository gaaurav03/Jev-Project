import { readCommunityStats } from '../dist/community.js';
import { sendPublicJson } from './_dashboard.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    sendPublicJson(response, 405, { error: 'Method not allowed' });
    return;
  }
  const url = new URL(request.url ?? '/', 'https://dashboard.local');
  if ([...url.searchParams].length > 0) {
    sendPublicJson(response, 400, { error: 'Query not supported' });
    return;
  }
  try {
    sendPublicJson(response, 200, await readCommunityStats(process.env, fetch));
  } catch {
    sendPublicJson(response, 503, { error: 'Community metrics unavailable' });
  }
}
