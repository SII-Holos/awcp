/**
 * Configuration loader for AWCP Experiment
 */

import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_ROOT = resolve(__dirname, '..');

export interface ExperimentConfig {
  // Mode
  mode: 'local' | 'host-only' | 'remote-only';
  
  // Host
  hostPort: number;
  hostUrl: string;
  
  // Remote
  remotePort: number;
  remoteUrl: string;
  
  // SSH
  sshHost: string;
  sshPort: number;
  sshUser: string;
  
  // Scenario
  scenario: string;
  workspacePath: string;
  mountPath: string;
  
  // Agent
  mockAgentType: string;
  
  // Logging
  logLevel: string;
  
  // Root path
  experimentRoot: string;
}

/**
 * Load configuration from environment and config file
 */
export function loadConfig(configFile?: string): ExperimentConfig {
  // Determine config file path
  const configPath = configFile 
    ? resolve(EXPERIMENT_ROOT, configFile)
    : resolve(EXPERIMENT_ROOT, 'configs/local.env');

  // Load from config file if exists
  if (existsSync(configPath)) {
    loadDotenv({ path: configPath });
    console.log(`[Config] Loaded from ${configPath}`);
  } else {
    console.log(`[Config] Config file not found: ${configPath}, using environment variables`);
  }

  const scenario = process.env['SCENARIO'] || 'basic';
  
  // Resolve paths
  const workspacePath = resolve(
    EXPERIMENT_ROOT,
    (process.env['WORKSPACE_PATH'] || `./scenarios/${scenario}/workspace`).replace('${SCENARIO}', scenario)
  );
  
  const mountPath = resolve(
    EXPERIMENT_ROOT,
    (process.env['MOUNT_PATH'] || `./scenarios/${scenario}/mount`).replace('${SCENARIO}', scenario)
  );

  return {
    mode: (process.env['MODE'] as ExperimentConfig['mode']) || 'local',
    
    hostPort: parseInt(process.env['HOST_PORT'] || '4000', 10),
    hostUrl: process.env['HOST_URL'] || 'http://localhost:4000',
    
    remotePort: parseInt(process.env['REMOTE_PORT'] || '4001', 10),
    remoteUrl: process.env['REMOTE_URL'] || 'http://localhost:4001',
    
    sshHost: process.env['SSH_HOST'] || 'localhost',
    sshPort: parseInt(process.env['SSH_PORT'] || '22', 10),
    sshUser: process.env['SSH_USER'] || process.env['USER'] || 'awcp',
    
    scenario,
    workspacePath,
    mountPath,
    
    mockAgentType: process.env['MOCK_AGENT_TYPE'] || 'add-header',
    
    logLevel: process.env['LOG_LEVEL'] || 'info',
    
    experimentRoot: EXPERIMENT_ROOT,
  };
}

/**
 * Print configuration (for debugging)
 */
export function printConfig(config: ExperimentConfig): void {
  console.log('\n=== Experiment Configuration ===');
  console.log(`Mode:           ${config.mode}`);
  console.log(`Host URL:       ${config.hostUrl}`);
  console.log(`Remote URL:     ${config.remoteUrl}`);
  console.log(`SSH:            ${config.sshUser}@${config.sshHost}:${config.sshPort}`);
  console.log(`Scenario:       ${config.scenario}`);
  console.log(`Workspace:      ${config.workspacePath}`);
  console.log(`Mount Point:    ${config.mountPath}`);
  console.log(`Agent Type:     ${config.mockAgentType}`);
  console.log('================================\n');
}
