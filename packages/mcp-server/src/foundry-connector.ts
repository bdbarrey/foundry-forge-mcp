import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { Logger } from './logger.js';
import { Config } from './config.js';
import { WebRTCPeer } from './webrtc-peer.js';

export interface FoundryConnectorOptions {
  config: Config['foundry'];
  logger: Logger;
}

interface PendingQuery {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class FoundryConnector {
  private wss: WebSocketServer | null = null;
  private httpServer: any;
  private webrtcSignalingServer: any; // Separate HTTP server for WebRTC signaling
  private logger: Logger;
  private config: Config['foundry'];
  private isStarted = false;
  private foundrySocket: WebSocket | null = null;
  private webrtcPeer: WebRTCPeer | null = null;
  private activeConnectionType: 'websocket' | 'webrtc' | null = null;
  private pendingQueries = new Map<string, PendingQuery>();
  private queryIdCounter = 0;

  constructor({ config, logger }: FoundryConnectorOptions) {
    this.config = config;
    this.logger = logger.child({ component: 'FoundryConnector' });
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.debug('Foundry connector already started');
      return;
    }

    this.logger.info('Starting Foundry connector WebSocket server', {
      port: this.config.port,
      protocol: this.config.protocol || 'ws',
      remoteMode: this.config.remoteMode || false
    });

