import axios from 'axios';
import FormData from 'form-data';
import { Logger } from './logger.js';

export interface ForgeAssetsConfig {
  apiKey: string;
  baseUrl?: string;
}

export class ForgeAssetsClient {
  private apiKey: string;
  private baseUrl: string;
  private logger: Logger;

  constructor(options: { logger: Logger; config: ForgeAssetsConfig }) {
    this.logger = options.logger.child({ component: 'ForgeAssetsClient' });
    this.apiKey = options.config.apiKey;
    this.baseUrl = options.config.baseUrl || 'https://forge-vtt.com/api';
  }

  /**
   * Upload an image buffer to the Forge asset library
   */
  async uploadImage(filename: string, imageBuffer: Buffer, folder: string = 'npc-portraits'): Promise<{ success: boolean; url: string }> {
    const targetPath = `${folder}/${filename}`;

    this.logger.info('Uploading image to Forge asset library', {
      filename,
      folder,
      targetPath,
      sizeBytes: imageBuffer.length,
    });

    const form = new FormData();
    form.append('file', imageBuffer, { filename, contentType: 'image/png' });
    form.append('path', targetPath);

    try {
      const response = await axios.post(`${this.baseUrl}/assets/upload`, form, {
        headers: {
          ...form.getHeaders(),
          'Authorization': this.apiKey,
        },
        timeout: 30000,
      });

      const assetUrl = response.data?.url || response.data?.path || targetPath;

      this.logger.info('Image uploaded to Forge', {
        targetPath,
        responseUrl: assetUrl,
      });

      return { success: true, url: assetUrl };
    } catch (error: any) {
      this.logger.error('Failed to upload image to Forge', {
        filename,
        error: error instanceof Error ? error.message : 'Unknown error',
        status: error?.response?.status,
        response: error?.response?.data,
      });
      throw new Error(`Forge upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * List images in a Forge asset library folder
   */
  async listImages(folder: string = 'npc-portraits'): Promise<string[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/assets/browse`, {
        params: { path: folder },
        headers: {
          'Authorization': this.apiKey,
        },
        timeout: 10000,
      });

      const files: string[] = response.data?.files || [];
      this.logger.info('Listed Forge asset folder', { folder, fileCount: files.length });
      return files;
    } catch (error: any) {
      this.logger.error('Failed to list Forge assets', {
        folder,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw new Error(`Forge list failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * List a folder and return rich entries: path (Foundry-relative), full URL
   * when available, and basename. Calls Forge's POST /api/assets/browse with
   * a JSON body — verified live against forge-vtt.com on 2026-04-26. The
   * response shape is `{ dirs, files: [{name, path, url, size}], folder, bazaar }`.
   *
   * Important: GET /api/assets/browse returns 404 ("Unknown API request"); the
   * verb has to be POST and the path goes in the JSON body, not the query
   * string. Older cuts of this client used GET and silently never worked —
   * cos-pipeline only used the upload path so it stayed hidden.
   *
   * Still tolerates the old `files: string[]` shape just in case Forge ever
   * brings GET back; the parser branches on entry type at the boundary.
   *
   * Recursion: when `recursive: true`, walks subdirs depth-first up to
   * `maxDepth` (default 3). Needed for libraries like `My Avatars` whose
   * actual files live in subdirs (Monsters/, NPCs/Avatars/, NPCs/Tokens/,
   * Strahd's Minions/Portrait/, etc.) — a non-recursive browse of the root
   * returns 0 files there.
   */
  async browseFolder(
    folder: string,
    options: { recursive?: boolean; maxDepth?: number } = {},
  ): Promise<ForgeAssetEntry[]> {
    const recursive = options.recursive ?? false;
    const maxDepth = options.maxDepth ?? 3;
    return this.browseRecursive(folder, recursive, maxDepth, 0);
  }

  private async browseRecursive(
    folder: string,
    recursive: boolean,
    maxDepth: number,
    depth: number,
  ): Promise<ForgeAssetEntry[]> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/assets/browse`,
        { path: folder },
        {
          headers: {
            'Authorization': this.apiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          timeout: 15000,
        },
      );

      const data = response.data ?? {};
      const rawFiles = Array.isArray(data.files) ? data.files : [];
      const rawUrls = Array.isArray(data.fileURLs) ? data.fileURLs : [];
      const entries: ForgeAssetEntry[] = [];

      for (let i = 0; i < rawFiles.length; i++) {
        const f = rawFiles[i];
        if (typeof f === 'string') {
          const path = f;
          const name = path.split(/[\\/]/).pop() ?? path;
          const url = typeof rawUrls[i] === 'string' ? rawUrls[i] : undefined;
          entries.push(url ? { path, name, url } : { path, name });
        } else if (f && typeof f === 'object') {
          const path = String(f.path ?? f.name ?? '');
          if (!path) continue;
          const name = String(f.name ?? path.split(/[\\/]/).pop() ?? path);
          const url: string | undefined = typeof f.url === 'string' ? f.url
            : typeof rawUrls[i] === 'string' ? rawUrls[i]
            : undefined;
          entries.push(url ? { path, name, url } : { path, name });
        }
      }

      // Recursion: walk subdirs and concatenate. Depth-limited so a
      // pathological folder tree can't run away. Errors in a subdir are
      // logged but don't abort the whole walk — return what we got.
      if (recursive && depth < maxDepth) {
        const rawDirs = Array.isArray(data.dirs) ? data.dirs : [];
        for (const d of rawDirs) {
          const subPath = typeof d === 'string'
            ? d
            : (typeof d?.path === 'string' ? d.path : null);
          if (!subPath) continue;
          // Forge dir paths come back with a trailing slash; strip for the next call.
          const cleaned = subPath.replace(/\/$/, '');
          try {
            const subEntries = await this.browseRecursive(cleaned, true, maxDepth, depth + 1);
            entries.push(...subEntries);
          } catch (err: any) {
            this.logger.warn('Recursive browse subdir failed; continuing', {
              subPath: cleaned,
              error: err?.message ?? String(err),
            });
          }
        }
      }

      if (depth === 0) {
        this.logger.info('Browsed Forge folder', {
          folder, fileCount: entries.length,
          urlsAttached: entries.filter(e => e.url).length,
          recursive, maxDepth,
        });
      }
      return entries;
    } catch (error: any) {
      this.logger.error('Failed to browse Forge folder', {
        folder, depth,
        error: error instanceof Error ? error.message : 'Unknown error',
        status: error?.response?.status,
      });
      throw new Error(`Forge browse failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Sanitize an NPC name for use as a filename
   */
  static sanitizeFilename(npcName: string): string {
    return npcName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-]/g, '');
  }
}

export interface ForgeAssetEntry {
  /** Foundry-relative path (e.g., "moulinette/adventures/.../Volenta.webp"). */
  path: string;
  /** Basename (e.g., "Volenta.webp"). */
  name: string;
  /** Full https URL if Forge returned one. Optional. */
  url?: string;
}
