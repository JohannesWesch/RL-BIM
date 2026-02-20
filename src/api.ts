import { BIMViewer } from "./viewer";

type Handler = (params: any) => any | Promise<any>;

/**
 * In-browser WebSocket server for MCP ↔ Frontend communication.
 * Since we can't run a real WS server in the browser, this acts as a
 * WebSocket CLIENT that connects to a relay. The MCP server runs the
 * actual WebSocket server, and the browser connects to it.
 *
 * Protocol: JSON-RPC 2.0 over WebSocket
 * { "id": 1, "method": "capture_view", "params": {} }
 * { "id": 1, "result": { "image": "data:image/png;base64,..." } }
 */
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
            // Register as viewer
            this.ws!.send(JSON.stringify({ type: "register", role: "viewer" }));
        };

        this.ws.onmessage = async (event) => {
            try {
                const msg = JSON.parse(event.data as string);
                if (msg.method) {
                    const result = await this.handleRequest(msg);
                    this.ws!.send(JSON.stringify({
                        id: msg.id,
                        result,
                    }));
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
        if (!handler) {
            throw new Error(`Unknown method: ${msg.method}`);
        }
        return await handler(msg.params || {});
    }

    private registerHandlers(): void {
        // ── 1. Load Model ─────────────────────────────────────
        this.handlers.set("load_model", async (params: { url: string }) => {
            const result = await this.viewer.loadModel(params.url);
            return result;
        });

        // ── 2. Capture View ───────────────────────────────────
        this.handlers.set("capture_view", async (params: { width?: number; height?: number }) => {
            const image = await this.viewer.captureScreenshot(params.width, params.height);
            return { image };
        });

        // ── 3. Orbit Camera ───────────────────────────────────
        this.handlers.set("orbit_camera", async (params: { azimuth_deg: number; polar_deg: number }) => {
            await this.viewer.orbitCamera(params.azimuth_deg, params.polar_deg);
            return await this.cameraResultWithScreenshot();
        });

        // ── 4. Pan Camera ─────────────────────────────────────
        this.handlers.set("pan_camera", async (params: { dx: number; dy: number }) => {
            await this.viewer.panCamera(params.dx, params.dy);
            return await this.cameraResultWithScreenshot();
        });

        // ── 5. Zoom Camera ────────────────────────────────────
        this.handlers.set("zoom_camera", async (params: { factor: number }) => {
            await this.viewer.zoomCamera(params.factor);
            return await this.cameraResultWithScreenshot();
        });

        // ── 6. Set Camera Position ────────────────────────────
        this.handlers.set("set_camera_position", async (params: {
            x: number; y: number; z: number;
            target_x: number; target_y: number; target_z: number;
        }) => {
            await this.viewer.setCameraPosition(
                params.x, params.y, params.z,
                params.target_x, params.target_y, params.target_z
            );
            return await this.cameraResultWithScreenshot();
        });

        // ── 7. Get Camera State ───────────────────────────────
        this.handlers.set("get_camera_state", () => {
            return this.viewer.getCameraState();
        });

        // ── 8. Select Element ─────────────────────────────────
        this.handlers.set("select_element", async (params: { express_id: number }) => {
            return await this.viewer.selectElement(params.express_id);
        });

        // ── 9. Get Element Properties ─────────────────────────
        this.handlers.set("get_element_properties", async (params: { express_id: number }) => {
            const props = await this.viewer.getElementProperties(params.express_id);
            return props || { error: "Element not found" };
        });

        // ── 10. Highlight Elements ────────────────────────────
        this.handlers.set("highlight_elements", (params: { express_ids: number[]; color?: string }) => {
            this.viewer.highlightElements(params.express_ids, params.color);
            return { success: true, count: params.express_ids.length };
        });

        // ── 11. Clear Highlights ──────────────────────────────
        this.handlers.set("clear_highlights", () => {
            this.viewer.clearHighlights();
            return { success: true };
        });

        // ── 12. Create Clip Plane ─────────────────────────────
        this.handlers.set("create_clip_plane", (params: {
            normal_x: number; normal_y: number; normal_z: number;
            offset: number;
        }) => {
            const id = this.viewer.createClipPlane(
                params.normal_x, params.normal_y, params.normal_z,
                params.offset
            );
            return { success: true, clipPlaneId: id };
        });

        // ── 13. Remove Clip Planes ────────────────────────────
        this.handlers.set("remove_clip_planes", () => {
            this.viewer.removeAllClipPlanes();
            return { success: true };
        });

        // ── 14. Search Elements ───────────────────────────────
        this.handlers.set("search_elements", async (params: { query: string; ifc_type?: string }) => {
            const results = await this.viewer.searchElements(params.query, params.ifc_type);
            return { results, count: results.length };
        });

        // ── 15. Get Spatial Tree ──────────────────────────────
        this.handlers.set("get_spatial_tree", (params: { depth?: number }) => {
            return this.viewer.getSpatialTree(params.depth);
        });

        // ── 16. Reset View ────────────────────────────────────
        this.handlers.set("reset_view", async () => {
            await this.viewer.resetView();
            return await this.cameraResultWithScreenshot();
        });
    }

    /**
     * Helper: Returns camera state + auto-captured screenshot.
     * Used by all camera-modifying tools so the agent gets
     * visual feedback without a separate capture_view call.
     */
    private async cameraResultWithScreenshot(): Promise<{
        success: boolean;
        camera: ReturnType<BIMViewer["getCameraState"]>;
        image: string;
    }> {
        const image = await this.viewer.captureScreenshot();
        return {
            success: true,
            camera: this.viewer.getCameraState(),
            image,
        };
    }
}
