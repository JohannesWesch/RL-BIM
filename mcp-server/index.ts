import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ViewerBridge } from "./bridge.js";

// ─── MCP Server ──────────────────────────────────────────────
const server = new McpServer({
    name: "rl-bim",
    version: "1.0.0",
});

const bridge = new ViewerBridge(3001);

/**
 * Helper for camera tools: returns camera state as text + auto-captured screenshot as image.
 * The viewer's api.ts now includes a screenshot in every camera tool response.
 */
function cameraToolResult(result: any) {
    const { image, ...rest } = result;
    const content: any[] = [
        { type: "text" as const, text: JSON.stringify(rest) },
    ];
    if (image) {
        let base64: string;
        let mimeType: string = "image/jpeg";
        if (image.startsWith("data:")) {
            const commaIdx = image.indexOf(",");
            const header = image.substring(0, commaIdx);
            mimeType = header.replace("data:", "").replace(";base64", "");
            base64 = image.substring(commaIdx + 1);
        } else {
            base64 = image;
        }
        content.push({
            type: "image" as const,
            data: base64,
            mimeType: mimeType as "image/png" | "image/jpeg",
        });
    }
    return { content };
}

// ═══════════════════════════════════════════════════════════════
// Tool 1: load_model
// ═══════════════════════════════════════════════════════════════
server.tool(
    "load_model",
    "Load an IFC building model into the 3D viewer",
    {
        url: z.string().describe("URL or local path to the IFC file to load"),
    },
    async ({ url }) => {
        const result = await bridge.call("load_model", { url });
        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(result),
                },
            ],
        };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 2: capture_view
