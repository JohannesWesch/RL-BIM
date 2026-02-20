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
        let mimeType: string = "image/png";
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
        let mimeType: string = "image/png";
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

// ═══════════════════════════════════════════════════════════════
// Tool 16: walk_forward
// ═══════════════════════════════════════════════════════════════
server.tool(
    "walk_forward",
    "Move the camera forward or backward in the direction it is currently looking (first-person walk). Positive distance = forward, negative = backward. Returns a screenshot of the new view.",
    {
        distance: z.number().describe("Distance to walk (positive = forward, negative = backward, e.g. 2.0 = 2 meters forward)"),
    },
    async ({ distance }) => {
        const result = await bridge.call("walk_forward", { distance });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 17: elevate_camera
// ═══════════════════════════════════════════════════════════════
server.tool(
    "elevate_camera",
    "Move the camera straight up or down (vertical movement). Useful for changing floor levels or adjusting eye height. Returns a screenshot of the new view.",
    {
        height: z.number().describe("Vertical distance to move (positive = up, negative = down, e.g. 3.0 = move up 3 meters)"),
    },
    async ({ height }) => {
        const result = await bridge.call("elevate_camera", { height });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 18: hide_elements_by_type
// ═══════════════════════════════════════════════════════════════
server.tool(
    "hide_elements_by_type",
    "Hide all BIM elements of a given IFC type (e.g., IfcRoof, IfcSlab, IfcWall). Useful for removing roofs or floors to see the interior from above. Returns a screenshot showing the result.",
    {
        ifc_type: z.string().describe("The IFC type to hide (e.g., 'IfcRoof', 'IfcSlab', 'IfcWall', 'IfcCovering')"),
    },
    async ({ ifc_type }) => {
        const result = await bridge.call("hide_elements_by_type", { ifc_type });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 19: show_all_elements
// ═══════════════════════════════════════════════════════════════
server.tool(
    "show_all_elements",
    "Restore visibility of all hidden elements. Undoes any previous hide_elements_by_type calls. Returns a screenshot showing the result.",
    {},
    async () => {
        const result = await bridge.call("show_all_elements", {});
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 20: focus_element
// ═══════════════════════════════════════════════════════════════
server.tool(
    "focus_element",
    "Fly the camera to focus on a specific BIM element by its IFC Express ID. The camera will frame the element in view. Returns a screenshot of the focused element.",
    {
        express_id: z.number().describe("The IFC Express ID of the element to focus on"),
    },
    async ({ express_id }) => {
        const result = await bridge.call("focus_element", { express_id });
        if (result.error) {
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 21: get_model_bounds
// ═══════════════════════════════════════════════════════════════
server.tool(
    "get_model_bounds",
    "Get the world-space bounding box of the loaded model. Returns min/max corners, center point, and size in meters. Use this to understand the coordinate space and plan camera positions.",
    {},
    async () => {
        const result = await bridge.call("get_model_bounds", {});
        return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 22: remove_clip_planes
// ═══════════════════════════════════════════════════════════════
server.tool(
    "remove_clip_planes",
    "Remove all clipping planes (section cuts), restoring the full model view.",
    {},
    async () => {
        const result = await bridge.call("remove_clip_planes", {});
        return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 23: pick_element
// ═══════════════════════════════════════════════════════════════
server.tool(
    "pick_element",
    "Cast a ray from the camera through the screen to identify the BIM element at that point. Defaults to center of screen (0,0). Returns the element's IFC Express ID, type, name, and properties, plus a screenshot. Use this to identify what you're looking at before hiding or inspecting it.",
    {
        screen_x: z.number().optional().describe("Normalized screen X coordinate (-1 to 1, default 0 = center)"),
        screen_y: z.number().optional().describe("Normalized screen Y coordinate (-1 to 1, default 0 = center)"),
    },
    async ({ screen_x, screen_y }) => {
        const result = await bridge.call("pick_element", { screen_x, screen_y });
        const { image, ...rest } = result;
        const content: any[] = [
            { type: "text" as const, text: JSON.stringify(rest) },
        ];
        if (image) {
            let base64: string;
            let mimeType: string = "image/png";
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
);

// ═══════════════════════════════════════════════════════════════
// Tool 24: hide_elements
// ═══════════════════════════════════════════════════════════════
server.tool(
    "hide_elements",
    "Hide specific BIM elements by their IFC Express IDs. Use after pick_element to hide identified elements (e.g., hide a roof or slab to reveal what's underneath). Returns a screenshot showing the result.",
    {
        express_ids: z.array(z.number()).describe("Array of IFC Express IDs to hide"),
    },
    async ({ express_ids }) => {
        const result = await bridge.call("hide_elements", { express_ids });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 25: create_viewpoint
// ═══════════════════════════════════════════════════════════════
server.tool(
    "create_viewpoint",
    "Bookmark the current camera position, visibility state, and clipping planes as a BCF viewpoint. Use this to save locations you want to return to later.",
    {
        title: z.string().optional().describe("Optional human-readable title for the viewpoint"),
    },
    async ({ title }) => {
        const result = await bridge.call("create_viewpoint", { title });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 26: list_viewpoints
// ═══════════════════════════════════════════════════════════════
server.tool(
    "list_viewpoints",
    "List all saved BCF viewpoints with their GUIDs, titles, and camera positions.",
    {},
    async () => {
        const result = await bridge.call("list_viewpoints", {});
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 27: load_viewpoint
// ═══════════════════════════════════════════════════════════════
server.tool(
    "load_viewpoint",
    "Restore a previously saved viewpoint — teleports the camera and restores visibility/colors. Returns a screenshot.",
    {
        guid: z.string().describe("The GUID of the viewpoint to load"),
    },
    async ({ guid }) => {
        const result = await bridge.call("load_viewpoint", { guid });
        if (result.error) {
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 28: export_bcf
// ═══════════════════════════════════════════════════════════════
server.tool(
    "export_bcf",
    "Export BCF topics and viewpoints as a base64-encoded BCF zip file.",
    {
        topic_guids: z.array(z.string()).optional().describe("Specific topic GUIDs to export (default: all)"),
    },
    async ({ topic_guids }) => {
        const result = await bridge.call("export_bcf", { topic_guids });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 29: import_bcf
// ═══════════════════════════════════════════════════════════════
server.tool(
    "import_bcf",
    "Import BCF data (base64-encoded zip) to load topics and viewpoints.",
    {
        data: z.string().describe("Base64-encoded BCF zip file data"),
    },
    async ({ data }) => {
        const result = await bridge.call("import_bcf", { data });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 30: get_storeys
// ═══════════════════════════════════════════════════════════════
server.tool(
    "get_storeys",
    "List all building storeys (floors) from the IFC spatial structure. Returns storey names, IDs, and element counts.",
    {},
    async () => {
        const result = await bridge.call("get_storeys", {});
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 31: get_spaces
// ═══════════════════════════════════════════════════════════════
server.tool(
    "get_spaces",
    "List all spaces/rooms from the IFC spatial structure. Returns space names, IDs, and element counts.",
    {},
    async () => {
        const result = await bridge.call("get_spaces", {});
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 32: get_items_in_storey
// ═══════════════════════════════════════════════════════════════
server.tool(
    "get_items_in_storey",
    "Get all element Express IDs that belong to a specific building storey. Use get_storeys first to see available names.",
    {
        storey_name: z.string().describe("Exact storey name as returned by get_storeys"),
    },
    async ({ storey_name }) => {
        const result = await bridge.call("get_items_in_storey", { storey_name });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 33: isolate_storey
// ═══════════════════════════════════════════════════════════════
server.tool(
    "isolate_storey",
    "Show only elements belonging to a specific storey, hiding everything else. Great for floor-by-floor exploration. Returns a screenshot.",
    {
        storey_name: z.string().describe("Exact storey name as returned by get_storeys"),
    },
    async ({ storey_name }) => {
        const result = await bridge.call("isolate_storey", { storey_name });
        if (result.error) {
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 34: isolate_elements
// ═══════════════════════════════════════════════════════════════
server.tool(
    "isolate_elements",
    "Show only the specified elements, hiding everything else. Useful for focusing on a subset of elements. Returns a screenshot.",
    {
        express_ids: z.array(z.number()).describe("Array of IFC Express IDs to keep visible"),
    },
    async ({ express_ids }) => {
        const result = await bridge.call("isolate_elements", { express_ids });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 35: explode_model
// ═══════════════════════════════════════════════════════════════
server.tool(
    "explode_model",
    "Explode the model by separating storeys vertically. Makes it easy to see all floors at once. Returns a screenshot.",
    {
        height: z.number().optional().describe("Vertical separation distance between floors (default: 10)"),
    },
    async ({ height }) => {
        const result = await bridge.call("explode_model", { height });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 36: reset_explode
// ═══════════════════════════════════════════════════════════════
server.tool(
    "reset_explode",
    "Reset the model explosion, restoring all elements to their original positions. Returns a screenshot.",
    {},
    async () => {
        const result = await bridge.call("reset_explode", {});
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 37: ghost_all_except
// ═══════════════════════════════════════════════════════════════
server.tool(
    "ghost_all_except",
    "Make all elements semi-transparent (ghosted) EXCEPT the specified ones, which remain opaque. Great for highlighting specific elements in context. Returns a screenshot.",
    {
        express_ids: z.array(z.number()).describe("Array of IFC Express IDs to keep opaque"),
        alpha: z.number().optional().describe("Opacity for ghosted elements (0.0 = invisible, 1.0 = opaque, default: 0.1)"),
    },
    async ({ express_ids, alpha }) => {
        const result = await bridge.call("ghost_all_except", { express_ids, alpha });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 38: reset_ghost
// ═══════════════════════════════════════════════════════════════
server.tool(
    "reset_ghost",
    "Remove the ghost/transparency effect, restoring all elements to their original materials. Returns a screenshot.",
    {},
    async () => {
        const result = await bridge.call("reset_ghost", {});
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 39: create_clip_box
// ═══════════════════════════════════════════════════════════════
server.tool(
    "create_clip_box",
    "Create a clipping box (6 planes) to isolate a region of the model. Only geometry inside the box remains visible. Returns a screenshot.",
    {
        cx: z.number().describe("Box center X coordinate"),
        cy: z.number().describe("Box center Y coordinate"),
        cz: z.number().describe("Box center Z coordinate"),
        sx: z.number().describe("Box size in X direction"),
        sy: z.number().describe("Box size in Y direction"),
        sz: z.number().describe("Box size in Z direction"),
    },
    async ({ cx, cy, cz, sx, sy, sz }) => {
        const result = await bridge.call("create_clip_box", { cx, cy, cz, sx, sy, sz });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 40: remove_clip_plane
// ═══════════════════════════════════════════════════════════════
server.tool(
    "remove_clip_plane",
    "Remove a specific clipping plane by its index. Use list_clip_planes to see available indices. Returns a screenshot.",
    {
        index: z.number().describe("Index of the clipping plane to remove (from list_clip_planes)"),
    },
    async ({ index }) => {
        const result = await bridge.call("remove_clip_plane", { index });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 41: list_clip_planes
// ═══════════════════════════════════════════════════════════════
server.tool(
    "list_clip_planes",
    "List all active clipping planes with their index, normal vector, and position.",
    {},
    async () => {
        const result = await bridge.call("list_clip_planes", {});
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 42: get_element_bbox
// ═══════════════════════════════════════════════════════════════
server.tool(
    "get_element_bbox",
    "Get the world-space bounding box of a specific element. Returns min/max corners, center, and size.",
    {
        express_id: z.number().describe("The IFC Express ID of the element"),
    },
    async ({ express_id }) => {
        const result = await bridge.call("get_element_bbox", { express_id });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 43: raycast
// ═══════════════════════════════════════════════════════════════
server.tool(
    "raycast",
    "Cast a ray from the camera through a screen point and return detailed hit info: world-space hit point, surface normal, distance, and element identity. Returns a screenshot.",
    {
        screen_x: z.number().optional().describe("Normalized screen X (-1 to 1, default 0 = center)"),
        screen_y: z.number().optional().describe("Normalized screen Y (-1 to 1, default 0 = center)"),
    },
    async ({ screen_x, screen_y }) => {
        const result = await bridge.call("raycast", { screen_x, screen_y });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 44: create_plan_views
// ═══════════════════════════════════════════════════════════════
server.tool(
    "create_plan_views",
    "Generate 2D floor plan views from the loaded IFC model's storey data. Must be called before open_plan. Returns list of available plans.",
    {},
    async () => {
        const result = await bridge.call("create_plan_views", {});
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 45: list_plans
// ═══════════════════════════════════════════════════════════════
server.tool(
    "list_plans",
    "List all generated floor plan views with their IDs and names.",
    {},
    async () => {
        const result = await bridge.call("list_plans", {});
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 46: open_plan
// ═══════════════════════════════════════════════════════════════
server.tool(
    "open_plan",
    "Navigate to a 2D floor plan view. Switches to orthographic top-down projection with a clipping plane at floor level. Much easier than 3D for room identification. Returns a screenshot.",
    {
        plan_id: z.string().describe("The plan ID (from list_plans or create_plan_views)"),
    },
    async ({ plan_id }) => {
        const result = await bridge.call("open_plan", { plan_id });
        if (result.error) {
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 47: exit_plan
// ═══════════════════════════════════════════════════════════════
server.tool(
    "exit_plan",
    "Exit the 2D floor plan view and return to 3D perspective navigation. Returns a screenshot.",
    {},
    async () => {
        const result = await bridge.call("exit_plan", {});
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 48: measure_distance
// ═══════════════════════════════════════════════════════════════
server.tool(
    "measure_distance",
    "Calculate the 3D Euclidean distance between two world-space points. Use raycast to get world coordinates from screen positions.",
    {
        ax: z.number().describe("Point A X coordinate"),
        ay: z.number().describe("Point A Y coordinate"),
        az: z.number().describe("Point A Z coordinate"),
        bx: z.number().describe("Point B X coordinate"),
        by: z.number().describe("Point B Y coordinate"),
        bz: z.number().describe("Point B Z coordinate"),
    },
    async ({ ax, ay, az, bx, by, bz }) => {
        const result = await bridge.call("measure_distance", { ax, ay, az, bx, by, bz });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 49: measure_angle
// ═══════════════════════════════════════════════════════════════
server.tool(
    "measure_angle",
    "Calculate the angle at vertex B formed by points A-B-C in world space. Returns angle in degrees.",
    {
        ax: z.number().describe("Point A X"),
        ay: z.number().describe("Point A Y"),
        az: z.number().describe("Point A Z"),
        bx: z.number().describe("Vertex B X (angle measured here)"),
        by: z.number().describe("Vertex B Y"),
        bz: z.number().describe("Vertex B Z"),
        cx: z.number().describe("Point C X"),
        cy: z.number().describe("Point C Y"),
        cz: z.number().describe("Point C Z"),
    },
    async ({ ax, ay, az, bx, by, bz, cx, cy, cz }) => {
        const result = await bridge.call("measure_angle", { ax, ay, az, bx, by, bz, cx, cy, cz });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 50: measure_volume
// ═══════════════════════════════════════════════════════════════
server.tool(
    "measure_volume",
    "Calculate the volume of specified BIM elements in cubic meters.",
    {
        express_ids: z.array(z.number()).describe("Array of IFC Express IDs whose volume to calculate"),
    },
    async ({ express_ids }) => {
        const result = await bridge.call("measure_volume", { express_ids });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 51: set_camera_projection
// ═══════════════════════════════════════════════════════════════
server.tool(
    "set_camera_projection",
    "Switch the camera between Perspective and Orthographic projection. Orthographic is useful for 2D plan views and accurate measurements. Returns a screenshot.",
    {
        mode: z.enum(["Perspective", "Orthographic"]).describe("Projection mode"),
    },
    async ({ mode }) => {
        const result = await bridge.call("set_camera_projection", { mode });
        return cameraToolResult(result);
    }
);

// ═══════════════════════════════════════════════════════════════
// Tool 26: set_navigation_mode
// ═══════════════════════════════════════════════════════════════
server.tool(
    "set_navigation_mode",
    "Switch camera navigation mode. 'Orbit' rotates around a target (default), 'FirstPerson' for walk-through exploration, 'Plan' for 2D top-down navigation. Returns a screenshot.",
    {
        mode: z.enum(["Orbit", "FirstPerson", "Plan"]).describe("Navigation mode"),
    },
    async ({ mode }) => {
        const result = await bridge.call("set_navigation_mode", { mode });
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
