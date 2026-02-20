"""
RL-BIM Agent – GPT-5.2 Vision-Action Loop

Connects to the BIM viewer via MCP and uses GPT-5.2's vision capabilities
to autonomously navigate building models. The loop:
  1. Captures a screenshot of the current 3D view
  2. Sends it to GPT-5.2 with the task prompt and tool definitions
  3. Executes any tool calls the model returns
  4. Repeats until the model says it's done or max steps reached
"""

import asyncio
import argparse
import base64
import json
import os
import sys
from pathlib import Path
from datetime import datetime

from dotenv import load_dotenv
from openai import OpenAI

from mcp_client import MCPClient

# Load .env from project root
load_dotenv(Path(__file__).parent.parent / ".env")


SYSTEM_PROMPT = """You are an expert BIM (Building Information Modeling) navigator with excellent vision.
You are controlling a 3D building model viewer through a camera. Every time you move the camera
(orbit, pan, zoom, set_camera_position, reset_view), you automatically receive a screenshot
showing the result.

IMPORTANT RULES FOR VISUAL ANALYSIS:
1. You MUST carefully examine every screenshot you receive. Describe what you SEE in the image:
   colors, shapes, materials, spatial relationships, building elements visible.
2. NEVER guess or assume colors/materials — always base your answers on what is visually
   apparent in the screenshots. If the walls look red, say red. If they look grey, say grey.
3. Use camera tools aggressively to explore — orbit around the building, zoom in on details,
   create section cuts to see interiors. Each camera action gives you a new screenshot.
4. When answering questions about visual properties (color, shape, size), zoom in close
   to the relevant elements for a clear view before answering.

Navigation strategy:
- Start with reset_view to get an overview of the entire model
- Orbit the camera to see different facades
- Zoom in to inspect details like materials, windows, doors
- Use search_elements to find specific building elements by name or IFC type
- Use get_element_properties to read detailed IFC data
- Use highlight_elements to visually mark found elements
- Use create_clip_plane to see internal structure (rooms, stairs, etc.)
- Use set_camera_position to jump to specific coordinates near elements of interest

When you've completed the task, respond with a final text summary starting with
"TASK COMPLETE:" followed by your findings. Always include specific visual observations
from screenshots in your answer."""


class BIMAgent:
    """GPT-5.2 agent that navigates BIM models via vision + MCP tools."""

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
        self.conversation: list[dict] = []
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

        # Initialize conversation with system prompt + task
        self.conversation = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Task: {task}\n\nStart by capturing a view of the model."},
        ]

        openai_tools = self.mcp.get_openai_tools_schema()

        for step in range(self.max_steps):
            self.step_count = step + 1
            print(f"\n--- Step {self.step_count}/{self.max_steps} ---")

            # Call GPT-5.2
            response = self.client.chat.completions.create(
                model=self.model,
                messages=self.conversation,
                tools=openai_tools,
                tool_choice="auto",
                parallel_tool_calls=True,
                max_completion_tokens=4096,
            )

            msg = response.choices[0].message

            # Add assistant message to conversation
            self.conversation.append(msg.model_dump())

            # Check if model is done (no tool calls, just text)
            if not msg.tool_calls:
                final_text = msg.content or ""
                print(f"\n[Agent] Final response:\n{final_text}")
                return final_text

            # Execute tool calls
            for tool_call in msg.tool_calls:
                func = tool_call.function
                tool_name = func.name
                tool_args = json.loads(func.arguments)

                print(f"  🔧 {tool_name}({json.dumps(tool_args, indent=None)[:100]})")

                try:
                    result = await self.mcp.call_tool(tool_name, tool_args)

                    # Build tool result message
                    tool_content = self._format_tool_result(result, tool_name)

                    self.conversation.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": tool_content,
                    })

                    if self.verbose:
                        # Show text results
                        for block in result.get("content", []):
                            if block["type"] == "text":
                                print(f"     → {json.dumps(block['data'])[:120]}")
                            elif block["type"] == "image":
                                print(f"     → [Screenshot captured]")

                except Exception as e:
                    error_msg = f"Tool error: {str(e)}"
                    print(f"     ❌ {error_msg}")
                    self.conversation.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": error_msg,
                    })

        print(f"\n[Agent] Max steps ({self.max_steps}) reached")
        return "INCOMPLETE: Max steps reached"

    def _format_tool_result(self, result: dict, tool_name: str) -> str | list:
        """Format MCP tool result for OpenAI conversation."""
        content_blocks = result.get("content", [])

        # If there's an image, return multimodal content
        has_image = any(b["type"] == "image" for b in content_blocks)

        if has_image:
            formatted: list[dict] = []
            for block in content_blocks:
                if block["type"] == "image":
                    b64_data = block.get("data", "")
                    mime = block.get("mimeType", "image/png")
                    print(f"     📷 Image block: {len(b64_data)} base64 chars, mimeType={mime}")

                    # Debug: save first screenshot to disk
                    if not hasattr(self, '_screenshot_saved'):
                        self._screenshot_saved = True
                        try:
                            img_bytes = base64.b64decode(b64_data)
                            debug_path = os.path.join(os.path.dirname(__file__), "debug_screenshot.png")
                            with open(debug_path, "wb") as f:
                                f.write(img_bytes)
                            print(f"     📷 DEBUG: Saved screenshot to {debug_path} ({len(img_bytes)} bytes)")
                        except Exception as e:
                            print(f"     📷 DEBUG: Failed to save screenshot: {e}")

                    formatted.append({
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime};base64,{b64_data}",
                            "detail": "auto",
                        },
                    })
                elif block["type"] == "text":
                    formatted.append({
                        "type": "text",
                        "text": json.dumps(block["data"]) if isinstance(block["data"], dict) else str(block["data"]),
                    })
            return formatted  # type: ignore

        # Text-only result
        parts = []
        for block in content_blocks:
            if block["type"] == "text":
                parts.append(
                    json.dumps(block["data"]) if isinstance(block["data"], dict) else str(block["data"])
                )
        return "\n".join(parts)

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

        # Load a model if specified
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
