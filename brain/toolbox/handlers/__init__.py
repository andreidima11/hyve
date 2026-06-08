"""Tool execution handlers split by domain.

``import *`` does not re-export names starting with ``_``; executor.py
expects ``brain.toolbox.handlers._exec_*`` on this package namespace.
"""

from brain.toolbox.handlers.automation import (
    _exec_create_automation_definition,
    _exec_delete_automation_definition,
    _exec_disable_automation_definition,
    _exec_enable_automation_definition,
    _exec_get_automation_definition,
    _exec_list_automation_definitions,
    _exec_run_automation_definition,
    _exec_update_automation_definition,
    _exec_validate_automation_yaml,
)
from brain.toolbox.handlers.device import (
    _exec_control_device,
    _exec_get_device_state,
    _exec_get_entity_history,
    _exec_get_home_status,
)
from brain.toolbox.handlers.media import (
    _exec_cctv_describe,
    _exec_generate_image,
)
from brain.toolbox.handlers.memory import (
    _exec_recall_memory,
    _exec_store_memory,
)
from brain.toolbox.handlers.planner_entries import (
    _exec_planner_add_entry,
    _exec_planner_complete_entry,
    _exec_planner_delete_entry,
    _exec_planner_list_entries,
    _exec_planner_update_entry,
)
from brain.toolbox.handlers.planner_lists import (
    _exec_planner_add_list,
    _exec_planner_delete_list,
    _exec_planner_list_lists,
)
from brain.toolbox.handlers.skills import (
    _exec_create_skill,
    _exec_edit_skill,
    _exec_improve_skill,
    _exec_run_skill,
)
from brain.toolbox.handlers.system import (
    _exec_get_app_help,
    _exec_get_conversation_history,
    _exec_get_system_status,
)
from brain.toolbox.handlers.web import (
    _exec_extract_web_data,
    _exec_read_web_page,
    _exec_search_web,
    _exec_search_web_images,
)

__all__ = [
    "_exec_create_automation_definition",
    "_exec_delete_automation_definition",
    "_exec_disable_automation_definition",
    "_exec_enable_automation_definition",
    "_exec_get_automation_definition",
    "_exec_list_automation_definitions",
    "_exec_run_automation_definition",
    "_exec_update_automation_definition",
    "_exec_validate_automation_yaml",
    "_exec_control_device",
    "_exec_get_device_state",
    "_exec_get_entity_history",
    "_exec_get_home_status",
    "_exec_cctv_describe",
    "_exec_generate_image",
    "_exec_recall_memory",
    "_exec_store_memory",
    "_exec_planner_add_entry",
    "_exec_planner_complete_entry",
    "_exec_planner_delete_entry",
    "_exec_planner_list_entries",
    "_exec_planner_update_entry",
    "_exec_planner_add_list",
    "_exec_planner_delete_list",
    "_exec_planner_list_lists",
    "_exec_create_skill",
    "_exec_edit_skill",
    "_exec_improve_skill",
    "_exec_run_skill",
    "_exec_get_app_help",
    "_exec_get_conversation_history",
    "_exec_get_system_status",
    "_exec_extract_web_data",
    "_exec_read_web_page",
    "_exec_search_web",
    "_exec_search_web_images",
]
