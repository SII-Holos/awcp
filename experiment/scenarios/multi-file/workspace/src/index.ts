/**
 * Multi-file Scenario - Main Entry Point
 */

import { Logger } from './helpers.js';

const logger = new Logger('Main');

export function main(): void {
  logger.info('Application started');
  
  // Do some work
  const result = processData([1, 2, 3, 4, 5]);
  logger.info(`Result: ${result}`);
  
  logger.info('Application finished');
}

function processData(data: number[]): number {
  return data.reduce((sum, n) => sum + n, 0);
}

// Run if executed directly
main();
