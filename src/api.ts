import { BIMViewer } from "./viewer";

type Handler = (params: any) => any | Promise<any>;

export class WebSocketAPI {
    private viewer: BIMViewer;
    private port: number;
    private ws: WebSocket | null = null;
    private handlers: Map<string, Handler> = new Map();
    private reconnectInterval: number = 2000;

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
        const image = await this.viewer.captureScreenshot();
        return { ...data, image };
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
    }
}
