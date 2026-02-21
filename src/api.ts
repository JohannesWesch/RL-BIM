import { BIMViewer } from "./viewer";

type Handler = (params: any) => any | Promise<any>;

export class WebSocketAPI {
    private viewer: BIMViewer;
    private port: number;
    private ws: WebSocket | null = null;
    private handlers: Map<string, Handler> = new Map();
    private reconnectInterval: number = 2000;
    private recentFrames: string[] = [];
    private maxFrames: number = 16;

    constructor(viewer: BIMViewer, port: number = 3001) {
        this.viewer = viewer;
        this.port = port;
        this.registerHandlers();
    }

    start(): void {
        this.connect();
    }

    private connect(): void {
        const url = `ws://localhost:${this.port}`;
        console.log(`[WS-API] Connecting to ${url}...`);

        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            console.log("[WS-API] Connected to MCP bridge");
            this.ws!.send(JSON.stringify({ type: "register", role: "viewer" }));
        };

        this.ws.onmessage = async (event) => {
            try {
                const msg = JSON.parse(event.data as string);
                if (msg.method) {
                    const result = await this.handleRequest(msg);
                    this.ws!.send(JSON.stringify({ id: msg.id, result }));
                }
            } catch (err: any) {
                console.error("[WS-API] Error:", err);
                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        id: (JSON.parse(event.data as string)).id,
                        error: { code: -1, message: err.message },
                    }));
                }
            }
        };

        this.ws.onclose = () => {
            console.log("[WS-API] Disconnected, reconnecting...");
            setTimeout(() => this.connect(), this.reconnectInterval);
        };

        this.ws.onerror = (err) => {
            console.error("[WS-API] WebSocket error:", err);
        };
    }

    private async handleRequest(msg: { id: number; method: string; params: any }): Promise<any> {
        const handler = this.handlers.get(msg.method);
        if (!handler) throw new Error(`Unknown method: ${msg.method}`);
        return await handler(msg.params || {});
    }

    /** Capture a frame, push it to the history buffer, and return data + sprite sheet. */
    async shot<T>(data: T): Promise<T & { image: string }> {
        const frame = await this.viewer.captureScreenshot(320, 240);
        this.recentFrames.push(frame);
        if (this.recentFrames.length > this.maxFrames) this.recentFrames.shift();
        const image = await this.createSpriteSheet();
        return { ...data, image };
    }

    /** Build a 4-column sprite sheet from the recent-frames buffer. */
    async createSpriteSheet(): Promise<string> {
        if (this.recentFrames.length === 0) return "";

        const cols = 4;
        const rows = Math.ceil(this.maxFrames / cols);

        const loadImg = (src: string): Promise<HTMLImageElement> =>
            new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = src;
            });

        try {
            const firstImg = await loadImg(this.recentFrames[0]);
            const fw = firstImg.width;
            const fh = firstImg.height;

            const canvas = document.createElement("canvas");
            canvas.width = fw * cols;
            canvas.height = fh * rows;
            const ctx = canvas.getContext("2d");
            if (!ctx) return this.recentFrames[this.recentFrames.length - 1];

            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            for (let i = 0; i < this.recentFrames.length; i++) {
                const img = await loadImg(this.recentFrames[i]);
                const c = i % cols;
                const r = Math.floor(i / cols);
                ctx.drawImage(img, c * fw, r * fh, fw, fh);

                if (i === this.recentFrames.length - 1) {
                    ctx.strokeStyle = "#ff0000";
                    ctx.lineWidth = 4;
                    ctx.strokeRect(c * fw + 2, r * fh + 2, fw - 4, fh - 4);
                }
            }

            return canvas.toDataURL("image/jpeg", 0.85);
        } catch (e) {
            console.error("[WS-API] Failed to create sprite sheet:", e);
            return this.recentFrames[this.recentFrames.length - 1];
        }
    }

    /** Register tool handlers here. */
    private registerHandlers(): void {
        // Tools will be registered here.
        // Example:
        //   this.handlers.set("my_tool", async (p) => { ... });
    }
}