    // Create HTTP server for WebSocket connections
    this.httpServer = createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });

    // Create SEPARATE HTTP server for WebRTC signaling (port 31416)
    const WEBRTC_PORT = 31416;
    this.webrtcSignalingServer = createServer(async (req, res) => {
      // Set CORS headers for all requests
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      // Handle OPTIONS preflight
      if (req.method === 'OPTIONS') {
        // Chrome Private Network Access: allow HTTPS pages to reach private/loopback addresses
        if (req.headers['access-control-request-private-network'] === 'true') {
          res.setHeader('Access-Control-Allow-Private-Network', 'true');
        }
        res.writeHead(204);
        res.end();
        return;
      }

      // Only handle POST to /webrtc-offer
      if (req.method === 'POST' && req.url === '/webrtc-offer') {
        try {
          await this.handleWebRTCOfferHTTP(req, res);
        } catch (error) {
          this.logger.error('WebRTC offer handling failed', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    // Start WebRTC signaling server
    await new Promise<void>((resolve, reject) => {
      this.webrtcSignalingServer.listen(WEBRTC_PORT, '::', () => {
        this.logger.info(`WebRTC signaling server listening on port ${WEBRTC_PORT}`);
        console.error(`[WebRTC] Server started on 0.0.0.0:${WEBRTC_PORT}`);
        resolve();
      });
      this.webrtcSignalingServer.on('error', (error: Error) => {
        this.logger.error('Failed to start WebRTC signaling server', error);
        console.error(`[WebRTC] Server error:`, error);
        reject(error);
      });
    });

    // Create WebSocket server in noServer mode to avoid request consumption
    this.wss = new WebSocketServer({ noServer: true });

    // Manually handle upgrade for WebSocket connections
    this.httpServer.on('upgrade', (req: any, socket: any, head: any) => {
      const pathname = req.url || '/';

      // Only upgrade if path matches WebSocket namespace
      if (pathname === (this.config.namespace || '/')) {
        this.wss?.handleUpgrade(req, socket, head, (ws) => {
          this.wss?.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    // Handle WebSocket connections (both signaling and direct WebSocket)
    this.wss.on('connection', (ws) => {
      this.logger.info('Client connected via WebSocket');

      // Register the connection immediately on connect, not on first message
      // This fixes Issue #19: WebSocket handshake deadlock where both sides
      // waited for the other to send a message first
      if (!this.foundrySocket) {
        this.foundrySocket = ws;
        this.activeConnectionType = 'websocket';
        this.logger.info('Foundry module registered via WebSocket');
      }

      ws.on('close', () => {
        this.logger.info('Client disconnected');
        if (this.activeConnectionType === 'websocket' && this.foundrySocket === ws) {
          this.foundrySocket = null;
          this.activeConnectionType = null;
          // Reject all pending queries
          this.pendingQueries.forEach(({ reject, timeout }) => {
            clearTimeout(timeout);
            reject(new Error('Connection closed'));
          });
          this.pendingQueries.clear();
        }
      });

      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());

          // Check if this is WebRTC signaling
          if (message.type === 'webrtc-offer') {
            await this.handleWebRTCOffer(message.offer, ws);
          } else {
            // Regular WebSocket message - process it directly
            await this.handleMessage(message);
          }
        } catch (error) {
          this.logger.error('Failed to parse message', error);
        }
      });

      ws.on('error', (error) => {
        this.logger.error('WebSocket error', error);
      });
    });

    // Start the HTTP server
    await new Promise<void>((resolve, reject) => {
      this.httpServer.listen(this.config.port, () => {
        this.isStarted = true;
        this.logger.info('Foundry connector listening', { port: this.config.port });
        resolve();
      });

      this.httpServer.on('error', (error: Error) => {
        this.logger.error('Failed to start Foundry connector', error);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.isStarted) {
      return;
    }

    this.logger.info('Stopping Foundry connector...');

    // Reject all pending queries
    this.pendingQueries.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error('Server shutting down'));
    });
    this.pendingQueries.clear();

    if (this.foundrySocket) {
      this.foundrySocket.close();
      this.foundrySocket = null;
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer.close(() => {
          resolve();
        });
      });
      this.httpServer = null;
    }

    this.isStarted = false;
    this.logger.info('Foundry connector stopped');
  }

  private async handleMessage(message: any): Promise<void> {
    if (message.type === 'mcp-response' && message.id) {
      const pending = this.pendingQueries.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingQueries.delete(message.id);

        if (message.data.success) {
          this.logger.debug('Query response received', { id: message.id, hasData: !!message.data.data });
          pending.resolve(message.data.data);
        } else {
          this.logger.error('Query failed', { id: message.id, error: message.data.error });
          pending.reject(new Error(message.data.error || 'Query failed'));
        }
      }
      return;
    }

    if (message.type === 'pong') {
      const pending = this.pendingQueries.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingQueries.delete(message.id);
        pending.resolve(message.data);
      }
      return;
    }

    const comfyHandlers = (globalThis as any).backendComfyUIHandlers;
    if (comfyHandlers?.handleMessage) {
      this.logger.debug('Routing message to backend ComfyUI handlers', { type: message.type });
      try {
        await comfyHandlers.handleMessage(message);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('Failed to forward message to backendComfyUIHandlers', {
          type: message.type,
          error: errorMessage
        });
      }
      return;
    }

    this.logger.debug('Received unknown message type', { type: message.type });
  }

  private async handleWebRTCOffer(offer: any, signalingWs: WebSocket): Promise<void> {
    try {
      this.logger.info('Handling WebRTC offer for signaling');

      // Create WebRTC peer
      this.webrtcPeer = new WebRTCPeer({
        config: this.config.webrtc,
        logger: this.logger,
        onMessage: this.handleMessage.bind(this)
      });

      // Handle offer and get answer
      const answer = await this.webrtcPeer.handleOffer(offer);

      // Send answer back via signaling WebSocket
      signalingWs.send(JSON.stringify({
        type: 'webrtc-answer',
        answer: answer
      }));

      this.activeConnectionType = 'webrtc';
      this.logger.info('WebRTC connection established');

      // Close signaling WebSocket after handshake
      setTimeout(() => {
        signalingWs.close();
      }, 1000);

    } catch (error) {
      this.logger.error('Failed to handle WebRTC offer', error);
      signalingWs.send(JSON.stringify({
        type: 'webrtc-error',
        error: error instanceof Error ? error.message : 'Unknown error'
      }));
    }
  }

  private async handleWebRTCOfferHTTP(req: any, res: any): Promise<void> {
    // CRITICAL: Call resume() to enable stream data flow
    req.resume();

    try {
      // Read body using promise wrapper around classic events
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];

        req.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        req.on('end', () => {
          resolve(Buffer.concat(chunks).toString());
        });

        req.on('error', reject);
      });

      const { offer } = JSON.parse(body);

      if (!offer) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing offer in request body' }));
        return;
      }

      // Create WebRTC peer
      this.webrtcPeer = new WebRTCPeer({
        config: this.config.webrtc,
        logger: this.logger,
        onMessage: this.handleMessage.bind(this)
      });

      // Handle offer and get answer
      const answer = await this.webrtcPeer.handleOffer(offer);

      this.activeConnectionType = 'webrtc';
      this.logger.info('WebRTC connection established via HTTP signaling');

      // Send answer back via HTTP response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answer }));

    } catch (error) {
      this.logger.error('Failed to handle WebRTC offer via HTTP', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error'
      }));
    }
  }

  /**
   * Per-query timeout, in ms. Bumped from 10s → 60s in v0.1.18 — list-scenes
   * on Beneos-loaded CoS worlds can take 15+ seconds to build + serialize, and
   * the old 10s timeout would fire mid-write, leaving Foundry to flush a giant
   * orphan response that pressured the WS buffer and dropped the socket.
   */
  private static readonly QUERY_TIMEOUT_MS = 60000;

  /**
   * v0.1.19: how long to wait for the Foundry module's auto-reconnect logic
   * to bring the WebSocket back before failing a query. The module-side
   * (socket-bridge.ts → scheduleReconnect) uses exponential backoff capped at
   * 30s, so 35s here covers a full reconnect cycle. Observed in production:
   * sustained moderate-payload reads (20+ audit-actor calls in sequence) can
   * occasionally drop the socket without warning; the module reconnects on
   * its own, but the next mcp-server query that arrives during the gap used
   * to throw immediately. Waiting briefly lets transient disconnects heal
   * transparently — agent workflows don't have to be babysat with refreshes.
   */
  private static readonly WAIT_FOR_RECONNECT_MS = 35000;
  private static readonly RECONNECT_POLL_INTERVAL_MS = 250;

  /**
   * Returns true if the active transport is reporting a healthy connection.
   * Centralised so query() and waitForReconnect() agree on what "connected"
   * means across both WebSocket and WebRTC paths.
   */
  private isTransportConnected(): boolean {
    if (this.activeConnectionType === 'webrtc') {
      return !!(this.webrtcPeer && this.webrtcPeer.getIsConnected());
    }
    return !!(this.foundrySocket && this.foundrySocket.readyState === WebSocket.OPEN);
  }

  /**
   * Wait up to `timeoutMs` for the transport to become connected again,
   * polling at RECONNECT_POLL_INTERVAL_MS. Returns the final connected state.
   */
  private async waitForReconnect(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.isTransportConnected()) return true;
      await new Promise(r => setTimeout(r, FoundryConnector.RECONNECT_POLL_INTERVAL_MS));
    }
    return this.isTransportConnected();
  }

  async query(method: string, data?: any): Promise<any> {
    // v0.1.19: if disconnected on arrival, give the Foundry-side
    // scheduleReconnect a chance to reach us before failing. Survives
    // transient WS drops from buffer pressure on sustained reads.
    if (!this.isTransportConnected()) {
      this.logger.info('Query arrived while disconnected; waiting for module auto-reconnect', { method });
      const waitStart = Date.now();
      const reconnected = await this.waitForReconnect(FoundryConnector.WAIT_FOR_RECONNECT_MS);
      const waitedMs = Date.now() - waitStart;
      if (!reconnected) {
        throw new Error(`Foundry VTT module not connected (waited ${Math.round(waitedMs / 1000)}s for auto-reconnect; module may be down or browser tab closed)`);
      }
      this.logger.info('Module reconnected; resuming query', { method, waitedMs });
    }

    const queryId = `query-${++this.queryIdCounter}`;
    this.logger.debug('Sending query to Foundry', { method, data, queryId, connectionType: this.activeConnectionType });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingQueries.delete(queryId);
        // Tell Foundry to abandon the work and skip sending the response.
        // Without this, a slow query keeps computing past the timeout and the
        // eventual response (potentially hundreds of KB) lands on a deleted
        // pending-query slot and pressures the WS buffer, sometimes hard
        // enough to drop the socket entirely.
        try {
          this.sendToFoundry({ type: 'mcp-cancel', id: queryId });
        } catch {
          // If the socket is already gone, the cancel can't be delivered;
          // nothing useful to do here — the close handler will reject pending.
        }
        reject(new Error(`Query timeout: ${method}`));
      }, FoundryConnector.QUERY_TIMEOUT_MS);

      this.pendingQueries.set(queryId, { resolve, reject, timeout });

      const message = {
        type: 'mcp-query',
        id: queryId,
        data: { method, data }
      };

      // Use sendToFoundry to support both WebSocket and WebRTC
      this.sendToFoundry(message);
    });
  }

  sendToFoundry(message: any): void {
    if (this.activeConnectionType === 'webrtc' && this.webrtcPeer) {
      this.webrtcPeer.sendMessage(message);
    } else if (this.activeConnectionType === 'websocket' && this.foundrySocket && this.foundrySocket.readyState === WebSocket.OPEN) {
      this.foundrySocket.send(JSON.stringify(message));
    } else {
      throw new Error('Not connected to Foundry VTT module');
    }
  }

  isConnected(): boolean {
    if (!this.isStarted) return false;

    if (this.activeConnectionType === 'webrtc') {
      return this.webrtcPeer !== null && this.webrtcPeer.getIsConnected();
    } else if (this.activeConnectionType === 'websocket') {
      return this.foundrySocket !== null && this.foundrySocket.readyState === WebSocket.OPEN;
    }

    return false;
  }

  getConnectionInfo(): any {
    return {
      started: this.isStarted,
      connected: this.isConnected(),
      connectionType: this.activeConnectionType,
      readyState: this.foundrySocket?.readyState || 'CLOSED',
      config: {
        port: this.config.port,
        namespace: this.config.namespace
      }
    };
  }

  getConnectionType(): 'websocket' | 'webrtc' | null {
    return this.activeConnectionType;
  }

  /**
   * Send a message to the connected Foundry module
   */
  sendMessage(message: any): void {
    if (!this.isConnected()) {
      throw new Error('Not connected to Foundry VTT module');
    }

    try {
      this.sendToFoundry(message);
      this.logger.debug('Sent message to Foundry module', { type: message.type, connectionType: this.activeConnectionType });
    } catch (error) {
      this.logger.error('Failed to send message to Foundry module', error);
      throw error;
    }
  }

  /**
   * Broadcast a message to all connected Foundry clients (alias for sendMessage for single connection)
   */
  broadcastMessage(message: any): void {
    this.sendMessage(message);
  }
}