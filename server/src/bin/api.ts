import { errorCounts, logLine } from '../../../src/alerts/log';
import { startApi } from '../api/main';

// Last resort: even a crash prints counts only (never a stack with SQL, URLs or tokens in it).
const fail = (e: unknown) => { logLine('api', 'error', errorCounts(e)); process.exit(1); };
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
startApi(process.env).then((s) => { if (!s) process.exit(1); }, fail);
