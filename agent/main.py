"""
RL-BIM Agent – GPT-5.2 Vision-Action Loop (Responses API)

Connects to the BIM viewer via MCP and uses GPT-5.2's vision capabilities
to autonomously navigate building models. Uses the OpenAI Responses API
for first-class image support in tool results and automatic truncation.

The loop:
  1. Sends the task + conversation to GPT-5.2 via Responses API
  2. Executes any function calls the model returns (with screenshots)
  3. Feeds results back as function_call_output (images as input_image)
  4. Repeats until the model gives a text response or max steps reached
"""

import asyncio
import argparse
import base64
import json
import os
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

from mcp_client import MCPClient

load_dotenv(Path(__file__).parent.parent / ".env")


SYSTEM_PROMPT = """You are an expert BIM (Building Information Modeling) navigator with excellent vision.
You are controlling a 3D building model viewer through a camera. Every time you move the camera
(orbit, pan, zoom, walk_forward, elevate_camera, set_camera_position, reset_view, etc.), you
automatically receive a screenshot showing the result.

CRITICAL RULE — DO NOT GIVE UP EARLY:
- You have up to 30 steps. Use them. Do NOT say "TASK COMPLETE" after only 2-3 steps.
- If the first view doesn't answer the question, KEEP EXPLORING: zoom in, orbit, walk forward,
  move the camera to a new position, hide the roof, etc.
- NEVER describe what you "would need to do" and then stop. Actually DO it.
- Only say "TASK COMPLETE" when you have genuinely investigated the question thoroughly.

IMPORTANT RULES FOR VISUAL ANALYSIS:
1. You MUST carefully examine every screenshot you receive. Describe what you SEE in the image:
   colors, shapes, materials, spatial relationships, building elements visible.
2. NEVER guess or assume colors/materials — always base your answers on what is visually
   apparent in the screenshots. If the walls look red, say red. If they look grey, say grey.
3. Use camera tools aggressively to explore — orbit around the building, zoom in on details,
   create section cuts to see interiors. Each camera action gives you a new screenshot.
4. When answering questions about visual properties (color, shape, size), you MUST zoom in
   close (factor 4+) to the relevant elements AND orbit to see them from multiple angles
   before answering. NEVER answer color or material questions from an overview/zoomed-out shot.
5. Be aware that the dark background grid can bias your color perception. Focus only on the
   building elements themselves, not the surrounding environment.
6. For color/material questions, CROSS-CHECK your visual observation by using search_elements
   to find the relevant elements, then get_element_properties to read the IFC material and
   color data. Report both what you see AND what the data says.

NAVIGATION AND EXPLORATION TOOLS:

Basic camera:
- reset_view: Get an overview. Always start here.
- get_model_bounds: Understand the coordinate space (min/max/center/size in meters).
- orbit_camera: Rotate around the current target to see different facades.
- zoom_camera: Zoom in (factor > 1) or out (factor < 1).
- pan_camera: Move laterally without changing viewing direction.
- set_camera_position: Teleport to exact coordinates + look-at target.
- walk_forward: First-person walk (positive = forward, negative = backward).
- elevate_camera: Move straight up/down (e.g., change floors).
- set_camera_projection: Switch between "Perspective" and "Orthographic" views.
  Orthographic is useful for accurate measurements and plan-like views.
- set_navigation_mode: Switch between "Orbit" (default), "FirstPerson" (walk-through),
  and "Plan" (2D top-down).

Viewpoint bookmarks (BCF):
- create_viewpoint: Bookmark the current camera + visibility + clipping state. Use this
  to save locations you want to return to later.
- list_viewpoints: See all saved viewpoints with their GUIDs and positions.
- load_viewpoint: Teleport back to a saved viewpoint, restoring visibility and colors.
- export_bcf / import_bcf: Export/import BCF-format issues with viewpoints.

BIM-native storey/space queries:
- get_storeys: List all building storeys (floors) with element counts.
- get_spaces: List all rooms/spaces in the model.
- get_items_in_storey: Get all element IDs belonging to a specific storey.
- isolate_storey: Show ONLY one storey, hiding everything else. Great for
  floor-by-floor exploration.

2D floor plans:
- create_plan_views: Generate 2D plan views from IFC storey data. Call this once.
- list_plans: See available plan views.
- open_plan: Navigate to a 2D top-down floor plan (auto-switches to ortho + clip plane).
  Much easier than 3D orbiting for room identification and layout analysis.
- exit_plan: Return to 3D perspective view.

Element identification:
- pick_element: Cast a ray from the screen center (or specified point) to identify what
  you're looking at. Returns Express ID, IFC type, name, and properties.
- raycast: Like pick_element but also returns the world-space hit point, surface normal,
  and distance from camera. Use to get precise 3D coordinates for measurements.
- search_elements: Find elements by name or IFC type.
- get_element_properties: Read full IFC data (materials, dimensions, property sets).
- get_element_bbox: Get the bounding box (min, max, center, size) of a specific element.
- select_element: Select and get basic info about an element by Express ID.
- focus_element: Fly the camera to frame a specific element.

Visibility control:
- hide_elements: Hide specific elements by Express IDs (use after pick_element).
- hide_elements_by_type: Hide ALL elements of an IFC type (e.g., "IfcRoof").
- show_all_elements: Restore all hidden elements.
- isolate_elements: Show ONLY the specified elements, hiding everything else.
- highlight_elements: Color-mark elements of interest. clear_highlights to undo.

Occlusion handling (X-ray / explode):
- ghost_all_except: Make everything semi-transparent EXCEPT specified elements.
  They stay opaque while the rest becomes see-through. Use reset_ghost to restore.
- explode_model: Separate storeys vertically so you can see all floors at once.
  Use reset_explode to collapse back.

Clipping / sectioning:
- create_clip_plane: Create a single section cut (specify normal + offset).
- create_clip_box: Create a 6-plane clipping box to isolate a region of the building.
  Specify center (cx,cy,cz) and size (sx,sy,sz).
- list_clip_planes: See all active clipping planes with their indices.
- remove_clip_plane: Remove a specific plane by index.
- remove_clip_planes: Remove ALL clipping planes at once.

Measurements:
- measure_distance: 3D distance between two world-space points. Get world coords from
  raycast first, then measure between hit points.
- measure_angle: Angle at vertex B formed by points A-B-C. Returns degrees.
- measure_volume: Calculate the volume of specified elements (cubic meters).

RECOMMENDED WORKFLOWS:

1. Overview → Detail: reset_view → get_model_bounds → orbit → zoom in → pick_element.

2. Floor-by-floor: get_storeys → isolate_storey("Level 1") → explore → show_all_elements
   → isolate_storey("Level 2") → explore.

3. 2D plans: create_plan_views → list_plans → open_plan(id) → explore rooms → exit_plan.

4. Peel-away: Point camera at obstruction → pick_element → hide_elements(id) → repeat
   to reveal hidden interiors layer by layer.

5. Ghost + focus: Find elements with search_elements → ghost_all_except(ids) to see them
   highlighted in context → reset_ghost when done.

6. Measure: raycast at point A (get hitPoint) → raycast at point B → measure_distance
   between the two hitPoints.

7. Bookmark: Navigate to an interesting view → create_viewpoint("Main entrance") →
   continue exploring → load_viewpoint(guid) to return later.

When you've completed the task, respond with a final text summary starting with
"TASK COMPLETE:" followed by your findings. Always include specific visual observations
from screenshots in your answer."""


