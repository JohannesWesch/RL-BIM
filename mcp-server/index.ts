import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ViewerBridge } from "./bridge.js";

const server = new McpServer({ name: "rl-bim", version: "5.0.0" });
const bridge = new ViewerBridge(3001);

/** Split an image field out of a result into MCP image content. */
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

// ─── Tools ───────────────────────────────────────────────────
// Register tools here. Example:
//
// server.tool("my_tool", "Description",
//     { param: z.string().describe("A parameter") },
//     async ({ param }) => text(await bridge.call("my_tool", { param })));

// ─── Main ────────────────────────────────────────────────────

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
