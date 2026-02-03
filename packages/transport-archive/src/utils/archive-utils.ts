/**
 * Shared archive utilities for ZIP-based transports.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import * as yauzl from 'yauzl-promise';
import type { ResourceMapping } from '@awcp/core';

export interface CreateArchiveOptions {
  exclude?: string[];
}

export async function createArchive(
  sourceDir: string,
  archivePath: string,
  options: CreateArchiveOptions = {},
): Promise<void> {
  const output = fs.createWriteStream(archivePath);
  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.pipe(output);
  archive.glob('**/*', {
    cwd: sourceDir,
    ignore: options.exclude ?? ['.awcp/**'],
    dot: true,
    follow: true,
  });
  await archive.finalize();

  await new Promise<void>((resolve, reject) => {
    output.on('finish', resolve);
    output.on('error', reject);
  });
}

export async function extractArchive(archivePath: string, targetDir: string): Promise<void> {
  const normalizedTargetDir = path.resolve(targetDir);
  await fs.promises.mkdir(normalizedTargetDir, { recursive: true });

  const zip = await yauzl.open(archivePath);

  try {
    for await (const entry of zip) {
      const entryPath = path.resolve(normalizedTargetDir, entry.filename);

      // Security: prevent path traversal
      if (!entryPath.startsWith(normalizedTargetDir + path.sep) && entryPath !== normalizedTargetDir) {
        throw new Error(`Invalid entry path: ${entry.filename}`);
      }

      if (entry.filename.endsWith('/')) {
        await fs.promises.mkdir(entryPath, { recursive: true });
      } else {
        await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });
        const readStream = await entry.openReadStream();
        const writeStream = fs.createWriteStream(entryPath);
        await pipeline(readStream, writeStream);
      }
    }
  } finally {
    await zip.close();
  }
}

export async function copyDirectory(source: string, target: string): Promise<void> {
  const entries = await fs.promises.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      await fs.promises.mkdir(targetPath, { recursive: true });
      await copyDirectory(sourcePath, targetPath);
    } else {
      await fs.promises.copyFile(sourcePath, targetPath);
    }
  }
}

export async function applyResultToResources(extractDir: string, resources: ResourceMapping[]): Promise<void> {
  for (const resource of resources) {
    if (resource.mode === 'rw') {
      const sourcePath = path.join(extractDir, resource.name);
      const targetPath = resource.source;

      const sourceExists = await fs.promises.stat(sourcePath).then(() => true).catch(() => false);
      if (sourceExists) {
        await copyDirectory(sourcePath, targetPath);
      }
    }
  }
}
