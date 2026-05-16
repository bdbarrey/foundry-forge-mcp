import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface FoldersToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

export class FoldersTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: FoldersToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'FoldersTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'list-folders',
        description: 'List Actor folders in the world. Returns a flat array of folders with id, name, full slash-path, parent info, depth, actor count, and child folder ids. Use this to programmatically discover folder structure (e.g., before creating an actor in "02 - My Actors/Monsters") instead of opening Foundry visually.',
        inputSchema: {
          type: 'object',
          properties: {
            subtree: {
              type: 'string',
              description: 'Optional path prefix to scope the response (e.g., "02 - My Actors"). Returns the matching folder and all descendants. Case-insensitive.',
            },
            page: {
              type: 'number',
              description: 'Page number (1-indexed). Required when pageSize > 0.',
            },
            pageSize: {
              type: 'number',
              description: 'Page size. Omit or 0 = return all folders (legacy behavior). Set >0 to paginate; the response gains page/pageSize/totalPages/hasMore fields.',
            },
          },
        },
      },
    ];
  }

  async handleListFolders(args: any): Promise<any> {
    const schema = z.object({
      subtree: z.string().optional(),
      page: z.number().optional(),
      pageSize: z.number().optional(),
    });

    const { subtree, page, pageSize } = schema.parse(args);

    this.logger.info('Listing actor folders', { subtree, page, pageSize });

    try {
      const queryArgs: { subtree?: string; page?: number; pageSize?: number } = {};
      if (subtree) queryArgs.subtree = subtree;
      if (typeof page === 'number' && page > 0) queryArgs.page = page;
      if (typeof pageSize === 'number' && pageSize > 0) queryArgs.pageSize = pageSize;

      const result = await this.foundryClient.query('foundry-forge-mcp.listActorFolders', queryArgs);

      this.logger.debug('Successfully retrieved folder list', { count: result?.total ?? 0 });

      const out: any = {
        folders: result?.folders ?? [],
        total: result?.total ?? 0,
        scopedTo: subtree ?? 'all',
      };
      if (typeof result?.page === 'number') {
        out.page = result.page;
        out.pageSize = result.pageSize;
        out.totalPages = result.totalPages;
        out.hasMore = result.hasMore;
      }
      return out;
    } catch (error) {
      this.logger.error('Failed to list actor folders', error);
      throw new Error(`Failed to list actor folders: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
