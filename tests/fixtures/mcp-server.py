"""Offline MCP transport fixture, launched by the real shared service."""
from mcp.server.mcpserver import MCPServer

server = MCPServer("Offline test tools")


@server.tool()
def echo(text: str) -> str:
    return text


server.run()
