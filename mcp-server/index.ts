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

server.tool("list_elements", "List all elements in the model with Express ID, type, and name.",
    { ifc_type: z.string().optional().describe("Filter by IFC type, e.g. 'IfcWall'") },
    async ({ ifc_type }) => text(await bridge.call("search_elements", { query: "", ifc_type })));

server.tool("search_elements", "Search elements by name. Returns matching Express IDs, types, and names.",
    { query: z.string().describe("Text to match against element names") },
    async ({ query }) => text(await bridge.call("search_elements", { query })));

server.tool("mark_element", "Highlight an element and zoom out so it is centered and fully visible. Returns screenshot.",
    { express_id: z.number().describe("Express ID from list_elements or search_elements") },
    async ({ express_id }) => img(await bridge.call("mark_element", { express_id })));

server.tool("get_element_properties", "Get full IFC properties for a marked/found element.",
    { express_id: z.number().describe("Express ID") },
    async ({ express_id }) => text(await bridge.call("get_element_properties", { express_id })));

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
