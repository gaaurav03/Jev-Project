import { DEFAULT_DASHBOARD_PORT, startDashboardServer } from './dashboard.js';

const rawPort = process.argv[2] ?? String(DEFAULT_DASHBOARD_PORT);
const port = Number(rawPort);
await startDashboardServer({ port });
process.stdout.write(`Dashboard API listening on http://127.0.0.1:${port}\n`);
