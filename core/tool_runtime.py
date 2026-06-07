"""Tool execution/runtime layer compatibility shim."""

from brain.toolbox import execute_tool, get_available_tools, is_tool_allowed_for_untrusted_context
from brain.web_search import clear_last_search_sources, get_last_search_sources

__all__ = [
	"clear_last_search_sources",
	"execute_tool",
	"get_available_tools",
	"get_last_search_sources",
	"is_tool_allowed_for_untrusted_context",
]
