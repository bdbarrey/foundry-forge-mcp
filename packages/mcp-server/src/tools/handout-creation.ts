import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';
import { ErrorHandler } from '../utils/error-handler.js';

export interface HandoutToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

/**
 * Player-handout pipeline: image-page JournalEntry creation + scene-note
 * placement so a generated scene can be dropped onto a map and revealed at
 * the table.
 *
 * Pairs with cos-pipeline scene generation (Forge-uploaded PNG) but is
 * generic — any Foundry-fetchable URL works.
 */
export class HandoutTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundryClient, logger }: HandoutToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'HandoutTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'create-handout-journal',
        description: 'Create a player-handout JournalEntry: one image page pointing at a Foundry-fetchable URL (Forge CDN, world asset, etc.), optional DM-only text page, optional flat folder. Defaults to GM-only ownership; pass playersCanSee=true to pre-share or use the returned journalId with place-scene-journal-note to drop a note on a map and reveal at the table via "Show to Players".',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Journal entry title (also used as the image page name).',
            },
            imageUrl: {
              type: 'string',
              description: 'URL Foundry can fetch the image from (Forge CDN URL, world-relative path, etc.).',
            },
            folderName: {
              type: 'string',
              description: 'Optional flat folder name (e.g. "Arc D - St Andrals Feast"). Created if missing.',
            },
            dmNote: {
              type: 'string',
              description: 'Optional DM-only text content (gets a second page named "DM Notes"). Plain text or HTML; not parsed as Markdown.',
            },
            playersCanSee: {
              type: 'boolean',
              description: 'If true, default ownership = OBSERVER (2) so all players see it. Default false (GM-only; reveal via "Show to Players" or by placing a scene note).',
            },
          },
          required: ['name', 'imageUrl'],
        },
      },
      {
        name: 'place-scene-journal-note',
        description: 'Drop a journal note (Note document) on a scene that links to an existing JournalEntry. Use after create-handout-journal so the DM can right-click → Show to Players at the table. If x/y are omitted the note lands at scene center.',
        inputSchema: {
          type: 'object',
          properties: {
            journalId: {
              type: 'string',
              description: 'JournalEntry ID to link the note to (returned by create-handout-journal).',
            },
            sceneId: {
              type: 'string',
              description: 'Scene ID to drop the note onto. Either sceneId or sceneName is required.',
            },
            sceneName: {
              type: 'string',
              description: 'Scene name (case-insensitive exact match). Used if sceneId omitted. Either sceneId or sceneName is required.',
            },
            pageId: {
              type: 'string',
              description: 'Optional JournalEntryPage ID. If omitted, links to the entry\'s first image page (or first page if none are images).',
            },
            x: {
              type: 'number',
              description: 'Scene-pixel X coordinate. Defaults to scene center.',
            },
            y: {
              type: 'number',
              description: 'Scene-pixel Y coordinate. Defaults to scene center.',
            },
            label: {
              type: 'string',
              description: 'Note label shown on the map. Defaults to the journal entry name.',
            },
            iconSize: {
              type: 'number',
              description: 'Note icon size in scene pixels. Default 40.',
            },
            icon: {
              type: 'string',
              description: 'Note icon path. Default "icons/svg/book.svg".',
            },
          },
          required: ['journalId'],
        },
      },
    ];
  }

  async handleCreateHandoutJournal(args: any): Promise<any> {
    try {
      const requestSchema = z.object({
        name: z.string().min(1, 'name is required'),
        imageUrl: z.string().min(1, 'imageUrl is required'),
        folderName: z.string().optional(),
        dmNote: z.string().optional(),
        playersCanSee: z.boolean().optional(),
      });

      const request = requestSchema.parse(args);

      const result = await this.foundryClient.query('foundry-forge-mcp.createImageJournal', {
        name: request.name,
        imageUrl: request.imageUrl,
        folderName: request.folderName,
        dmNote: request.dmNote,
        playersCanSee: request.playersCanSee,
      });

      if (!result || result.error) {
        throw new Error(result?.error || 'Failed to create handout journal');
      }

      return {
        success: true,
        journalId: result.id,
        journalName: result.name,
        folderId: result.folderId,
        pageCount: result.pageCount,
        message: `Handout "${request.name}" created${request.folderName ? ` in folder "${request.folderName}"` : ''}.`,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'create-handout-journal', 'handout journal creation');
    }
  }

  async handlePlaceSceneJournalNote(args: any): Promise<any> {
    try {
      const requestSchema = z
        .object({
          journalId: z.string().min(1, 'journalId is required'),
          sceneId: z.string().optional(),
          sceneName: z.string().optional(),
          pageId: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          label: z.string().optional(),
          iconSize: z.number().int().positive().optional(),
          icon: z.string().optional(),
        })
        .refine((d) => !!d.sceneId || !!d.sceneName, {
          message: 'Either sceneId or sceneName is required',
        });

      const request = requestSchema.parse(args);

      const result = await this.foundryClient.query('foundry-forge-mcp.placeSceneJournalNote', {
        journalId: request.journalId,
        sceneId: request.sceneId,
        sceneName: request.sceneName,
        pageId: request.pageId,
        x: request.x,
        y: request.y,
        label: request.label,
        iconSize: request.iconSize,
        icon: request.icon,
      });

      if (!result || result.error) {
        throw new Error(result?.error || 'Failed to place scene journal note');
      }

      return {
        success: true,
        noteId: result.noteId,
        sceneId: result.sceneId,
        sceneName: result.sceneName,
        journalId: result.journalId,
        pageId: result.pageId,
        x: result.x,
        y: result.y,
        message: `Note for "${result.journalName}" placed on scene "${result.sceneName}" at (${result.x}, ${result.y}). Right-click the note → Show Players to reveal at the table.`,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'place-scene-journal-note', 'placing scene journal note');
    }
  }
}
