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



server.tool("camera_look", "Pan or tilt the view (turn your head) in a specific direction.",
    { direction: z.enum(["left", "right", "up", "down"]).describe("Direction to look") },
    async ({ direction }) => img(await bridge.call("camera_look", { direction })));

server.tool("camera_walk", "Walk the camera by a specific number of steps (1 meter per step) in a given direction (FPS style). Returns a 16-frame sprite sheet of recent views.",
    {
        direction: z.enum(["forward", "backward", "left", "right"]).describe("Direction to walk"),
        steps: z.number().optional().describe("Number of 1-meter steps to walk before returning the image (default: 1, max: 10)")
    },
    async ({ direction, steps }) => img(await bridge.call("camera_walk", { direction, steps })));

server.tool("capture_view", "Capture the current view of the model as a sprite sheet without moving the camera.",
    {},
    async () => img(await bridge.call("capture_view", {})));

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
