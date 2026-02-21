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

FRAMES_DIR = Path(__file__).parent / "frames"
if not FRAMES_DIR.exists():
    FRAMES_DIR.mkdir(parents=True)

SYSTEM_PROMPT = """You are a BIM inspection agent navigating a 3D IFC model."""


class BIMAgent:
    def __init__(self, model: str = "gpt-5.2", max_steps: int = 30, verbose: bool = True):
        self.client = OpenAI()
        self.model = model
        self.max_steps = max_steps
        self.verbose = verbose
        self.mcp = MCPClient()
        self.input_items: list = []
        self.step_count = 0
        self.frame_counter = 0

    async def start(self) -> None:
        await self.mcp.connect()
        tools = await self.mcp.list_tools()
        if self.verbose:
            print(f"[Agent] Connected. {len(tools)} tools available.")

    async def run(self, task: str) -> str:
        self.input_items = [
            {"role": "user", "content": task},
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
                parallel_tool_calls=True,
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
                    img_data = b.get("data", "")

                    self.frame_counter += 1
                    ext = "jpg" if "jpeg" in mime else "png"
                    frame_path = FRAMES_DIR / f"frame_{self.frame_counter}.{ext}"
                    try:
                        with open(frame_path, "wb") as f:
                            f.write(base64.b64decode(img_data))
                        all_frames = sorted(FRAMES_DIR.glob("frame_*.*"), key=os.path.getmtime)
                        while len(all_frames) > 10:
                            all_frames.pop(0).unlink()
                    except Exception as e:
                        print(f"Failed to save frame: {e}")

                    parts.append({
                        "type": "input_image",
                        "image_url": f"data:{mime};base64,{img_data}",
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
