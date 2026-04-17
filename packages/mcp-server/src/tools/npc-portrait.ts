import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../logger.js';
import { ComfyUIClient, ComfyUIPortraitInput } from '../comfyui-client.js';
import { ForgeAssetsClient } from '../forge-assets-client.js';
import { FoundryClient } from '../foundry-client.js';

interface PortraitJob {
  id: string;
  status: 'queued' | 'generating' | 'uploading' | 'complete' | 'failed';
  npcName: string;
  description: string;
  comfyuiPromptId?: string;
  createdAt: number;
  result?: {
    forgeUrl: string;
    actorUpdated: boolean;
    generationTimeMs: number;
  };
  error?: string;
}

export interface NpcPortraitToolsOptions {
  logger: Logger;
  comfyuiClient: ComfyUIClient | null;
  forgeAssetsClient: ForgeAssetsClient | null;
  foundryClient: FoundryClient;
}

export class NpcPortraitTools {
  private logger: Logger;
  private comfyuiClient: ComfyUIClient | null;
  private forgeAssetsClient: ForgeAssetsClient | null;
  private foundryClient: FoundryClient;
  private jobs = new Map<string, PortraitJob>();
  private jobIdCounter = 0;

  constructor(options: NpcPortraitToolsOptions) {
    this.logger = options.logger.child({ component: 'NpcPortraitTools' });
    this.comfyuiClient = options.comfyuiClient;
    this.forgeAssetsClient = options.forgeAssetsClient;
    this.foundryClient = options.foundryClient;
  }

