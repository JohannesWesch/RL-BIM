"""
MCP Client – spawns the RL-BIM MCP server as a subprocess and provides
a clean async interface for calling BIM navigation tools.
"""

import asyncio
import json
import os
from pathlib import Path
from contextlib import AsyncExitStack

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


class MCPClient:
    """Manages connection to the RL-BIM MCP server via stdio."""

    def __init__(self, server_dir: str | None = None):
        self.server_dir = server_dir or str(
            Path(__file__).parent.parent / "mcp-server"
        )
        self.session: ClientSession | None = None
        self._exit_stack = AsyncExitStack()
        self._tools_cache: list[dict] | None = None

    async def connect(self) -> None:
        """Start the MCP server subprocess and connect."""
        server_params = StdioServerParameters(
            command="npx",
            args=["tsx", "index.ts"],
            cwd=self.server_dir,
        )

        stdio_transport = await self._exit_stack.enter_async_context(
            stdio_client(server_params)
        )
        read_stream, write_stream = stdio_transport
        self.session = await self._exit_stack.enter_async_context(
            ClientSession(read_stream, write_stream)
        )

        await self.session.initialize()
        print(f"[MCP Client] Connected to RL-BIM MCP server")

    async def list_tools(self) -> list[dict]:
        """List available tools from the server."""
        if not self.session:
            raise RuntimeError("Not connected")

        response = await self.session.list_tools()
        tools = []
        for tool in response.tools:
            tools.append({
                "name": tool.name,
                "description": tool.description or "",
                "input_schema": tool.inputSchema,
            })
        self._tools_cache = tools
        return tools

    async def call_tool(self, name: str, arguments: dict) -> dict:
        """Call a tool and return the result."""
        if not self.session:
            raise RuntimeError("Not connected")

        result = await self.session.call_tool(name, arguments)

        # Parse content blocks
        response: dict = {"content": []}
        for block in result.content:
            if block.type == "text":
                try:
                    response["content"].append({
                        "type": "text",
                        "data": json.loads(block.text),
                    })
                except json.JSONDecodeError:
                    response["content"].append({
                        "type": "text",
                        "data": block.text,
                    })
            elif block.type == "image":
                response["content"].append({
                    "type": "image",
                    "data": block.data,
                    "mimeType": block.mimeType,
                })

        return response

    def get_openai_tools_schema(self) -> list[dict]:
        """Convert MCP tools to OpenAI Responses API function tool schema."""
        if not self._tools_cache:
            raise RuntimeError("Call list_tools() first")

        openai_tools = []
        for tool in self._tools_cache:
            openai_tools.append({
                "type": "function",
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["input_schema"],
            })
        return openai_tools

    async def disconnect(self) -> None:
        """Clean shutdown."""
        await self._exit_stack.aclose()
        self.session = None
