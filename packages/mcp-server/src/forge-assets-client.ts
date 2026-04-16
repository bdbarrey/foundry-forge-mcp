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
          'Authorization': `Bearer ${this.apiKey}`,
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
          'Authorization': `Bearer ${this.apiKey}`,
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
   * Sanitize an NPC name for use as a filename
   */
  static sanitizeFilename(npcName: string): string {
    return npcName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-]/g, '');
  }
}
