import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ViewerBridge } from "./bridge.js";

const server = new McpServer({ name: "rl-bim", version: "4.0.0" });
const bridge = new ViewerBridge(3001);

function extractImage(result: any): any[] {
    const { image, ...rest } = result;
    const content: any[] = [{ type: "text" as const, text: JSON.stringify(rest) }];
    if (image) {
        let base64: string;
        let mimeType = "image/png";
        if (image.startsWith("data:")) {
            const commaIdx = image.indexOf(",");
            mimeType = image.substring(0, commaIdx).replace("data:", "").replace(";base64", "");
            base64 = image.substring(commaIdx + 1);
        } else {
            base64 = image;
        }
        content.push({ type: "image" as const, data: base64, mimeType: mimeType as "image/png" | "image/jpeg" });
    }
    return content;
}

function text(result: any) {
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

function img(result: any) {
    return { content: extractImage(result) };
}



server.tool("camera_orbit", "Orbit the camera around the current target. Returns a 16-frame sprite sheet of recent views.",
    { direction: z.enum(["left", "right", "up", "down"]).describe("Direction to orbit") },
    async ({ direction }) => img(await bridge.call("camera_orbit", { direction })));

server.tool("camera_zoom", "Dolly/Zoom the camera in or out by a small amount. Returns a 16-frame sprite sheet of recent views.",
    { direction: z.enum(["in", "out"]).describe("Zoom in or out") },
    async ({ direction }) => img(await bridge.call("camera_zoom", { direction })));

server.tool("camera_walk", "Walk the camera 1 meter in a given direction (FPS style). Returns a 16-frame sprite sheet of recent views.",
    { direction: z.enum(["forward", "backward", "left", "right"]).describe("Direction to walk") },
    async ({ direction }) => img(await bridge.call("camera_walk", { direction })));

async function main() {
    await bridge.start();
    console.error("[MCP] WebSocket bridge started on port 3001");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[MCP] Server running on stdio");
}

main().catch((err) => {
    console.error("[MCP] Fatal error:", err);
    process.exit(1);
});
