/**
 * Archive Extractor
 *
 * Extracts ZIP archives to directories.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl-promise';

export class ArchiveExtractor {
  /**
   * Extract a ZIP archive to a directory
   */
  async extract(archivePath: string, targetDir: string): Promise<void> {
    // Normalize targetDir to ensure consistent path comparison
    const normalizedTargetDir = path.resolve(targetDir);
    await fs.promises.mkdir(normalizedTargetDir, { recursive: true });

    const zip = await yauzl.open(archivePath);

    try {
      for await (const entry of zip) {
        // Resolve the full path and normalize it
        const entryPath = path.resolve(normalizedTargetDir, entry.filename);

        // Security: prevent path traversal
        // The entry path must be inside the target directory
        if (!entryPath.startsWith(normalizedTargetDir + path.sep) && entryPath !== normalizedTargetDir) {
          throw new Error(`Invalid entry path: ${entry.filename}`);
        }

        if (entry.filename.endsWith('/')) {
          // Directory entry
          await fs.promises.mkdir(entryPath, { recursive: true });
        } else {
          // File entry
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

  /**
   * Create a ZIP archive from a directory (for uploading results)
   */
  async createArchive(sourceDir: string, archivePath: string): Promise<void> {
    // Dynamic import to avoid circular dependency issues
    const archiver = (await import('archiver')).default;

    const output = fs.createWriteStream(archivePath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    archive.pipe(output);
    archive.directory(sourceDir, false);

    await archive.finalize();

    await new Promise<void>((resolve, reject) => {
      output.on('finish', resolve);
      output.on('error', reject);
    });
  }
}
