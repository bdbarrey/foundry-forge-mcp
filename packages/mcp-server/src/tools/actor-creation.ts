import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';
import { ErrorHandler } from '../utils/error-handler.js';

export interface ActorCreationToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}


export class ActorCreationTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundryClient, logger }: ActorCreationToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'ActorCreationTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  /**
   * Tool definitions for actor creation operations
   */
  getToolDefinitions() {
    return [
      {
        name: 'create-actor-from-compendium',
        description: 'Create one or more actors from a specific compendium entry with custom names. Use search-compendium first to find the exact creature you want, then use this tool with the packId and itemId from the search results.',
        inputSchema: {
          type: 'object',
          properties: {
            packId: {
              type: 'string',
              description: 'ID of the compendium pack containing the creature (e.g., "dnd5e.monsters")',
            },
            itemId: {
              type: 'string', 
              description: 'ID of the specific creature entry within the pack (get this from search-compendium results)',
            },
            names: {
              type: 'array',
              items: { type: 'string' },
              description: 'Custom names for the created actors (e.g., ["Flameheart", "Sneak", "Peek"])',
              minItems: 1,
            },
            quantity: {
              type: 'number',
              description: 'Number of actors to create (default: based on names array length)',
              minimum: 1,
              maximum: 10,
            },
            addToScene: {
              type: 'boolean',
              description: 'Whether to add created actors to the current scene as tokens',
              default: false,
            },
            placement: {
              type: 'object',
              description: 'Token placement options (only used when addToScene is true)',
              properties: {
                type: {
                  type: 'string',
                  enum: ['random', 'grid', 'center', 'coordinates'],
                  description: 'Placement strategy',
                  default: 'grid',
                },
                coordinates: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      x: { type: 'number', description: 'X coordinate in pixels' },
                      y: { type: 'number', description: 'Y coordinate in pixels' },
                    },
                    required: ['x', 'y'],
                  },
                  description: 'Specific coordinates for each token (required when type is "coordinates")',
                },
              },
              required: ['type'],
            },
          },
          required: ['packId', 'itemId', 'names'],
        },
      },
      {
        name: 'get-compendium-entry-full',
        description: 'Retrieve complete stat block data including items, spells, and abilities for actor creation',
        inputSchema: {
          type: 'object',
          properties: {
            packId: {
              type: 'string',
              description: 'Compendium pack identifier',
            },
            entryId: {
              type: 'string',
              description: 'Entry identifier within the pack',
            },
          },
          required: ['packId', 'entryId'],
        },
      },
      {
        name: 'duplicate-actor',
        description: 'Duplicate an existing actor into a target folder. Use this to copy actors from one folder (e.g., "Clay Golem") to another (e.g., "My NPCs"). Optionally rename the copy.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceActorId: {
              type: 'string',
              description: 'ID of the actor to duplicate (use this or sourceActorName)',
            },
            sourceActorName: {
              type: 'string',
              description: 'Name of the actor to duplicate (use this or sourceActorId)',
            },
            newName: {
              type: 'string',
              description: 'Optional new name for the duplicated actor. If omitted, keeps the original name.',
            },
            targetFolder: {
              type: 'string',
              description: 'Name of the folder to place the duplicate in (created if it does not exist)',
            },
          },
          required: ['targetFolder'],
        },
      },
      {
        name: 'upload-actor-image',
        description: 'Upload a base64-encoded image to Foundry and optionally apply it as an actor\'s portrait and token image.',
        inputSchema: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'Filename for the uploaded image (e.g., "Izek_Strazni.png")',
            },
            imageData: {
              type: 'string',
              description: 'Base64-encoded image data (PNG, JPEG, or WebP)',
            },
            actorId: {
              type: 'string',
              description: 'Optional actor ID to apply the image to as portrait and token',
            },
          },
          required: ['filename', 'imageData'],
        },
      },
      {
        name: 'update-actor',
        description: 'Update an existing actor\'s data using Foundry dot-notation. Can update any actor field including system data, HP, AC, abilities, etc.',
        inputSchema: {
          type: 'object',
          properties: {
            actorId: {
              type: 'string',
              description: 'ID of the actor to update (use this or actorName)',
            },
            actorName: {
              type: 'string',
              description: 'Name of the actor to update (use this or actorId)',
            },
            updates: {
              type: 'object',
              description: 'Object with Foundry dot-notation keys and values to update. Example: {"system.attributes.hp.max": 45, "system.abilities.str.value": 18}',
            },
          },
          required: ['updates'],
        },
      },
      {
        name: 'set-actor-image',
        description: 'Set an actor\'s portrait (img) and prototype token texture to the given URL. Use this after uploading an NPC portrait to Forge to wire the CDN URL onto the Foundry actor in one call.',
        inputSchema: {
          type: 'object',
          properties: {
            actorId: { type: 'string', description: 'ID of the actor (use this or actorName)' },
            actorName: { type: 'string', description: 'Name of the actor (use this or actorId)' },
            imageUrl: { type: 'string', description: 'URL or Foundry-relative path to the image (e.g., "https://assets.forge-vtt.com/.../Doru.png")' },
            applyToToken: { type: 'boolean', description: 'Also set prototypeToken.texture.src (default: true)', default: true },
          },
          required: ['imageUrl'],
        },
      },
      {
        name: 'add-actor-items',
        description: 'Add one or more items (features, spells, equipment) to an existing actor via createEmbeddedDocuments. Use when Reloaded adds features or spells not present on the base creature.',
        inputSchema: {
          type: 'object',
          properties: {
            actorId: { type: 'string', description: 'ID of the actor (use this or actorName)' },
            actorName: { type: 'string', description: 'Name of the actor (use this or actorId)' },
            items: {
              type: 'array',
              description: 'Array of full Foundry item documents. Each must include name, type, and system data. Example: [{"name":"Rampage","type":"feat","system":{...}}]',
              items: { type: 'object' },
              minItems: 1,
            },
          },
          required: ['items'],
        },
      },
      {
        name: 'update-actor-items',
        description: 'Update one or more existing items on an actor via updateEmbeddedDocuments. Use for damage formula tweaks, description edits, feature text changes. Each update must include the item _id.',
        inputSchema: {
          type: 'object',
          properties: {
            actorId: { type: 'string', description: 'ID of the actor (use this or actorName)' },
            actorName: { type: 'string', description: 'Name of the actor (use this or actorId)' },
            updates: {
              type: 'array',
              description: 'Array of partial item docs. Each must include _id. Example: [{"_id":"abc123","system.damage.parts":[["2d8+3","slashing"]]}]',
              items: { type: 'object' },
              minItems: 1,
            },
          },
          required: ['updates'],
        },
      },
      {
        name: 'remove-actor-items',
        description: 'Remove one or more items from an actor via deleteEmbeddedDocuments. Use when Reloaded replaces baseline features with new ones.',
        inputSchema: {
          type: 'object',
          properties: {
            actorId: { type: 'string', description: 'ID of the actor (use this or actorName)' },
            actorName: { type: 'string', description: 'Name of the actor (use this or actorId)' },
            itemIds: {
              type: 'array',
              description: 'Array of item _ids to delete from the actor',
              items: { type: 'string' },
              minItems: 1,
            },
          },
          required: ['itemIds'],
        },
      },
    ];
  }

  /**
   * Handle actor creation from specific compendium entry
   */
  async handleCreateActorFromCompendium(args: any): Promise<any> {
    const schema = z.object({
      packId: z.string().min(1, 'Pack ID cannot be empty'),
      itemId: z.string().min(1, 'Item ID cannot be empty'),
      names: z.array(z.string().min(1)).min(1, 'At least one name is required'),
      quantity: z.number().min(1).max(10).optional(),
      addToScene: z.boolean().default(false),
      placement: z.object({
        type: z.enum(['random', 'grid', 'center', 'coordinates']).default('grid'),
        coordinates: z.array(z.object({
          x: z.number(),
          y: z.number(),
        })).optional(),
      }).optional(),
    });

    const { packId, itemId, names, quantity, addToScene, placement } = schema.parse(args);
    const finalQuantity = quantity || names.length;

    this.logger.info('Creating actors from specific compendium entry', {
      packId,
      itemId,
      names,
      quantity: finalQuantity,
      addToScene,
    });

    try {
      // Ensure we have enough names for the quantity
      const customNames = [...names];
      while (customNames.length < finalQuantity) {
        const baseName = names[0] || 'Unnamed';
        customNames.push(`${baseName} ${customNames.length + 1}`);
      }

      // Create the actors via Foundry module using exact pack/item IDs
      const result = await this.foundryClient.query('foundry-forge-mcp.createActorFromCompendium', {
        packId,
        itemId,
        customNames: customNames.slice(0, finalQuantity),
        quantity: finalQuantity,
        addToScene,
        placement: placement ? {
          type: placement.type,
          coordinates: placement.coordinates,
        } : undefined,
      });

      this.logger.info('Actor creation completed', {
        totalCreated: result.totalCreated,
        totalRequested: result.totalRequested,
        tokensPlaced: result.tokensPlaced || 0,
        hasErrors: !!result.errors,
      });

      // Format response for Claude
      return this.formatSimpleActorCreationResponse(result, packId, itemId, customNames.slice(0, finalQuantity));

    } catch (error) {
      this.errorHandler.handleToolError(error, 'create-actor-from-compendium', 'actor creation');
    }
  }

  /**
   * Handle getting full compendium entry data
   */
  async handleGetCompendiumEntryFull(args: any): Promise<any> {
    const schema = z.object({
      packId: z.string().min(1, 'Pack ID cannot be empty'),
      entryId: z.string().min(1, 'Entry ID cannot be empty'),
    });

    const { packId, entryId } = schema.parse(args);

    this.logger.info('Getting full compendium entry', { packId, entryId });

    try {
      const fullEntry = await this.foundryClient.query('foundry-forge-mcp.getCompendiumDocumentFull', {
        packId,
        documentId: entryId,
      });

      this.logger.debug('Successfully retrieved full compendium entry', {
        packId,
        entryId,
        name: fullEntry.name,
        hasItems: !!fullEntry.items?.length,
        hasEffects: !!fullEntry.effects?.length,
      });

      return this.formatCompendiumEntryResponse(fullEntry);

    } catch (error) {
      this.errorHandler.handleToolError(error, 'get-compendium-entry-full', 'compendium retrieval');
    }
  }








  /**
   * Handle duplicating an actor into a target folder
   */
  async handleDuplicateActor(args: any): Promise<any> {
    const schema = z.object({
      sourceActorId: z.string().optional(),
      sourceActorName: z.string().optional(),
      newName: z.string().optional(),
      targetFolder: z.string().min(1, 'Target folder name is required'),
    }).refine(data => data.sourceActorId || data.sourceActorName, {
      message: 'Either sourceActorId or sourceActorName is required',
    });

    const validated = schema.parse(args);

    this.logger.info('Duplicating actor', {
      source: validated.sourceActorId || validated.sourceActorName,
      targetFolder: validated.targetFolder,
      newName: validated.newName,
    });

    try {
      const result = await this.foundryClient.query('foundry-forge-mcp.duplicateActor', validated);

      if (!result.success) {
        throw new Error(result.error || 'Failed to duplicate actor');
      }

      return {
        success: true,
        actorId: result.actorId,
        actorName: result.actorName,
        message: `Duplicated actor as "${result.actorName}" (${result.actorId}) into folder "${validated.targetFolder}"`,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'duplicate-actor', 'actor duplication');
    }
  }

  /**
   * Handle uploading an image for an actor
   */
  async handleUploadActorImage(args: any): Promise<any> {
    const schema = z.object({
      filename: z.string().min(1, 'Filename is required'),
      imageData: z.string().min(1, 'Image data is required'),
      actorId: z.string().optional(),
    });

    const validated = schema.parse(args);

    this.logger.info('Uploading actor image', {
      filename: validated.filename,
      imageDataLength: validated.imageData.length,
      actorId: validated.actorId,
    });

    try {
      const result = await this.foundryClient.query('foundry-forge-mcp.uploadActorImage', validated);

      if (!result.success) {
        throw new Error(result.error || 'Failed to upload actor image');
      }

      return {
        success: true,
        path: result.path,
        filename: result.filename,
        actorUpdated: result.actorUpdated,
        message: result.message,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'upload-actor-image', 'actor image upload');
    }
  }

  /**
   * Handle updating an actor's data
   */
  async handleUpdateActor(args: any): Promise<any> {
    const schema = z.object({
      actorId: z.string().optional(),
      actorName: z.string().optional(),
      updates: z.record(z.any()).refine(obj => Object.keys(obj).length > 0, {
        message: 'At least one update field is required',
      }),
    }).refine(data => data.actorId || data.actorName, {
      message: 'Either actorId or actorName is required',
    });

    const validated = schema.parse(args);

    this.logger.info('Updating actor', {
      actor: validated.actorId || validated.actorName,
      updateFields: Object.keys(validated.updates),
    });

    try {
      const result = await this.foundryClient.query('foundry-forge-mcp.updateActorData', validated);

      if (!result.success) {
        throw new Error(result.error || 'Failed to update actor');
      }

      return {
        success: true,
        actorId: result.actorId,
        actorName: result.actorName,
        updatedFields: result.updatedFields,
        message: `Updated ${result.updatedFields.length} field(s) on "${result.actorName}"`,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'update-actor', 'actor update');
    }
  }

  /**
   * Handle setting an actor's image (portrait + token) from a URL
   */
  async handleSetActorImage(args: any): Promise<any> {
    const schema = z.object({
      actorId: z.string().optional(),
      actorName: z.string().optional(),
      imageUrl: z.string().min(1, 'imageUrl is required'),
      applyToToken: z.boolean().default(true),
    }).refine(data => data.actorId || data.actorName, {
      message: 'Either actorId or actorName is required',
    });

    const validated = schema.parse(args);
    const updates: Record<string, any> = { img: validated.imageUrl };
    if (validated.applyToToken) {
      updates['prototypeToken.texture.src'] = validated.imageUrl;
    }

    this.logger.info('Setting actor image', {
      actor: validated.actorId || validated.actorName,
      imageUrl: validated.imageUrl,
      applyToToken: validated.applyToToken,
    });

    try {
      const result = await this.foundryClient.query('foundry-forge-mcp.updateActorData', {
        actorId: validated.actorId,
        actorName: validated.actorName,
        updates,
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to set actor image');
      }

      return {
        success: true,
        actorId: result.actorId,
        actorName: result.actorName,
        imageUrl: validated.imageUrl,
        tokenUpdated: validated.applyToToken,
        message: `Set image on "${result.actorName}" to ${validated.imageUrl}`,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'set-actor-image', 'actor image update');
    }
  }

  /**
   * Handle adding items to an actor
   */
  async handleAddActorItems(args: any): Promise<any> {
    const schema = z.object({
      actorId: z.string().optional(),
      actorName: z.string().optional(),
      items: z.array(z.record(z.any())).min(1, 'At least one item is required'),
    }).refine(data => data.actorId || data.actorName, {
      message: 'Either actorId or actorName is required',
    });

    const validated = schema.parse(args);

    this.logger.info('Adding items to actor', {
      actor: validated.actorId || validated.actorName,
      itemCount: validated.items.length,
    });

    try {
      const result = await this.foundryClient.query('foundry-forge-mcp.addActorItems', validated);
      if (!result.success) {
        throw new Error(result.error || 'Failed to add items');
      }
      return {
        success: true,
        actorId: result.actorId,
        actorName: result.actorName,
        added: result.added,
        message: `Added ${result.added.length} item(s) to "${result.actorName}"`,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'add-actor-items', 'add actor items');
    }
  }

  /**
   * Handle updating items on an actor
   */
  async handleUpdateActorItems(args: any): Promise<any> {
    const schema = z.object({
      actorId: z.string().optional(),
      actorName: z.string().optional(),
      updates: z.array(z.record(z.any())).min(1, 'At least one update is required'),
    }).refine(data => data.actorId || data.actorName, {
      message: 'Either actorId or actorName is required',
    });

    const validated = schema.parse(args);

    for (const upd of validated.updates) {
      if (!upd._id) {
        throw new Error('Each update entry must include `_id` (item id)');
      }
    }

    this.logger.info('Updating items on actor', {
      actor: validated.actorId || validated.actorName,
      updateCount: validated.updates.length,
    });

    try {
      const result = await this.foundryClient.query('foundry-forge-mcp.updateActorItems', validated);
      if (!result.success) {
        throw new Error(result.error || 'Failed to update items');
      }
      return {
        success: true,
        actorId: result.actorId,
        actorName: result.actorName,
        updated: result.updated,
        message: `Updated ${result.updated.length} item(s) on "${result.actorName}"`,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'update-actor-items', 'update actor items');
    }
  }

  /**
   * Handle removing items from an actor
   */
  async handleRemoveActorItems(args: any): Promise<any> {
    const schema = z.object({
      actorId: z.string().optional(),
      actorName: z.string().optional(),
      itemIds: z.array(z.string()).min(1, 'At least one itemId is required'),
    }).refine(data => data.actorId || data.actorName, {
      message: 'Either actorId or actorName is required',
    });

    const validated = schema.parse(args);

    this.logger.info('Removing items from actor', {
      actor: validated.actorId || validated.actorName,
      itemCount: validated.itemIds.length,
    });

    try {
      const result = await this.foundryClient.query('foundry-forge-mcp.removeActorItems', validated);
      if (!result.success) {
        throw new Error(result.error || 'Failed to remove items');
      }
      return {
        success: true,
        actorId: result.actorId,
        actorName: result.actorName,
        removed: result.removed,
        message: `Removed ${result.removed.length} item(s) from "${result.actorName}"`,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'remove-actor-items', 'remove actor items');
    }
  }

  /**
   * Format compendium entry response
   */
  private formatCompendiumEntryResponse(entry: any): any {
    const itemsInfo = entry.items?.length > 0 
      ? `\n📦 Items: ${entry.items.map((item: any) => item.name).join(', ')}`
      : '';
    
    const effectsInfo = entry.effects?.length > 0
      ? `\n✨ Effects: ${entry.effects.map((effect: any) => effect.name).join(', ')}`
      : '';

    return {
      name: entry.name,
      type: entry.type,
      pack: entry.packLabel,
      system: entry.system,
      fullData: entry.fullData,
      items: entry.items || [],
      effects: entry.effects || [],
      summary: `📊 **${entry.name}** (${entry.type} from ${entry.packLabel})${itemsInfo}${effectsInfo}`,
    };
  }

  /**
   * Format simplified actor creation response
   */
  private formatSimpleActorCreationResponse(result: any, packId: string, itemId: string, customNames: string[]): any {
    const summary = `✅ Created ${result.totalCreated} of ${result.totalRequested} requested actors`;
    
    const details = result.actors.map((actor: any) => 
      `• **${actor.name}** (from ${packId})`
    ).join('\n');

    const sceneInfo = result.tokensPlaced > 0 
      ? `\n🎯 Added ${result.tokensPlaced} tokens to the current scene`
      : '';

    const errorInfo = result.errors?.length > 0
      ? `\n⚠️ Issues: ${result.errors.join(', ')}`
      : '';

    return {
      summary,
      success: result.success,
      details: {
        actors: result.actors,
        sourceEntry: {
          packId,
          itemId,
        },
        tokensPlaced: result.tokensPlaced || 0,
        errors: result.errors,
      },
      message: summary + '\n\n' + details + sceneInfo + errorInfo,
    };
  }
}