  getToolDefinitions(): Tool[] {
    return [
      {
        name: 'generate-npc-portrait',
        description: 'Generate an NPC character portrait using ComfyUI AI image generation. The portrait is uploaded to the Forge asset library and optionally applied to a Foundry actor.',
        inputSchema: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description: 'Physical description of the NPC for portrait generation (e.g., "A tall man with a demonic red arm, dark hair, scarred face, wearing leather armor")',
            },
            npc_name: {
              type: 'string',
              description: 'NPC name (used for filename and tracking)',
            },
            art_style: {
              type: 'string',
              description: 'Art style override (default: "fantasy RPG art, painterly, detailed")',
            },
            quality: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Generation quality (low=fast/8 steps, medium=balanced/20 steps, high=best/35 steps)',
              default: 'medium',
            },
            actor_id: {
              type: 'string',
              description: 'Optional Foundry actor ID to apply the portrait to after generation',
            },
          },
          required: ['description', 'npc_name'],
        },
      },
      {
        name: 'check-portrait-status',
        description: 'Check status of an NPC portrait generation job',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: {
              type: 'string',
              description: 'Portrait generation job ID',
            },
          },
          required: ['job_id'],
        },
      },
      {
        name: 'cancel-portrait-job',
        description: 'Cancel a running NPC portrait generation job',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: {
              type: 'string',
              description: 'Portrait generation job ID to cancel',
            },
          },
          required: ['job_id'],
        },
      },
    ];
  }

  async handleGeneratePortrait(args: any): Promise<any> {
    if (!this.comfyuiClient) {
      return { success: false, error: 'ComfyUI client not initialized. Is ComfyUI installed?' };
    }
    if (!this.forgeAssetsClient) {
      return { success: false, error: 'Forge Assets client not configured. Set FORGE_ASSETS_API_KEY in .env' };
    }

    const description = args.description?.trim();
    const npcName = args.npc_name?.trim();
    if (!description || !npcName) {
      return { success: false, error: 'description and npc_name are required' };
    }

    const jobId = this.generateJobId();
    const job: PortraitJob = {
      id: jobId,
      status: 'queued',
      npcName,
      description,
      createdAt: Date.now(),
    };
    this.jobs.set(jobId, job);

    // Start background generation
    this.processPortraitInBackground(jobId, {
      description,
      artStyle: args.art_style,
      quality: args.quality || 'medium',
    }, npcName, args.actor_id).catch(error => {
      this.logger.error('Background portrait generation failed', { jobId, error });
    });

    return {
      success: true,
      jobId,
      message: `Portrait generation started for "${npcName}". Job ID: ${jobId}. Use check-portrait-status to monitor progress.`,
    };
  }

  async handleCheckPortraitStatus(args: any): Promise<any> {
    const jobId = args.job_id?.trim();
    if (!jobId) {
      return { success: false, error: 'job_id is required' };
    }

    const job = this.jobs.get(jobId);
    if (!job) {
      return { success: false, error: `Job ${jobId} not found` };
    }

    const elapsed = Math.round((Date.now() - job.createdAt) / 1000);

    switch (job.status) {
      case 'queued':
        return { status: 'queued', message: `Portrait for "${job.npcName}" is queued. Elapsed: ${elapsed}s` };
      case 'generating':
        return { status: 'generating', message: `Portrait for "${job.npcName}" is being generated by ComfyUI. Elapsed: ${elapsed}s` };
      case 'uploading':
        return { status: 'uploading', message: `Portrait for "${job.npcName}" generated, uploading to Forge. Elapsed: ${elapsed}s` };
      case 'complete':
        return {
          status: 'complete',
          message: `Portrait for "${job.npcName}" complete.`,
          result: job.result,
        };
      case 'failed':
        return { status: 'failed', message: `Portrait for "${job.npcName}" failed: ${job.error}` };
    }
  }

  async handleCancelPortraitJob(args: any): Promise<any> {
    const jobId = args.job_id?.trim();
    if (!jobId) {
      return { success: false, error: 'job_id is required' };
    }

    const job = this.jobs.get(jobId);
    if (!job) {
      return { success: false, error: `Job ${jobId} not found` };
    }

    if (job.status === 'complete' || job.status === 'failed') {
      return { success: false, error: `Job ${jobId} already ${job.status}` };
    }

    // Try to cancel ComfyUI job
    if (job.comfyuiPromptId && this.comfyuiClient) {
      await this.comfyuiClient.cancelJob(job.comfyuiPromptId);
    }

    job.status = 'failed';
    job.error = 'Cancelled by user';
    return { success: true, message: `Job ${jobId} cancelled` };
  }

  private async processPortraitInBackground(
    jobId: string,
    input: ComfyUIPortraitInput,
    npcName: string,
    actorId?: string,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    try {
      // Ensure ComfyUI is running
      const health = await this.comfyuiClient!.checkHealth();
      if (!health.available) {
        await this.comfyuiClient!.startService();
      }

      // Submit portrait job
      job.status = 'generating';
      const comfyuiJob = await this.comfyuiClient!.submitPortraitJob(input);
      job.comfyuiPromptId = comfyuiJob.prompt_id;

      this.logger.info('Portrait job submitted to ComfyUI', { jobId, promptId: comfyuiJob.prompt_id });

      // Poll for completion
      let status = await this.comfyuiClient!.getJobStatus(comfyuiJob.prompt_id);
      while (status === 'queued' || status === 'running') {
        await new Promise(resolve => setTimeout(resolve, 3000));
        status = await this.comfyuiClient!.getJobStatus(comfyuiJob.prompt_id);
      }

      if (status === 'failed') {
        throw new Error('ComfyUI portrait generation failed');
      }

      // Download generated image
      const imageFilenames = await this.comfyuiClient!.getJobImages(comfyuiJob.prompt_id);
      if (!imageFilenames || imageFilenames.length === 0) {
        throw new Error('No images found in ComfyUI job output');
      }

      const imageBuffer = await this.comfyuiClient!.downloadImage(imageFilenames[0]);
      if (!imageBuffer) {
        throw new Error('Failed to download generated portrait image');
      }

      // Upload to Forge asset library
      job.status = 'uploading';
      const sanitizedName = ForgeAssetsClient.sanitizeFilename(npcName);
      const filename = `${sanitizedName}.png`;

      const uploadResult = await this.forgeAssetsClient!.uploadImage(filename, imageBuffer);

      // If actorId provided, update the actor's portrait and token image
      let actorUpdated = false;
      if (actorId) {
        try {
          await this.foundryClient.query('foundry-forge-mcp.updateActorData', {
            actorId,
            updates: {
              img: uploadResult.url,
              'prototypeToken.texture.src': uploadResult.url,
            },
          });
          actorUpdated = true;
        } catch (error) {
          this.logger.warn('Failed to update actor with portrait', { actorId, error });
        }
      }

      // Mark complete
      job.status = 'complete';
      job.result = {
        forgeUrl: uploadResult.url,
        actorUpdated,
        generationTimeMs: Date.now() - job.createdAt,
      };

      this.logger.info('Portrait generation completed', {
        jobId,
        npcName,
        forgeUrl: uploadResult.url,
        actorUpdated,
        generationTimeMs: job.result.generationTimeMs,
      });

    } catch (error: any) {
      job.status = 'failed';
      job.error = error.message || 'Unknown error';
      this.logger.error('Portrait generation failed', { jobId, npcName, error: job.error });
    }
  }

  private generateJobId(): string {
    this.jobIdCounter++;
    const timestamp = Date.now().toString(36);
    const counter = this.jobIdCounter.toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `portrait_${timestamp}_${counter}_${random}`;
  }
}
