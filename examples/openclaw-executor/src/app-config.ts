/**
 * Application Configuration
 *
 * General configuration for the OpenClaw Executor application.
 * This is separate from AWCP protocol configuration and OpenClaw-specific settings.
 */

import path from 'node:path';
import os from 'node:os';

export interface AppConfig {
  /** HTTP server port */
  port: number;
  /** HTTP server host */
  host: string;
  /** Base data directory for runtime files */
  dataDir: string;
  /** Logs directory */
  logsDir: string;
}

export function loadAppConfig(): AppConfig {
  const port = parseInt(process.env.PORT || '10200', 10);
  const host = process.env.HOST || '0.0.0.0';

  // Use SCENARIO_DIR for experiments, otherwise ~/.awcp for normal usage
  const dataDir = process.env.SCENARIO_DIR || path.join(os.homedir(), '.awcp');

  return {
    port,
    host,
    dataDir,
    logsDir: path.join(dataDir, 'logs'),
  };
}