// ═══════════════════════════════════════════════════════════════
server.tool(
    "capture_view",
    "Capture the current 3D view as a screenshot. Use this to see what the model looks like from the current camera position.",
    {
        width: z.number().optional().describe("Image width in pixels (default: 1280)"),
        height: z.number().optional().describe("Image height in pixels (default: 720)"),
    },
    async ({ width, height }) => {
        const result = await bridge.call("capture_view", { width, height });
        const imageData = result.image as string;

        // Extract base64 data and detect mime type from data URI
        let base64: string;
        let mimeType: string = "image/jpeg";
        if (imageData.startsWith("data:")) {
            const commaIdx = imageData.indexOf(",");
            const header = imageData.substring(0, commaIdx);
            mimeType = header.replace("data:", "").replace(";base64", "");
            base64 = imageData.substring(commaIdx + 1);
        } else {
            base64 = imageData;
        }

        return {
            content: [
                {
                    type: "image" as const,
                    data: base64,
                    mimeType: mimeType as "image/png" | "image/jpeg",
                },
            ],
        };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 3: orbit_camera
// ═══════════════════════════════════════════════════════════════
server.tool(
    "orbit_camera",
    "Rotate the camera around the current target point. Positive azimuth rotates right, positive polar rotates up. Returns a screenshot of the new view.",
    {
        azimuth_deg: z.number().describe("Horizontal rotation in degrees (positive = right)"),
        polar_deg: z.number().describe("Vertical rotation in degrees (positive = up)"),
    },
    async ({ azimuth_deg, polar_deg }) => {
        const result = await bridge.call("orbit_camera", { azimuth_deg, polar_deg });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 4: pan_camera
// ═══════════════════════════════════════════════════════════════
server.tool(
    "pan_camera",
    "Move the camera laterally (truck/pedestal). Keeps the viewing direction the same. Returns a screenshot of the new view.",
    {
        dx: z.number().describe("Horizontal movement (positive = right)"),
        dy: z.number().describe("Vertical movement (positive = up)"),
    },
    async ({ dx, dy }) => {
        const result = await bridge.call("pan_camera", { dx, dy });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 5: zoom_camera
// ═══════════════════════════════════════════════════════════════
server.tool(
    "zoom_camera",
    "Zoom the camera in or out (dolly). Factor > 1 zooms in, factor < 1 zooms out. Returns a screenshot of the new view.",
    {
        factor: z.number().describe("Zoom factor (> 1 = zoom in, < 1 = zoom out, e.g. 2.0 = 2x closer)"),
    },
    async ({ factor }) => {
        const result = await bridge.call("zoom_camera", { factor });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 6: set_camera_position
// ═══════════════════════════════════════════════════════════════
server.tool(
    "set_camera_position",
    "Teleport the camera to an exact 3D position and look-at target. Useful for jumping to specific viewpoints. Returns a screenshot of the new view.",
    {
        x: z.number().describe("Camera X position"),
        y: z.number().describe("Camera Y position"),
        z: z.number().describe("Camera Z position"),
        target_x: z.number().describe("Look-at target X"),
        target_y: z.number().describe("Look-at target Y"),
        target_z: z.number().describe("Look-at target Z"),
    },
    async ({ x, y, z: zPos, target_x, target_y, target_z }) => {
        const result = await bridge.call("set_camera_position", {
            x, y, z: zPos, target_x, target_y, target_z,
        });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 7: get_camera_state
// ═══════════════════════════════════════════════════════════════
server.tool(
    "get_camera_state",
    "Get the current camera position, target, and field of view.",
    {},
    async () => {
        const result = await bridge.call("get_camera_state", {});
        return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 8: select_element
// ═══════════════════════════════════════════════════════════════
server.tool(
    "select_element",
    "Select a BIM element by its IFC Express ID. Returns basic info about the element.",
    {
        express_id: z.number().describe("The IFC Express ID of the element to select"),
    },
    async ({ express_id }) => {
        const result = await bridge.call("select_element", { express_id });
        return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 9: get_element_properties
// ═══════════════════════════════════════════════════════════════
server.tool(
    "get_element_properties",
    "Get the full IFC properties of an element (material, dimensions, property sets, etc.).",
    {
        express_id: z.number().describe("The IFC Express ID of the element"),
    },
    async ({ express_id }) => {
        const result = await bridge.call("get_element_properties", { express_id });
        return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 10: highlight_elements
// ═══════════════════════════════════════════════════════════════
server.tool(
    "highlight_elements",
    "Visually highlight BIM elements by coloring them in the 3D view. Useful for marking elements of interest.",
    {
        express_ids: z.array(z.number()).describe("Array of IFC Express IDs to highlight"),
        color: z.string().optional().describe("Hex color for highlighting (default: #ff6b35)"),
    },
    async ({ express_ids, color }) => {
        const result = await bridge.call("highlight_elements", { express_ids, color });
        return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 11: clear_highlights
// ═══════════════════════════════════════════════════════════════
server.tool(
    "clear_highlights",
    "Remove all element highlights, restoring original colors.",
    {},
    async () => {
        const result = await bridge.call("clear_highlights", {});
        return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 12: create_clip_plane
// ═══════════════════════════════════════════════════════════════
server.tool(
    "create_clip_plane",
    "Create a clipping plane (section cut) to reveal internal structure. Specify the plane normal direction and offset.",
    {
        normal_x: z.number().describe("X component of the plane normal vector"),
        normal_y: z.number().describe("Y component of the plane normal vector"),
        normal_z: z.number().describe("Z component of the plane normal vector"),
        offset: z.number().describe("Distance from origin along the normal direction"),
    },
    async ({ normal_x, normal_y, normal_z, offset }) => {
        const result = await bridge.call("create_clip_plane", {
            normal_x, normal_y, normal_z, offset,
        });
        return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 13: search_elements
// ═══════════════════════════════════════════════════════════════
server.tool(
    "search_elements",
    "Search for BIM elements by name or IFC type (e.g., IfcWall, IfcDoor, IfcWindow). Returns matching elements.",
    {
        query: z.string().describe("Search text to match against element names"),
        ifc_type: z.string().optional().describe("Filter by IFC type (e.g., 'IfcWall', 'IfcDoor')"),
    },
    async ({ query, ifc_type }) => {
        const result = await bridge.call("search_elements", { query, ifc_type });
        return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 14: get_spatial_tree
// ═══════════════════════════════════════════════════════════════
server.tool(
    "get_spatial_tree",
    "Get the spatial hierarchy of the building (Project → Site → Building → Storeys → Spaces).",
    {
        depth: z.number().optional().describe("How deep to traverse the hierarchy (default: 3)"),
    },
    async ({ depth }) => {
        const result = await bridge.call("get_spatial_tree", { depth });
        return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 15: reset_view
// ═══════════════════════════════════════════════════════════════
server.tool(
    "reset_view",
    "Reset the camera to show the entire model from an overview perspective. Returns a screenshot of the new view.",
    {},
    async () => {
        const result = await bridge.call("reset_view", {});
        return cameraToolResult(result);
    }
);

// ─── Start Server ────────────────────────────────────────────
async function main() {
    // Start WebSocket bridge to frontend
    await bridge.start();
    console.error("[MCP] WebSocket bridge started on port 3001");

    // Start MCP server on stdio
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[MCP] Server running on stdio");
}

main().catch((err) => {
    console.error("[MCP] Fatal error:", err);
    process.exit(1);
});
