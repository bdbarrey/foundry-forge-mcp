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
   * when available, and basename. Tolerant of two known response shapes:
   *   - `files: string[]` (relative paths) + optional `fileURLs: string[]` (parallel)
   *   - `files: { path, url?, name? }[]`
   *
   * Foundry's set-actor-image accepts either form, but full URLs survive
   * cleaner across Forge's CDN re-routing — preferred when present.
   */
  async browseFolder(folder: string): Promise<ForgeAssetEntry[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/assets/browse`, {
        params: { path: folder },
        headers: { 'Authorization': this.apiKey },
        timeout: 15000,
      });

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

      this.logger.info('Browsed Forge folder', {
        folder, fileCount: entries.length,
        urlsAttached: entries.filter(e => e.url).length,
      });
      return entries;
    } catch (error: any) {
      this.logger.error('Failed to browse Forge folder', {
        folder,
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
