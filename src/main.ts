import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBCF from "@thatopen/components-front";
import { BIMViewer } from "./viewer";
import { WebSocketAPI } from "./api";

// ─── Bootstrap ──────────────────────────────────────────────
const container = document.getElementById("viewer-container")!;
const status = document.getElementById("status")!;

async function main() {
    status.textContent = "Initializing viewer…";

    // Create the BIM viewer (headless-optimized)
    const viewer = new BIMViewer(container);
    await viewer.init();

    status.textContent = "Starting WebSocket API…";

    // Start WebSocket API for MCP communication
    const api = new WebSocketAPI(viewer, 3001);
    api.start();

    status.textContent = `RL-BIM Ready | WS: ws://localhost:3001`;

    // Expose globally for debugging
    (window as any).__viewer = viewer;
    (window as any).__api = api;

    // Auto-load model from ?model= query parameter
    const params = new URLSearchParams(window.location.search);
    const modelUrl = params.get("model");
    if (modelUrl) {
        status.textContent = `Loading model: ${modelUrl}…`;
        try {
            const result = await viewer.loadModel(modelUrl);
            status.textContent = `Model loaded: ${result.elementCount} elements`;
            console.log("[RL-BIM] Model loaded:", result);

            // Auto-fit view to model
            viewer.resetView();
        } catch (err: any) {
            console.error("[RL-BIM] Model load failed:", err);
            status.textContent = `Load error: ${err.message}`;
        }
    }
}

main().catch((err) => {
    console.error("RL-BIM init failed:", err);
    status.textContent = `Error: ${err.message}`;
});
