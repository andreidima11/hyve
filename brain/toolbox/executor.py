from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from core.logger import log_line
from brain.tool_shell import (
    exec_allow_shell,
    exec_run_script,
    exec_run_shell,
    exec_suggest_shell,
)
from brain.tool_workspace import (
    exec_propose_file,
    exec_propose_patch,
    exec_read_file,
    project_root,
)
from brain.toolbox.guardrails import _tool_guardrails_enabled, is_tool_allowed_for_untrusted_context
from brain.toolbox import handlers as _handlers

async def execute_tool(
    name: str,
    arguments: Dict[str, Any],
    user_id: str,
    status_queue: Optional[Any] = None,
    untrusted_context: bool = False,
) -> str:
    """
    Execute a tool call and return a text result for the AI to see.
    status_queue: optional asyncio.Queue(); tools (e.g. create_skill) may put {"type", "label"} for UI steps.
    """
    log_line("agent", "🔧", "TOOL CALL", f"{name}({json.dumps(arguments, ensure_ascii=False)[:200]})")

    if untrusted_context and _tool_guardrails_enabled() and not is_tool_allowed_for_untrusted_context(name):
        log_line("warn", "🛡️", "TOOL BLOCK", f"Blocked {name} during untrusted-content turn")
        return (
            f"Blocked tool '{name}': this turn contains untrusted image or external content, "
            "so only a limited read-only tool subset is allowed. Ask the user to restate the request in their own words."
        )

    try:
        if name == "validate_automation_yaml":
            return await _handlers._exec_validate_automation_yaml(arguments)
        elif name == "list_automation_definitions":
            return await _handlers._exec_list_automation_definitions(user_id)
        elif name == "get_automation_definition":
            return await _handlers._exec_get_automation_definition(arguments, user_id)
        elif name == "create_automation_definition":
            return await _handlers._exec_create_automation_definition(arguments, user_id)
        elif name == "update_automation_definition":
            return await _handlers._exec_update_automation_definition(arguments, user_id)
        elif name == "enable_automation_definition":
            return await _handlers._exec_enable_automation_definition(arguments, user_id)
        elif name == "disable_automation_definition":
            return await _handlers._exec_disable_automation_definition(arguments, user_id)
        elif name == "delete_automation_definition":
            return await _handlers._exec_delete_automation_definition(arguments, user_id)
        elif name == "run_automation_definition":
            return await _handlers._exec_run_automation_definition(arguments, user_id)
        elif name == "search_web":
            return await _handlers._exec_search_web(arguments)
        elif name == "search_web_images":
            return await _handlers._exec_search_web_images(arguments)
        elif name == "read_web_page":
            return await _handlers._exec_read_web_page(arguments)
        elif name == "extract_web_data":
            return await _handlers._exec_extract_web_data(arguments)
        elif name == "recall_memory":
            return await _handlers._exec_recall_memory(arguments, user_id)
        elif name == "store_memory":
            return await _handlers._exec_store_memory(arguments, user_id)
        elif name == "get_app_help":
            return _handlers._exec_get_app_help(arguments)
        elif name == "get_system_status":
            return _handlers._exec_get_system_status(arguments)
        elif name == "get_conversation_history":
            return _handlers._exec_get_conversation_history(arguments, user_id)
        elif name == "run_skill":
            return await _handlers._exec_run_skill(arguments, user_id)
        elif name == "create_skill":
            return await _handlers._exec_create_skill(arguments, status_queue=status_queue)
        elif name == "edit_skill":
            return await _handlers._exec_edit_skill(arguments)
        elif name == "improve_skill":
            return await _handlers._exec_improve_skill(arguments)
        elif name == "allow_shell":
            return exec_allow_shell(user_id)
        elif name == "run_shell":
            return await exec_run_shell(arguments, user_id, project_root())
        elif name == "suggest_shell":
            return exec_suggest_shell(arguments, user_id)
        elif name == "read_file":
            return await exec_read_file(arguments, user_id)
        elif name == "run_script":
            return await exec_run_script(arguments, user_id, project_root())
        elif name == "propose_patch":
            return await exec_propose_patch(arguments, user_id)
        elif name == "propose_file":
            return await exec_propose_file(arguments, user_id)
        elif name == "cctv_describe":
            return await _handlers._exec_cctv_describe(arguments)
        elif name == "generate_image":
            return await _handlers._exec_generate_image(arguments)
        elif name == "get_pago_data":
            from brain.tool_pago import exec_get_pago_data
            return await exec_get_pago_data(arguments)
        elif name == "control_device":
            return await _handlers._exec_control_device(arguments)
        elif name == "get_home_status":
            return await _handlers._exec_get_home_status(arguments)
        elif name == "get_entity_history":
            return await _handlers._exec_get_entity_history(arguments)
        elif name == "get_device_state":
            return await _handlers._exec_get_device_state(arguments)
        elif name == "planner_add_entry":
            return await _handlers._exec_planner_add_entry(arguments, user_id)
        elif name == "planner_add_list":
            return await _handlers._exec_planner_add_list(arguments, user_id)
        elif name == "planner_list_lists":
            return await _handlers._exec_planner_list_lists(arguments, user_id)
        elif name == "planner_delete_list":
            return await _handlers._exec_planner_delete_list(arguments, user_id)
        elif name == "planner_update_entry":
            return await _handlers._exec_planner_update_entry(arguments, user_id)
        elif name == "planner_list_entries":
            return await _handlers._exec_planner_list_entries(arguments, user_id)
        elif name == "planner_complete_entry":
            return await _handlers._exec_planner_complete_entry(arguments, user_id)
        elif name == "planner_delete_entry":
            return await _handlers._exec_planner_delete_entry(arguments, user_id)
        else:
            return f"Unknown tool: {name}"
    except Exception as e:
        log_line("error", "⚠️", "TOOL ERROR", f"{name}: {type(e).__name__}: {e}")
        return f"Error executing {name}: {type(e).__name__}: {e}"

