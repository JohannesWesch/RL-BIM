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

SYSTEM_PROMPT = """You are a BIM inspection agent. A 3D IFC model is already loaded.

TOOLS (4):
1. list_elements(ifc_type?) — list all elements (optionally filtered by type like 'IfcWall')
2. search_elements(query)  — search elements by name
3. mark_element(express_id) — highlight element red + zoom camera so it's centered and fully visible. Returns screenshot.
4. get_element_properties(express_id) — get full IFC properties

WORKFLOW:
1. list_elements or search_elements to find what you need
2. mark_element(id) to see it — analyze the screenshot
3. get_element_properties(id) if you need details
4. Repeat for other elements

RULES:
- Always mark_element before describing what something looks like.
- Use get_element_properties for materials, dimensions, classifications — never guess.
- When done: "TASK COMPLETE:" + your findings."""


class BIMAgent:
    def __init__(self, model: str = "gpt-5.2", max_steps: int = 30, verbose: bool = True):
        self.client = OpenAI()
        self.model = model
        self.max_steps = max_steps
        self.verbose = verbose
        self.mcp = MCPClient()
        self.input_items: list = []
        self.step_count = 0

    async def start(self) -> None:
        await self.mcp.connect()
        tools = await self.mcp.list_tools()
        if self.verbose:
            print(f"[Agent] Connected. {len(tools)} tools available.")

    async def run(self, task: str) -> str:
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
            function_calls = [item for item in response.output if item.type == "function_call"]

            if not function_calls:
                final = response.output_text
                print(f"\n[Agent] Final: {final}")
                return final

            for fc in function_calls:
                print(f"  -> {fc.name}({json.dumps(json.loads(fc.arguments))[:100]})")
                try:
                    result = await self.mcp.call_tool(fc.name, json.loads(fc.arguments))
                    self.input_items.append(self._format_tool_output(fc.call_id, result))
                except Exception as e:
                    print(f"     Error: {e}")
                    self.input_items.append({
                        "type": "function_call_output",
                        "call_id": fc.call_id,
                        "output": f"Error: {e}",
                    })

        return "INCOMPLETE: Max steps reached"

    def _format_tool_output(self, call_id: str, result: dict) -> dict:
        blocks = result.get("content", [])
        has_image = any(b["type"] == "image" for b in blocks)

        if has_image:
            parts: list[dict] = []
            for b in blocks:
                if b["type"] == "image":
                    mime = b.get("mimeType", "image/png")
                    parts.append({
                        "type": "input_image",
                        "image_url": f"data:{mime};base64,{b.get('data', '')}",
                        "detail": "auto",
                    })
                elif b["type"] == "text":
                    val = json.dumps(b["data"]) if isinstance(b["data"], dict) else str(b["data"])
                    parts.append({"type": "input_text", "text": val})
            return {"type": "function_call_output", "call_id": call_id, "output": parts}

        text_parts = []
        for b in blocks:
            if b["type"] == "text":
                text_parts.append(json.dumps(b["data"]) if isinstance(b["data"], dict) else str(b["data"]))
        return {"type": "function_call_output", "call_id": call_id, "output": "\n".join(text_parts)}

    async def shutdown(self) -> None:
        await self.mcp.disconnect()


async def main():
    parser = argparse.ArgumentParser(description="RL-BIM Agent")
    parser.add_argument("--task", type=str, default="Explore the building model.")
    parser.add_argument("--model", type=str, default="gpt-5.2")
    parser.add_argument("--max-steps", type=int, default=30)
    parser.add_argument("--model-url", type=str, default=None)
    args = parser.parse_args()

    agent = BIMAgent(model=args.model, max_steps=args.max_steps)
    try:
        await agent.start()
        if args.model_url:
            await agent.mcp.call_tool("load_model", {"url": args.model_url})
        result = await agent.run(args.task)
        print(f"\n[Agent] Result: {result}")
    finally:
        await agent.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
