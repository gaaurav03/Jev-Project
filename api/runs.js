import { HttpError, parseDashboardFilters } from '../dist/dashboard.js';
import { listCloudRuns, readCloudRuns } from '../dist/public-dashboard.js';
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
  try {
    const url = new URL(request.url, 'https://dashboard.local');
    parseDashboardFilters(url);
    const rows = await readCloudRuns(process.env, fetch);
    sendPublicJson(response, 200, listCloudRuns(rows, url));
  } catch (error) {
    sendPublicJson(
      response,
      error instanceof HttpError ? error.status : 503,
      { error: error instanceof HttpError ? error.message : 'Live metrics unavailable' },
    );
  }
}