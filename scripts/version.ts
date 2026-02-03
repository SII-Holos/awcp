#!/usr/bin/env npx tsx
/**
 * Version management script (inspired by Synergy)
 * 
 * Usage:
 *   npx tsx scripts/version.ts              # Auto-detect: preview or release
 *   npx tsx scripts/version.ts patch        # Bump patch version
 *   npx tsx scripts/version.ts minor        # Bump minor version  
 *   npx tsx scripts/version.ts major        # Bump major version
 * 
 * Environment variables:
 *   AWCP_BUMP     - patch|minor|major (for releases)
 *   AWCP_VERSION  - Override version directly
 *   AWCP_CHANNEL  - Override channel (default: git branch)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const PACKAGES = [
  'packages/core',
  'packages/transport-sshfs',
  'packages/transport-archive',
  'packages/transport-storage',
  'packages/sdk',
  'packages/mcp',
];

type BumpType = 'patch' | 'minor' | 'major';

// Get current git branch
function getCurrentBranch(): string {
  try {
    return execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
  } catch {
    return 'dev';
  }
}

// Get latest published version from npm
async function getLatestVersion(): Promise<string> {
  try {
    const res = await fetch('https://registry.npmjs.org/@awcp/core/latest');
    if (!res.ok) return '0.1.0';
    const data = await res.json() as { version: string };
    return data.version;
  } catch {
    return '0.1.0';
  }
}

function bumpVersion(version: string, type: BumpType): string {
  // Strip any prerelease suffix for bumping
  const baseVersion = version.split('-')[0] ?? '0.0.0';
  const parts = baseVersion.split('.').map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  
  switch (type) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
  }
}

function generateTimestamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
}

async function main() {
  const env = {
    AWCP_CHANNEL: process.env['AWCP_CHANNEL'],
    AWCP_BUMP: process.env['AWCP_BUMP'] || process.argv[2],
    AWCP_VERSION: process.env['AWCP_VERSION'],
  };

  // Determine channel
  const channel = env.AWCP_CHANNEL 
    || (env.AWCP_BUMP ? 'latest' : null)
    || (env.AWCP_VERSION && !env.AWCP_VERSION.startsWith('0.0.0-') ? 'latest' : null)
    || getCurrentBranch();

  const isPreview = channel !== 'latest' && channel !== 'main';

  // Determine version
  let newVersion: string;
  
  if (env.AWCP_VERSION) {
    newVersion = env.AWCP_VERSION;
  } else if (isPreview) {
    // Preview: 0.0.0-{channel}-{timestamp}
    newVersion = `0.0.0-${channel}-${generateTimestamp()}`;
  } else {
    // Release: bump from latest npm version
    const latestVersion = await getLatestVersion();
    const bumpType = (env.AWCP_BUMP as BumpType) || 'patch';
    
    if (!['patch', 'minor', 'major'].includes(bumpType)) {
      console.error('Invalid bump type. Use: patch, minor, or major');
      process.exit(1);
    }
    
    newVersion = bumpVersion(latestVersion, bumpType);
  }

  console.log(JSON.stringify({ channel, version: newVersion, preview: isPreview }, null, 2));

  // Update all packages
  for (const pkgDir of PACKAGES) {
    const pkgPath = join(process.cwd(), pkgDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    
    pkg.version = newVersion;
    
    // Also update internal dependencies
    if (pkg.dependencies) {
      for (const dep of Object.keys(pkg.dependencies)) {
        if (dep.startsWith('@awcp/')) {
          // For preview versions, use exact version; for releases, use caret
          pkg.dependencies[dep] = isPreview ? newVersion : `^${newVersion}`;
        }
      }
    }
    
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`Updated: ${pkgDir}/package.json → ${newVersion}`);
  }

  // Output for GitHub Actions
  if (process.env['GITHUB_OUTPUT']) {
    const output = `version=${newVersion}\npreview=${isPreview}\nchannel=${channel}\n`;
    writeFileSync(process.env['GITHUB_OUTPUT'], output, { flag: 'a' });
  }

  console.log(`\n✓ All packages updated to v${newVersion}`);
}

main();
