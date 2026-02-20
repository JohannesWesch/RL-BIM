import { WebSocketServer, WebSocket } from "ws";

/**
 * WebSocket bridge between the MCP server (Node.js) and the browser-based
 * BIM viewer. The MCP server can't directly call browser APIs, so this
 * bridge relays JSON-RPC commands to the viewer and returns results.
 *
 * Architecture:
 * - MCP Server spawns a WebSocket server on port 3001
 * - Browser viewer connects as a WebSocket client
 * - MCP tool calls are forwarded to the viewer, results are returned
 */
export class ViewerBridge {
    private wss: WebSocketServer | null = null;
    private viewer: WebSocket | null = null;
    private port: number;
    private requestId = 0;
    private pendingRequests: Map<number, {
        resolve: (value: any) => void;
        reject: (reason: any) => void;
        timeout: NodeJS.Timeout;
    }> = new Map();
    private viewerReadyResolvers: Array<() => void> = [];

    constructor(port: number = 3001) {
        this.port = port;
    }

    async start(): Promise<void> {
        return new Promise((resolve) => {
            this.wss = new WebSocketServer({ port: this.port });

            this.wss.on("connection", (ws) => {
                console.error(`[Bridge] Client connected`);

                ws.on("message", (data) => {
                    try {
                        const msg = JSON.parse(data.toString());

                        // Registration message from viewer
                        if (msg.type === "register" && msg.role === "viewer") {
                            this.viewer = ws;
                            console.error("[Bridge] Viewer registered");
                            // Resolve all waiters
                            for (const resolver of this.viewerReadyResolvers) {
                                resolver();
                            }
                            this.viewerReadyResolvers = [];
                            return;
                        }

                        // Response to a pending request
                        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
                            const pending = this.pendingRequests.get(msg.id)!;
                            clearTimeout(pending.timeout);
                            this.pendingRequests.delete(msg.id);

                            if (msg.error) {
                                pending.reject(new Error(msg.error.message));
                            } else {
                                pending.resolve(msg.result);
                            }
                        }
                    } catch (err) {
                        console.error("[Bridge] Parse error:", err);
                    }
                });

                ws.on("close", () => {
                    if (ws === this.viewer) {
                        this.viewer = null;
                        console.error("[Bridge] Viewer disconnected");
                    }
                });
            });

            this.wss.on("listening", () => {
                console.error(`[Bridge] WebSocket server listening on port ${this.port}`);
                resolve();
            });
        });
    }

    /**
     * Wait for the browser viewer to connect.
     * @param timeoutMs Max time to wait (default: 60s)
     */
    async waitForViewer(timeoutMs: number = 60000): Promise<void> {
        if (this.viewer && this.viewer.readyState === WebSocket.OPEN) {
            return; // Already connected
        }

        console.error(`[Bridge] Waiting for viewer to connect (${timeoutMs / 1000}s timeout)...`);

        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                // Remove resolver from list
                const idx = this.viewerReadyResolvers.indexOf(resolve);
                if (idx !== -1) this.viewerReadyResolvers.splice(idx, 1);
                reject(new Error(
                    `Viewer did not connect within ${timeoutMs / 1000}s. Make sure the browser is open at http://localhost:5173`
                ));
            }, timeoutMs);

            this.viewerReadyResolvers.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    /**
     * Call a method on the viewer and wait for the result.
     * Auto-waits for viewer connection on first call.
     * Timeout per call: 30 seconds.
     */
    async call(method: string, params: any): Promise<any> {
        // Auto-wait for viewer if not yet connected
        if (!this.viewer || this.viewer.readyState !== WebSocket.OPEN) {
            await this.waitForViewer();
        }

        const id = ++this.requestId;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Request ${method} timed out after 30s`));
            }, 30000);

            this.pendingRequests.set(id, { resolve, reject, timeout });

            this.viewer!.send(JSON.stringify({
                id,
                method,
                params,
            }));
        });
    }

    isViewerConnected(): boolean {
        return this.viewer !== null && this.viewer.readyState === WebSocket.OPEN;
    }
}
