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

        // ── 17. Walk Forward ──────────────────────────────────
        this.handlers.set("walk_forward", async (params: { distance: number }) => {
            await this.viewer.walkForward(params.distance);
            return await this.cameraResultWithScreenshot();
        });

        // ── 18. Elevate Camera ────────────────────────────────
        this.handlers.set("elevate_camera", async (params: { height: number }) => {
            await this.viewer.elevateCamera(params.height);
            return await this.cameraResultWithScreenshot();
        });

        // ── 19. Hide Elements by Type ─────────────────────────
        this.handlers.set("hide_elements_by_type", async (params: { ifc_type: string }) => {
            const result = this.viewer.hideByType(params.ifc_type);
            const screenshot = await this.cameraResultWithScreenshot();
            return { ...result, ...screenshot };
        });

        // ── 20. Show All Elements ─────────────────────────────
        this.handlers.set("show_all_elements", async () => {
            this.viewer.showAll();
            const screenshot = await this.cameraResultWithScreenshot();
            return { ...screenshot };
        });

        // ── 21. Focus Element ─────────────────────────────────
        this.handlers.set("focus_element", async (params: { express_id: number }) => {
            const result = await this.viewer.focusElement(params.express_id);
            if (result.found) {
                return await this.cameraResultWithScreenshot();
            }
            return { success: false, error: "Element not found" };
        });

        // ── 22. Get Model Bounds ──────────────────────────────
        this.handlers.set("get_model_bounds", () => {
            const bounds = this.viewer.getModelBounds();
            return bounds || { error: "No models loaded" };
        });

        // ── 23. Pick Element ──────────────────────────────────
        this.handlers.set("pick_element", async (params: { screen_x?: number; screen_y?: number }) => {
            const pickResult = await this.viewer.pickElement(params.screen_x, params.screen_y);
            const screenshot = await this.cameraResultWithScreenshot();
            return { ...pickResult, ...screenshot };
        });

        // ── 24. Hide Elements ─────────────────────────────────
        this.handlers.set("hide_elements", async (params: { express_ids: number[] }) => {
            this.viewer.hideElements(params.express_ids);
            return await this.cameraResultWithScreenshot();
        });

        // ── 25. Set Camera Projection ────────────────────────────
        this.handlers.set("set_camera_projection", async (params: { mode: "Perspective" | "Orthographic" }) => {
            await this.viewer.setCameraProjection(params.mode);
            return await this.cameraResultWithScreenshot();
        });

        // ── 26. Set Navigation Mode ──────────────────────────────
        this.handlers.set("set_navigation_mode", async (params: { mode: "Orbit" | "FirstPerson" | "Plan" }) => {
            this.viewer.setNavigationMode(params.mode);
            return await this.cameraResultWithScreenshot();
        });

        // ── 27. Create Viewpoint ─────────────────────────────────
        this.handlers.set("create_viewpoint", (params: { title?: string }) => {
            return this.viewer.createViewpoint(params.title);
        });

        // ── 28. List Viewpoints ──────────────────────────────────
        this.handlers.set("list_viewpoints", () => {
            return { viewpoints: this.viewer.listViewpoints() };
        });

        // ── 29. Load Viewpoint ───────────────────────────────────
        this.handlers.set("load_viewpoint", async (params: { guid: string }) => {
            const result = await this.viewer.loadViewpoint(params.guid);
            if (!result.found) return { error: "Viewpoint not found" };
            return await this.cameraResultWithScreenshot();
        });

        // ── 30. Export BCF ───────────────────────────────────────
        this.handlers.set("export_bcf", async (params: { topic_guids?: string[] }) => {
            const data = await this.viewer.exportBCF(params.topic_guids);
            return { data, format: "bcfzip" };
        });

        // ── 31. Import BCF ───────────────────────────────────────
        this.handlers.set("import_bcf", async (params: { data: string }) => {
            return await this.viewer.importBCF(params.data);
        });

        // ── 32. Get Storeys ──────────────────────────────────────
        this.handlers.set("get_storeys", () => {
            return { storeys: this.viewer.getStoreys() };
        });

        // ── 33. Get Spaces ───────────────────────────────────────
        this.handlers.set("get_spaces", () => {
            return { spaces: this.viewer.getSpaces() };
        });

        // ── 34. Get Items In Storey ──────────────────────────────
        this.handlers.set("get_items_in_storey", (params: { storey_name: string }) => {
            return this.viewer.getItemsInStorey(params.storey_name);
        });

        // ── 35. Isolate Storey ───────────────────────────────────
        this.handlers.set("isolate_storey", async (params: { storey_name: string }) => {
            const result = this.viewer.isolateStorey(params.storey_name);
            if (!result.success) return { error: "Storey not found" };
            const screenshot = await this.cameraResultWithScreenshot();
            return { ...result, ...screenshot };
        });

        // ── 36. Isolate Elements ─────────────────────────────────
        this.handlers.set("isolate_elements", async (params: { express_ids: number[] }) => {
            const result = this.viewer.isolateElements(params.express_ids);
            const screenshot = await this.cameraResultWithScreenshot();
            return { ...result, ...screenshot };
        });

        // ── 37. Explode Model ────────────────────────────────────
        this.handlers.set("explode_model", async (params: { height?: number }) => {
            this.viewer.explodeModel(params.height);
            return await this.cameraResultWithScreenshot();
        });

        // ── 38. Reset Explode ────────────────────────────────────
        this.handlers.set("reset_explode", async () => {
            this.viewer.resetExplode();
            return await this.cameraResultWithScreenshot();
        });

        // ── 39. Ghost All Except ─────────────────────────────────
        this.handlers.set("ghost_all_except", async (params: { express_ids: number[]; alpha?: number }) => {
            const result = this.viewer.ghostAllExcept(params.express_ids, params.alpha);
            const screenshot = await this.cameraResultWithScreenshot();
            return { ...result, ...screenshot };
        });

        // ── 40. Reset Ghost ──────────────────────────────────────
        this.handlers.set("reset_ghost", async () => {
            this.viewer.resetGhost();
            return await this.cameraResultWithScreenshot();
        });

        // ── 41. Create Clip Box ──────────────────────────────────
        this.handlers.set("create_clip_box", async (params: {
            cx: number; cy: number; cz: number;
            sx: number; sy: number; sz: number;
        }) => {
            const result = this.viewer.createClipBox(params.cx, params.cy, params.cz, params.sx, params.sy, params.sz);
            const screenshot = await this.cameraResultWithScreenshot();
            return { ...result, ...screenshot };
        });

        // ── 42. Remove Clip Plane ────────────────────────────────
        this.handlers.set("remove_clip_plane", async (params: { index: number }) => {
            const result = this.viewer.removeClipPlane(params.index);
            const screenshot = await this.cameraResultWithScreenshot();
            return { ...result, ...screenshot };
        });

        // ── 43. List Clip Planes ─────────────────────────────────
        this.handlers.set("list_clip_planes", () => {
            return { planes: this.viewer.listClipPlanes() };
        });

        // ── 44. Get Element BBox ─────────────────────────────────
        this.handlers.set("get_element_bbox", (params: { express_id: number }) => {
            return this.viewer.getElementBBox(params.express_id);
        });

        // ── 45. Raycast ──────────────────────────────────────────
        this.handlers.set("raycast", async (params: { screen_x?: number; screen_y?: number }) => {
            const result = this.viewer.raycast(params.screen_x, params.screen_y);
            const screenshot = await this.cameraResultWithScreenshot();
            return { ...result, ...screenshot };
        });

        // ── 46. Create Plan Views ────────────────────────────────
        this.handlers.set("create_plan_views", async () => {
            return { plans: await this.viewer.createPlanViews() };
        });

        // ── 47. List Plans ───────────────────────────────────────
        this.handlers.set("list_plans", () => {
            return { plans: this.viewer.listPlans() };
        });

        // ── 48. Open Plan ────────────────────────────────────────
        this.handlers.set("open_plan", async (params: { plan_id: string }) => {
            const result = await this.viewer.openPlan(params.plan_id);
            if (!result.found) return { error: "Plan not found" };
            return await this.cameraResultWithScreenshot();
        });

        // ── 49. Exit Plan ────────────────────────────────────────
        this.handlers.set("exit_plan", async () => {
            await this.viewer.exitPlan();
            return await this.cameraResultWithScreenshot();
        });

        // ── 50. Measure Distance ─────────────────────────────────
        this.handlers.set("measure_distance", (params: {
            ax: number; ay: number; az: number;
            bx: number; by: number; bz: number;
        }) => {
            return this.viewer.measureDistance(params.ax, params.ay, params.az, params.bx, params.by, params.bz);
        });

        // ── 51. Measure Angle ────────────────────────────────────
        this.handlers.set("measure_angle", (params: {
            ax: number; ay: number; az: number;
            bx: number; by: number; bz: number;
            cx: number; cy: number; cz: number;
        }) => {
            return this.viewer.measureAngle(
                params.ax, params.ay, params.az,
                params.bx, params.by, params.bz,
                params.cx, params.cy, params.cz,
            );
        });

        // ── 52. Measure Volume ───────────────────────────────────
        this.handlers.set("measure_volume", (params: { express_ids: number[] }) => {
            return this.viewer.measureVolume(params.express_ids);
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