class BIMAgent:
    """GPT-5.2 agent that navigates BIM models via the Responses API."""

    def __init__(
        self,
        model: str = "gpt-5.2",
        max_steps: int = 30,
        verbose: bool = True,
    ):
        self.client = OpenAI()
        self.model = model
        self.max_steps = max_steps
        self.verbose = verbose
        self.mcp = MCPClient()
        self.input_items: list = []
        self.step_count = 0

    async def start(self) -> None:
        """Connect to MCP server."""
        await self.mcp.connect()
        tools = await self.mcp.list_tools()
        if self.verbose:
            print(f"[Agent] Connected. {len(tools)} tools available:")
            for t in tools:
                print(f"  → {t['name']}: {t['description'][:60]}...")

    async def run(self, task: str) -> str:
        """Run the vision-action loop for a given task."""
        print(f"\n{'='*60}")
        print(f"[Agent] Task: {task}")
        print(f"[Agent] Model: {self.model}")
        print(f"[Agent] Max steps: {self.max_steps}")
        print(f"{'='*60}\n")

        self.input_items = [
            {"role": "user", "content": f"Task: {task}\n\nStart by capturing a view of the model."},
        ]

        openai_tools = self.mcp.get_openai_tools_schema()

        for step in range(self.max_steps):
            self.step_count = step + 1
            print(f"\n--- Step {self.step_count}/{self.max_steps} ---")

            response = self.client.responses.create(
                model=self.model,
                instructions=SYSTEM_PROMPT,
                input=self.input_items,
                tools=openai_tools,
                tool_choice="auto",
                parallel_tool_calls=False,
                truncation="auto",
            )

            self.input_items += response.output

            function_calls = [
                item for item in response.output if item.type == "function_call"
            ]

            if not function_calls:
                final_text = response.output_text
                print(f"\n[Agent] Final response:\n{final_text}")
                return final_text

            for fc in function_calls:
                tool_name = fc.name
                tool_args = json.loads(fc.arguments)

                print(f"  🔧 {tool_name}({json.dumps(tool_args, indent=None)[:100]})")

                try:
                    result = await self.mcp.call_tool(tool_name, tool_args)
                    tool_output = self._format_tool_output(fc.call_id, result)
                    self.input_items.append(tool_output)

                    if self.verbose:
                        for block in result.get("content", []):
                            if block["type"] == "text":
                                print(f"     → {json.dumps(block['data'])[:120]}")
                            elif block["type"] == "image":
                                print(f"     → [Screenshot captured]")

                except Exception as e:
                    error_msg = f"Tool error: {str(e)}"
                    print(f"     ❌ {error_msg}")
                    self.input_items.append({
                        "type": "function_call_output",
                        "call_id": fc.call_id,
                        "output": error_msg,
                    })

        print(f"\n[Agent] Max steps ({self.max_steps}) reached")
        return "INCOMPLETE: Max steps reached"

    def _format_tool_output(self, call_id: str, result: dict) -> dict:
        """Format MCP tool result as a Responses API function_call_output.

        For tools that return images, the output is an array of input_text
        and input_image content items. For text-only tools, output is a
        plain JSON string.
        """
        content_blocks = result.get("content", [])
        has_image = any(b["type"] == "image" for b in content_blocks)

        if has_image:
            output_parts: list[dict] = []
            for block in content_blocks:
                if block["type"] == "image":
                    b64_data = block.get("data", "")
                    mime = block.get("mimeType", "image/png")
                    print(f"     📷 Image block: {len(b64_data)} base64 chars, mimeType={mime}")

                    self._save_debug_screenshot(b64_data)

                    output_parts.append({
                        "type": "input_image",
                        "image_url": f"data:{mime};base64,{b64_data}",
                        "detail": "auto",
                    })
                elif block["type"] == "text":
                    text = json.dumps(block["data"]) if isinstance(block["data"], dict) else str(block["data"])
                    output_parts.append({
                        "type": "input_text",
                        "text": text,
                    })

            return {
                "type": "function_call_output",
                "call_id": call_id,
                "output": output_parts,
            }

        text_parts = []
        for block in content_blocks:
            if block["type"] == "text":
                text_parts.append(
                    json.dumps(block["data"]) if isinstance(block["data"], dict) else str(block["data"])
                )

        return {
            "type": "function_call_output",
            "call_id": call_id,
            "output": "\n".join(text_parts),
        }

    def _save_debug_screenshot(self, b64_data: str) -> None:
        """Save the first screenshot to disk for debugging."""
        if hasattr(self, "_screenshot_saved"):
            return
        self._screenshot_saved = True
        try:
            img_bytes = base64.b64decode(b64_data)
            debug_path = os.path.join(os.path.dirname(__file__), "debug_screenshot.png")
            with open(debug_path, "wb") as f:
                f.write(img_bytes)
            print(f"     📷 DEBUG: Saved screenshot to {debug_path} ({len(img_bytes)} bytes)")
        except Exception as e:
            print(f"     📷 DEBUG: Failed to save screenshot: {e}")

    async def shutdown(self) -> None:
        """Clean up."""
        await self.mcp.disconnect()


async def main():
    parser = argparse.ArgumentParser(description="RL-BIM Agent - GPT-5.2 BIM Navigator")
    parser.add_argument(
        "--task",
        type=str,
        default="Explore the building model. Start by getting an overview, then navigate to find the main entrance. Report what you see at each step.",
        help="Navigation task for the agent",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="gpt-5.2",
        help="OpenAI model to use (default: gpt-5.2)",
    )
    parser.add_argument(
        "--max-steps",
        type=int,
        default=30,
        help="Maximum number of agent steps (default: 30)",
    )
    parser.add_argument(
        "--model-url",
        type=str,
        default=None,
        help="URL to an IFC file to load before starting the task",
    )

    args = parser.parse_args()

    agent = BIMAgent(model=args.model, max_steps=args.max_steps)

    try:
        await agent.start()

        if args.model_url:
            print(f"[Agent] Loading model: {args.model_url}")
            result = await agent.mcp.call_tool("load_model", {"url": args.model_url})
            print(f"[Agent] Model loaded: {result}")

        result = await agent.run(args.task)

        print(f"\n{'='*60}")
        print(f"[Agent] Completed in {agent.step_count} steps")
        print(f"{'='*60}")

    finally:
        await agent.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
