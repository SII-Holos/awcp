/**
 * Vision Executor Configuration
 */

export interface Config {
  port: number;
  agentUrl: string;
  synergyUrl: string;
  synergyAutoStart: boolean;
  scenarioDir: string;
}

export function loadConfig(): Config {
  const port = parseInt(process.env.PORT || '10200', 10);
  return {
    port,
    agentUrl: process.env.AGENT_URL || `http://localhost:${port}`,
    synergyUrl: process.env.SYNERGY_URL || 'http://localhost:2026',
    synergyAutoStart: process.env.SYNERGY_AUTO_START !== 'false',
    scenarioDir: process.env.SCENARIO_DIR || process.cwd(),
  };
}
