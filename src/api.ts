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

    private async shot<T>(data: T): Promise<T & { image: string }> {
        // Capture a low-res frame to keep the memory footprint small
        const frame = await this.viewer.captureScreenshot(320, 240);
        this.recentFrames.push(frame);
        if (this.recentFrames.length > this.maxFrames) {
            this.recentFrames.shift();
        }

        const image = await this.createSpriteSheet();
        return { ...data, image };
    }

    private async createSpriteSheet(): Promise<string> {
        if (this.recentFrames.length === 0) return "";

        // Number of cols/rows
        const cols = 4;
        const rows = Math.ceil(this.maxFrames / cols);

        // Load the first image to get dimensions
        const loadImg = (src: string): Promise<HTMLImageElement> => {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = src;
            });
        };

        try {
            const firstImg = await loadImg(this.recentFrames[0]);
            const frameW = firstImg.width;
            const frameH = firstImg.height;

            const canvas = document.createElement("canvas");
            canvas.width = frameW * cols;
            canvas.height = frameH * rows;
            const ctx = canvas.getContext("2d");
            if (!ctx) return this.recentFrames[this.recentFrames.length - 1]; // Fallback

            // Fill background
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Draw frames
            for (let i = 0; i < this.recentFrames.length; i++) {
                const img = await loadImg(this.recentFrames[i]);
                const c = i % cols;
                const r = Math.floor(i / cols);
                ctx.drawImage(img, c * frameW, r * frameH, frameW, frameH);

                // Add a small border/indicator for the last frame
                if (i === this.recentFrames.length - 1) {
                    ctx.strokeStyle = "#ff0000";
                    ctx.lineWidth = 4;
                    ctx.strokeRect(c * frameW + 2, r * frameH + 2, frameW - 4, frameH - 4);
                }
            }

            return canvas.toDataURL("image/jpeg", 0.85);
        } catch (e) {
            console.error("[WS-API] Failed to create sprite sheet:", e);
            // Fallback to the latest frame
            return this.recentFrames[this.recentFrames.length - 1];
        }
    }

    private registerHandlers(): void {
        const v = this.viewer;
        const h = this.handlers;

        h.set("load_model", async (p: any) => v.loadModel(p.url));

        h.set("search_elements", async (p: any) => {
            const results = await v.searchElements(p.query ?? "", p.ifc_type);
            return { results, count: results.length };
        });

        h.set("mark_element", async (p: any) => {
            v.clearHighlights();
            v.highlightElements([p.express_id], "danger");
            const focusResult = await v.focusElement(p.express_id);
            console.log(`[mark_element] id=${p.express_id} focus=${JSON.stringify(focusResult)}`);
            return this.shot({ express_id: p.express_id, ...focusResult });
        });

        h.set("get_element_properties", async (p: any) =>
            (await v.getElementProperties(p.express_id)) || { error: "Not found" });

        // Camera tools
        h.set("camera_look", async (p: any) => {
            // "small" steps are handled by the agent prompt
            await v.cameraOrbit(p.direction, "small"); // cameraOrbit acts as look around in FirstPerson mode
            return await this.shot({ action: "camera_look", direction: p.direction });
        });

        h.set("camera_walk", async (p: any) => {
            const steps = Math.min(Math.max(p.steps ?? 1, 1), 10);
            for (let i = 0; i < steps; i++) {
                await v.walk(p.direction, 1);
                // Capture an intermediate frame for the history buffer
                const frame = await v.captureScreenshot(320, 240);
                this.recentFrames.push(frame);
                if (this.recentFrames.length > this.maxFrames) {
                    this.recentFrames.shift();
                }
            }
            // Generate the final sprite sheet containing the new intermediate frames
            const image = await this.createSpriteSheet();
            return { action: "camera_walk", direction: p.direction, steps, image };
        });

        h.set("capture_view", async (p: any) => {
            return await this.shot({ action: "capture_view" });
        });
    }
}
