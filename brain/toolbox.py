"""
Toolbox: tool definitions (OpenAI function-calling format) + executor for agent mode.

The AI decides which tools to call. The code just executes them.
"""
import base64
import json
import os
import re
import html
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple
from datetime import datetime, timedelta
from collections import OrderedDict

import asyncio
import httpx
import yaml
from fastapi import HTTPException
import settings as settings_mod
import database
import automation_definitions
import home_assistant
import models
from memory_context import get_memory_context
from logger import log_line, log_detail
from brain.injection_guard import sanitize_untrusted_content
from brain.tool_shell import (
    _shell_config,
    exec_allow_shell,
    exec_run_script,
    exec_run_shell,
    exec_suggest_shell,
    get_last_shell_run,
    get_last_suggest_shell,
)
from brain.tool_workspace import (
    apply_proposal,
    exec_propose_file,
    exec_propose_patch,
    exec_read_file,
    get_last_proposal,
    project_root,
)
from brain.web_search import (
    _extract_by_selectors,
    _extract_relevant_paragraphs,
    _fetch_page_html,
    _fetch_page_text,
    _is_internal_url,
    _searxng_defaults,
    clear_last_search_sources,
    get_last_search_sources,
    searxng_search,
    searxng_search_images,
    set_last_search_sources,
)


def _is_explicit_skill_request(description: str) -> bool:
    """Guardrail: create_skill should run only when user explicitly asks for coding/tool creation."""
    d = (description or "").strip().lower()
    if len(d) < 3:
        return False
    explicit_markers = (
        "skill", "tool", "plugin", "script", "function", "automation module",
        "code", "coding", "program", "implementation", "api endpoint",
        "creeaza un skill", "fă un skill", "fa un skill", "construieste un tool",
        "scrie un script", "genereaza cod", "editeaza skill", "improve skill",
    )
    return any(marker in d for marker in explicit_markers)


def _guard(text: str, source: str) -> str:
    """Apply anti-injection guard if enabled in config."""
    sec = (settings_mod.CFG.get("security") or {})
    if sec.get("anti_injection", True):
        return sanitize_untrusted_content(text, source)
    return text


def _tool_guardrails_enabled() -> bool:
    """Check if tool guardrails (shell approval, etc.) are enabled."""
    return (settings_mod.CFG.get("security") or {}).get("tool_guardrails", True)


_UNTRUSTED_CONTEXT_SAFE_TOOL_NAMES = frozenset({
    "search_web",
    "search_web_images",
    "read_web_page",
    "extract_web_data",
    "cctv_describe",
})


def is_tool_allowed_for_untrusted_context(name: str) -> bool:
    """Only allow a narrow read-only subset when the current turn is tainted by untrusted content."""
    return (name or "") in _UNTRUSTED_CONTEXT_SAFE_TOOL_NAMES


# ---------------------------------------------------------------------------
# 1. TOOL DEFINITIONS  (OpenAI function-calling format)
# ---------------------------------------------------------------------------

TOOL_CONTROL_DEVICE = {
    "type": "function",
    "function": {
        "name": "control_device",
        "description": (
            "Control a smart home device (on/off/toggle, brightness, color temp). "
            "You MUST call this for ANY device control request — text replies don't change anything. "
            "For dimming: action=turn_on + brightness (0-255). For 'lights off': action=turn_off."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "description": "The device name, alias, or entity_id to control (e.g. 'bedroom light', 'living room lamp', 'light.bedroom')."
                },
                "action": {
                    "type": "string",
                    "enum": ["turn_on", "turn_off", "toggle"],
                    "description": "The action to perform. Use turn_on for dimming (with brightness param). Use turn_off to switch off."
                },
                "brightness": {
                    "type": "integer",
                    "description": "Brightness level 0-255 for dimmable lights. 0=off, 1=minimum, 128=~50%, 255=full brightness. Only for lights. Requires action=turn_on."
                },
                "color_temp_kelvin": {
                    "type": "integer",
                    "description": "Color temperature in Kelvin (2000=warm/candle, 3000=warm white, 4000=neutral, 5500=daylight, 6500=cool white). Only for lights that support color temperature."
                }
            },
            "required": ["target", "action"]
        }
    }
}

TOOL_GET_HOME_STATUS = {
    "type": "function",
    "function": {
        "name": "get_home_status",
        "description": "Get live status of all smart-home devices (sensors, states). Use to check values or find entity_ids.",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": []
        }
    }
}

TOOL_CONTROL_DEVICES_BATCH = {
    "type": "function",
    "function": {
        "name": "control_devices_batch",
        "description": (
            "Control MULTIPLE smart home devices in one call. Use for: "
            "'turn off all lights', 'dim all bedroom lights to 50%', 'turn on all lights in the living room'. "
            "Provide a room/group name or 'all' and a domain filter. "
            "Do NOT use this for a single device — use control_device instead."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "room_or_group": {
                    "type": "string",
                    "description": "Room name (e.g. 'bedroom', 'living room') or 'all lights', 'all switches'. Use 'all' for everything."
                },
                "action": {
                    "type": "string",
                    "enum": ["turn_on", "turn_off", "toggle"],
                    "description": "The action to perform on all matching devices."
                },
                "domain_filter": {
                    "type": "string",
                    "description": "Optional: restrict to a specific domain ('light', 'switch', 'cover'). Leave empty to affect all controllable devices in the room."
                },
                "brightness": {
                    "type": "integer",
                    "description": "Optional: brightness 0-255 for dimmable lights. Only applies to light domain."
                },
                "color_temp_kelvin": {
                    "type": "integer",
                    "description": "Optional: color temperature in Kelvin (2000=warm, 4000=neutral, 6500=cool). Only for lights that support it."
                }
            },
            "required": ["room_or_group", "action"]
        }
    }
}

TOOL_CONTROL_MULTI_DEVICE = {
    "type": "function",
    "function": {
        "name": "control_multi_device",
        "description": (
            "Control MULTIPLE SPECIFIC devices in one call. Use when the user names 2+ individual devices "
            "(e.g. 'turn on bedroom light and turn off kitchen light', 'dim hall to 50% and set office to warm'). "
            "Each command specifies its own target, action, brightness, and color temp. "
            "Do NOT use control_devices_batch for this — that is for rooms/groups. "
            "Do NOT call control_device multiple times — use this instead."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "commands": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "target": {
                                "type": "string",
                                "description": "Device name, alias, or entity_id."
                            },
                            "action": {
                                "type": "string",
                                "enum": ["turn_on", "turn_off", "toggle"],
                                "description": "Action to perform."
                            },
                            "brightness": {
                                "type": "integer",
                                "description": "Optional brightness 0-255 for dimmable lights."
                            },
                            "color_temp_kelvin": {
                                "type": "integer",
                                "description": "Optional color temperature in Kelvin (2000-10000)."
                            }
                        },
                        "required": ["target", "action"]
                    },
                    "description": "Array of device commands to execute in parallel."
                }
            },
            "required": ["commands"]
        }
    }
}




TOOL_SET_AUTOMATION = {
    "type": "function",
    "function": {
        "name": "set_automation",
        "description": "Compatibility automation tool. Builds or updates a YAML automation definition from flat arguments. Prefer automation-definition tools for advanced creation or editing. Call when user asks to schedule a recurring automation or a timed skill.",
        "parameters": {
            "type": "object",
            "properties": {
                "automation_id": {"type": "string", "description": "Optional existing automation definition id to update. If omitted, a new definition is created."},
                "commands": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "action": {"type": "string", "enum": ["turn_on", "turn_off", "toggle"]},
                            "target": {"type": "string", "description": "Device name, alias, or entity_id."},
                            "brightness": {"type": "integer", "description": "Optional brightness 0-255 for dimmable lights."},
                            "color_temp_kelvin": {"type": "integer", "description": "Optional color temperature in Kelvin (2000-10000)."}
                        },
                        "required": ["action", "target"]
                    },
                    "description": "For HA automation: list of device commands. Omit when using skill_name."
                },
                "skill_name": {
                    "type": "string",
                    "description": "For skill automation: exact skill name (e.g. yahoo_finance). When set, the skill runs at the scheduled time and the result is sent to the user."
                },
                "skill_input": {
                    "type": "object",
                    "description": "Input for the skill (e.g. {\"symbol\": \"AAPL\"} for yahoo_finance)."
                },
                "title": {"type": "string", "description": "Human-readable automation title. If omitted, display_message or a generated title is used."},
                "description": {"type": "string", "description": "Optional longer description for the YAML automation."},
                "notify_message": {"type": "string", "description": "Optional notification when automation runs (HA only)."},
                "display_message": {"type": "string", "description": "Short description for the automations list."},
                "date": {"type": "string", "description": "For one-off: YYYY-MM-DD."},
                "time": {"type": "string", "description": "Time in HH:MM 24-hour format."},
                "recurrence": {"type": "string", "enum": ["none", "daily", "weekly", "biweekly"], "description": "Recurrence type."},
                "weekday": {"type": "string", "enum": ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], "description": "For weekly/biweekly: which day."}
            },
            "required": ["time"]
        }
    }
}

TOOL_VALIDATE_AUTOMATION_YAML = {
    "type": "function",
    "function": {
        "name": "validate_automation_yaml",
        "description": "Validate a YAML automation definition before creating or editing it.",
        "parameters": {
            "type": "object",
            "properties": {
                "source_yaml": {"type": "string", "description": "Full YAML automation definition."}
            },
            "required": ["source_yaml"]
        }
    }
}

TOOL_LIST_AUTOMATION_DEFINITIONS = {
    "type": "function",
    "function": {
        "name": "list_automation_definitions",
        "description": "List YAML-backed automation definitions for the current user, including revision, enabled state, next runs, and YAML file path.",
        "parameters": {"type": "object", "properties": {}, "required": []}
    }
}

TOOL_GET_AUTOMATION_DEFINITION = {
    "type": "function",
    "function": {
        "name": "get_automation_definition",
        "description": "Get one YAML-backed automation definition by automation_id, including source YAML and revision.",
        "parameters": {
            "type": "object",
            "properties": {
                "automation_id": {"type": "string", "description": "Automation definition id."}
            },
            "required": ["automation_id"]
        }
    }
}

TOOL_CREATE_AUTOMATION_DEFINITION = {
    "type": "function",
    "function": {
        "name": "create_automation_definition",
        "description": "Create a YAML-backed automation definition. This writes the canonical YAML file and compiles runtime jobs.",
        "parameters": {
            "type": "object",
            "properties": {
                "source_yaml": {"type": "string", "description": "Full YAML automation definition."}
            },
            "required": ["source_yaml"]
        }
    }
}

TOOL_UPDATE_AUTOMATION_DEFINITION = {
    "type": "function",
    "function": {
        "name": "update_automation_definition",
        "description": "Replace an existing YAML-backed automation definition. Fetch it first to get the current revision.",
        "parameters": {
            "type": "object",
            "properties": {
                "automation_id": {"type": "string", "description": "Existing automation definition id."},
                "source_yaml": {"type": "string", "description": "Full replacement YAML automation definition."},
                "expected_revision": {"type": "integer", "description": "Current revision returned by get_automation_definition."}
            },
            "required": ["automation_id", "source_yaml", "expected_revision"]
        }
    }
}

TOOL_ENABLE_AUTOMATION_DEFINITION = {
    "type": "function",
    "function": {
        "name": "enable_automation_definition",
        "description": "Enable an existing YAML-backed automation definition.",
        "parameters": {
            "type": "object",
            "properties": {
                "automation_id": {"type": "string", "description": "Automation definition id."},
                "expected_revision": {"type": "integer", "description": "Current revision returned by get_automation_definition."}
            },
            "required": ["automation_id", "expected_revision"]
        }
    }
}

TOOL_DISABLE_AUTOMATION_DEFINITION = {
    "type": "function",
    "function": {
        "name": "disable_automation_definition",
        "description": "Disable an existing YAML-backed automation definition.",
        "parameters": {
            "type": "object",
            "properties": {
                "automation_id": {"type": "string", "description": "Automation definition id."},
                "expected_revision": {"type": "integer", "description": "Current revision returned by get_automation_definition."}
            },
            "required": ["automation_id", "expected_revision"]
        }
    }
}

TOOL_DELETE_AUTOMATION_DEFINITION = {
    "type": "function",
    "function": {
        "name": "delete_automation_definition",
        "description": "Delete a YAML-backed automation definition and its compiled runtime jobs.",
        "parameters": {
            "type": "object",
            "properties": {
                "automation_id": {"type": "string", "description": "Automation definition id."}
            },
            "required": ["automation_id"]
        }
    }
}

TOOL_RUN_AUTOMATION_DEFINITION = {
    "type": "function",
    "function": {
        "name": "run_automation_definition",
        "description": "Run an automation definition immediately for testing.",
        "parameters": {
            "type": "object",
            "properties": {
                "automation_id": {"type": "string", "description": "Automation definition id."}
            },
            "required": ["automation_id"]
        }
    }
}


TOOL_SEARCH_WEB = {
    "type": "function",
    "function": {
        "name": "search_web",
        "description": "Search the web ONLY for genuinely current/time-sensitive info (today's news, live weather, current prices, recent events, things after your knowledge cutoff). Do NOT search for facts you already know (definitions, history, science, geography, famous people, how things work, programming, math). Reformulate into a short keyword-focused query (3-7 words). One search should usually be enough — do NOT chain multiple searches for the same question.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Optimized search engine query: short, keyword-focused, English preferred for technical topics. Reformulate the user's question — never use raw conversational text."
                }
            },
            "required": ["query"]
        }
    }
}

TOOL_SEARCH_WEB_IMAGES = {
    "type": "function",
    "function": {
        "name": "search_web_images",
        "description": "Find EXISTING images on the web (photos, diagrams, infographics). Do NOT use for creating/generating images — use generate_image instead. Include results as markdown ![desc](URL).",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query for images (e.g. 'electrical parallel wiring diagram', 'schiță legături electrice paralel')."
                }
            },
            "required": ["query"]
        }
    }
}

TOOL_READ_WEB_PAGE = {
    "type": "function",
    "function": {
        "name": "read_web_page",
        "description": "Fetch and read the text content of a web page. Extracts main article/body, drops nav/ads. Use when you have a URL from search_web and need its content.",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "Full URL of the page to read (must start with http:// or https://)."
                },
                "max_chars": {
                    "type": "integer",
                    "description": "Optional max characters to return (default from config, 500–15000). Omit to use config default."
                }
            },
            "required": ["url"]
        }
    }
}

TOOL_EXTRACT_WEB_DATA = {
    "type": "function",
    "function": {
        "name": "extract_web_data",
        "description": "Fetch a web page and extract specific elements by CSS selectors. Use when you need particular data from a page (e.g. a price, title, list) rather than the full text. Provide the URL and one or more CSS selectors (comma-separated). Optionally specify an attribute to extract (e.g. href for links); by default returns element text.",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "Full URL of the page (must start with http:// or https://)."
                },
                "selectors": {
                    "type": "string",
                    "description": "Comma-separated CSS selectors (e.g. 'h1, .price, #article-title'). Each selector may match multiple elements; up to 20 matches per selector are returned."
                },
                "attr": {
                    "type": "string",
                    "description": "Optional. If set (e.g. 'href', 'src'), return this attribute instead of element text. Use for links, image URLs, etc."
                }
            },
            "required": ["url", "selectors"]
        }
    }
}

TOOL_RECALL_MEMORY = {
    "type": "function",
    "function": {
        "name": "recall_memory",
        "description": "Search long-term memory for facts about this user (preferences, past info). Use when user asks about themselves.",
        "parameters": {
            "type": "object",
            "properties": {
                "topic": {
                    "type": "string",
                    "description": "What to search for in memory (e.g. 'favorite food', 'work schedule', 'hobbies')."
                }
            },
            "required": ["topic"]
        }
    }
}

TOOL_STORE_MEMORY = {
    "type": "function",
    "function": {
        "name": "store_memory",
        "description": "Save a personal fact about the user to long-term memory. MUST be called whenever the user shares personal information: preferences, possessions (vehicles, devices, pets), relationships, habits, plans, health info, job details, hobbies, or answers a question about themselves. Write a clear third-person statement (e.g. 'Likes Italian food', 'Has a Kawasaki Vulcan VN1500E from 1998', 'Works as a programmer at Google'). Do NOT store questions, greetings, or generic knowledge. After calling this tool, continue naturally — the UI shows confirmation automatically.",
        "parameters": {
            "type": "object",
            "properties": {
                "fact": {
                    "type": "string",
                    "description": "A clear factual statement about the user in third person (e.g. 'Prefers dark mode', 'Has a cat named Luna', 'Is allergic to shellfish')."
                }
            },
            "required": ["fact"]
        }
    }
}


TOOL_GET_PAGO_DATA = {
    "type": "function",
    "function": {
        "name": "get_pago_data",
        "description": "Retrieve financial data from Pago Plătește: bills (facturi), vehicles (vehicule), payment cards (carduri), payments history (plati), user profile (profil), subscription (abonament), or all at once. Use when the user asks about their bills, invoices, cars, payments, Pago account, or Romanian utility bills.",
        "parameters": {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "enum": ["all", "facturi", "vehicule", "carduri", "plati", "profil", "abonament"],
                    "description": "Data category: 'facturi' (bills/invoices), 'vehicule' (cars/vehicles), 'carduri' (payment cards), 'plati' (payment history), 'profil' (user profile), 'abonament' (subscription), 'all' (everything)."
                }
            },
            "required": ["category"]
        }
    }
}


TOOL_GET_CONVERSATION_HISTORY = {
    "type": "function",
    "function": {
        "name": "get_conversation_history",
        "description": "Retrieve earlier conversation messages that are NOT in the current prompt. Use when the user refers to something said earlier, asks 'what did I say', 'earlier', 'before', or when you need more context to understand a follow-up. Do NOT call this for new/standalone questions.",
        "parameters": {
            "type": "object",
            "properties": {
                "last_n": {
                    "type": "integer",
                    "description": "How many earlier messages to retrieve (default: 10, max: 30). Start small."
                }
            },
            "required": []
        }
    }
}

# Thread-safe storage for conversation history (set by cortex before agent loop)
_lazy_history_store: Dict[str, List[Dict]] = {}


TOOL_RUN_SKILL = {
    "type": "function",
    "function": {
        "name": "run_skill",
        "description": "Run a registered skill by name. See [AVAILABLE SKILLS] for names and descriptions.",
        "parameters": {
            "type": "object",
            "properties": {
                "skill_name": {
                    "type": "string",
                    "description": "The exact name of the skill to run."
                },
                "input": {
                    "type": "object",
                    "description": "Input parameters for the skill (usually {\"query\": \"...\"}). Depends on the skill."
                }
            },
            "required": ["skill_name"]
        }
    }
}

TOOL_CREATE_SKILL = {
    "type": "function",
    "function": {
        "name": "create_skill",
        "description": "Create a new skill via Forge. Describe what it should do; optional name_hint, inputs_hint, allow_network.",
        "parameters": {
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "A clear description of what the new skill should do."
                },
                "name_hint": {
                    "type": "string",
                    "description": "Optional suggested name for the skill (e.g. bible_quotes)."
                },
                "inputs_hint": {
                    "type": "string",
                    "description": "Optional: comma-separated input keys the skill will receive (e.g. query, user_id)."
                },
                "allow_network": {
                    "type": "boolean",
                    "description": "Set true if the skill needs network access (HTTP requests, socket connections, web search, connectivity checks, API calls). Skills with allow_network=false can only use pure computation."
                }
            },
            "required": ["description"]
        }
    }
}

TOOL_EDIT_SKILL = {
    "type": "function",
    "function": {
        "name": "edit_skill",
        "description": "Edit an existing generated skill. Give skill name and the change to apply. Only skills in skills/generated/.",
        "parameters": {
            "type": "object",
            "properties": {
                "skill_name": {"type": "string", "description": "Exact name of the skill to edit (e.g. bible_quote)."},
                "instruction": {"type": "string", "description": "What to change (e.g. 'add the Bible book name to the output')."}
            },
            "required": ["skill_name", "instruction"]
        }
    }
}

TOOL_IMPROVE_SKILL = {
    "type": "function",
    "function": {
        "name": "improve_skill",
        "description": "Fix a failed skill. Give skill name and error; Forge returns a fixed version.",
        "parameters": {
            "type": "object",
            "properties": {
                "skill_name": {"type": "string", "description": "Name of the skill that failed."},
                "error_message": {"type": "string", "description": "The error or user feedback (e.g. 'KeyError: query')."}
            },
            "required": ["skill_name", "error_message"]
        }
    }
}

TOOL_ALLOW_SHELL = {
    "type": "function",
    "function": {
        "name": "allow_shell",
        "description": "Enable shell for this user this session. Call only after user agreed (e.g. 'da', 'yes'). Then use run_shell.",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": []
        }
    }
}

TOOL_RUN_SHELL = {
    "type": "function",
    "function": {
        "name": "run_shell",
        "description": "Run one terminal command (e.g. curl ifconfig.me, df -h). User must have agreed first (allow_shell). Output returned.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The exact command to run (e.g. 'curl -s ifconfig.me', 'df -h', 'tail -50 /var/log/app.log'). No interactive or multi-command shells."
                }
            },
            "required": ["command"]
        }
    }
}

TOOL_SUGGEST_SHELL = {
    "type": "function",
    "function": {
        "name": "suggest_shell",
        "description": "Suggest a command for user to review (Run/Edit/Cancel). For transparency before running.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The command to suggest (e.g. 'curl -s ifconfig.me')."},
                "reason": {"type": "string", "description": "Optional short reason (e.g. 'Get your public IP')."}
            },
            "required": ["command"]
        }
    }
}

TOOL_READ_FILE = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "Read a file (config, code, logs). Path relative to project root. Avoid .env and secrets.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path to the file (e.g. 'config.json', 'main.py', 'docs/README.md')."},
                "limit_lines": {"type": "integer", "description": "Optional: read only the last N lines (e.g. 100 for log tail). Omit to read from start up to size limit."}
            },
            "required": ["path"]
        }
    }
}

TOOL_RUN_SCRIPT = {
    "type": "function",
    "function": {
        "name": "run_script",
        "description": "Run a short shell or Python script. User must have allowed shell first. Output returned.",
        "parameters": {
            "type": "object",
            "properties": {
                "language": {"type": "string", "enum": ["shell", "python"], "description": "Script language."},
                "script": {"type": "string", "description": "The script content (e.g. a one-liner or a few lines)."},
                "timeout_seconds": {"type": "integer", "description": "Optional timeout (default 10). Max 15."}
            },
            "required": ["language", "script"]
        }
    }
}

TOOL_PROPOSE_PATCH = {
    "type": "function",
    "function": {
        "name": "propose_patch",
        "description": "Propose a patch in a file. User sees diff and can Apply or Refuse. Path under allowed dirs.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path (e.g. 'docs/README.md', 'scripts/helper.sh')."},
                "old_snippet": {"type": "string", "description": "Exact lines to replace (1-5 lines). Must match the file."},
                "new_snippet": {"type": "string", "description": "Replacement text."}
            },
            "required": ["path", "old_snippet", "new_snippet"]
        }
    }
}

TOOL_PROPOSE_FILE = {
    "type": "function",
    "function": {
        "name": "propose_file",
        "description": "Propose creating a new file. User can Create or Refuse. Path under scripts/, docs/, ai_suggestions/.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path (e.g. 'docs/notes.md', 'scripts/backup.sh')."},
                "content": {"type": "string", "description": "Full file content."}
            },
            "required": ["path", "content"]
        }
    }
}

TOOL_CCTV_DESCRIBE = {
    "type": "function",
    "function": {
        "name": "cctv_describe",
        "description": "Get a description of what a CCTV camera currently sees. Use when the user asks what is visible on a camera, or to check a camera view. Available cameras are listed in the description.",
        "parameters": {
            "type": "object",
            "properties": {
                "camera_id": {
                    "type": "string",
                    "description": "Camera id or name (e.g. 'living_room', 'Camera 1', or exact name from the list)."
                }
            },
            "required": ["camera_id"]
        }
    }
}

TOOL_GENERATE_IMAGE = {
    "type": "function",
    "function": {
        "name": "generate_image",
        "description": "Generate a NEW image from a text description using AI. Use this — not search_web_images — when the user asks to create, draw, make, or generate an image. Returns a URL.",
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "Detailed text description of the image to generate. Be descriptive: include subject, style, lighting, colors, composition. Write in English for best results."
                },
                "negative_prompt": {
                    "type": "string",
                    "description": "Things to avoid in the image (e.g. 'blurry, deformed, low quality'). Optional."
                },
                "width": {
                    "type": "integer",
                    "description": "Image width in pixels (default: from config, typically 1024). Optional."
                },
                "height": {
                    "type": "integer",
                    "description": "Image height in pixels (default: from config, typically 1024). Optional."
                },
                "steps": {
                    "type": "integer",
                    "description": "Number of sampling steps (default: from config, typically 20). More steps = higher quality but slower. Optional."
                }
            },
            "required": ["prompt"]
        }
    }
}

# ---- Planner (entries / lists) tools ----

TOOL_PLANNER_ADD_LIST = {
    "type": "function",
    "function": {
        "name": "planner_add_list",
        "description": "Create a new planner to-do list. Use when user asks to create/add a list.",
        "parameters": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "List title (required)."
                },
                "color": {
                    "type": "string",
                    "description": "Optional color keyword or hex for UI (e.g. 'sky', '#38bdf8')."
                },
                "icon": {
                    "type": "string",
                    "description": "Optional icon name (e.g. 'inbox', 'briefcase')."
                }
            },
            "required": ["title"]
        }
    }
}

TOOL_PLANNER_LIST_LISTS = {
    "type": "function",
    "function": {
        "name": "planner_list_lists",
        "description": "List user's planner to-do lists.",
        "parameters": {
            "type": "object",
            "properties": {
                "include_archived": {
                    "type": "boolean",
                    "description": "Include archived lists. Default false."
                }
            },
            "required": []
        }
    }
}

TOOL_PLANNER_DELETE_LIST = {
    "type": "function",
    "function": {
        "name": "planner_delete_list",
        "description": "Delete a planner to-do list by id or exact list name.",
        "parameters": {
            "type": "object",
            "properties": {
                "list_id": {
                    "type": "integer",
                    "description": "List ID to delete."
                },
                "list_name": {
                    "type": "string",
                    "description": "Exact list title to delete (used if list_id is missing)."
                }
            },
            "required": []
        }
    }
}

TOOL_PLANNER_ADD_ENTRY = {
    "type": "function",
    "function": {
        "name": "planner_add_entry",
        "description": (
            "Add one or more entries (tasks or events) to the user's planner. "
            "Call when the user asks to add a task, event, or reminder. "
            "Reminders should be created as events with a start_at time. "
            "Provide items as a JSON array. Each item needs entry_type and title at minimum."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "description": "Array of entries to create.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "entry_type": {
                                "type": "string",
                                "enum": ["task", "event"],
                                "description": "Type of entry: task (actionable), event (calendar/reminder)."
                            },
                            "title": {
                                "type": "string",
                                "description": "Short title for the entry (max 200 chars)."
                            },
                            "content": {
                                "type": "string",
                                "description": "Optional longer description or details."
                            },
                            "due_at": {
                                "type": "string",
                                "description": "Due date for tasks: YYYY-MM-DDTHH:MM format. Optional."
                            },
                            "start_at": {
                                "type": "string",
                                "description": "Start datetime for events: YYYY-MM-DDTHH:MM format. Optional."
                            },
                            "end_at": {
                                "type": "string",
                                "description": "End datetime for events: YYYY-MM-DDTHH:MM format. Optional."
                            },
                            "priority": {
                                "type": "integer",
                                "description": "Priority 1-5 for tasks (1=highest). Optional."
                            },
                            "all_day": {
                                "type": "boolean",
                                "description": "True for all-day events. Optional."
                            },
                            "location": {
                                "type": "string",
                                "description": "Location for events. Optional."
                            },
                            "list_name": {
                                "type": "string",
                                "description": "Name of the target list (created if missing). Defaults to 'Inbox'."
                            }
                        },
                        "required": ["entry_type", "title"]
                    }
                }
            },
            "required": ["items"]
        }
    }
}

TOOL_PLANNER_LIST_ENTRIES = {
    "type": "function",
    "function": {
        "name": "planner_list_entries",
        "description": (
            "List entries from the user's planner. Use when the user asks what's on their list, "
            "what tasks they have, upcoming events, etc. Supports filtering by type, status, and smart views."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "view": {
                    "type": "string",
                    "enum": ["all", "today", "upcoming", "overdue", "recent"],
                    "description": "Smart view filter. 'all' returns everything. Default: 'all'."
                },
                "entry_type": {
                    "type": "string",
                    "enum": ["task", "event"],
                    "description": "Filter by entry type. Optional — omit to include all types."
                },
                "status": {
                    "type": "string",
                    "enum": ["open", "done", "all"],
                    "description": "Filter tasks by status. 'open' = not done. Default: 'all'."
                },
                "list_name": {
                    "type": "string",
                    "description": "Filter to a specific list by name. Optional."
                }
            },
            "required": []
        }
    }
}

TOOL_PLANNER_COMPLETE_ENTRY = {
    "type": "function",
    "function": {
        "name": "planner_complete_entry",
        "description": (
            "Mark a planner task as done (or toggle it back to todo). "
            "Call when the user says they finished a task or want to mark it complete. "
            "Use planner_list_entries first to find the entry ID if needed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "entry_id": {
                    "type": "integer",
                    "description": "The ID of the entry to toggle."
                },
                "done": {
                    "type": "boolean",
                    "description": "True to mark done, false to reopen. Default: true."
                }
            },
            "required": ["entry_id"]
        }
    }
}

TOOL_PLANNER_DELETE_ENTRY = {
    "type": "function",
    "function": {
        "name": "planner_delete_entry",
        "description": (
            "Delete an entry from the planner. Supports direct entry_id OR natural filters "
            "(title/date/time/type) for commands like 'delete today's event at 14:30'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "entry_id": {
                    "type": "integer",
                    "description": "The ID of the entry to delete."
                },
                "entry_type": {
                    "type": "string",
                    "enum": ["task", "event"],
                    "description": "Optional type filter when entry_id is missing."
                },
                "title_contains": {
                    "type": "string",
                    "description": "Optional case-insensitive title fragment when entry_id is missing."
                },
                "date": {
                    "type": "string",
                    "description": "Optional date filter YYYY-MM-DD when entry_id is missing."
                },
                "time_hm": {
                    "type": "string",
                    "description": "Optional exact time HH:MM for due_at/start_at when entry_id is missing."
                }
            },
            "required": []
        }
    }
}

TOOL_PLANNER_UPDATE_ENTRY = {
    "type": "function",
    "function": {
        "name": "planner_update_entry",
        "description": (
            "Edit an existing planner entry (task or event). Use for rename, reschedule, move between lists, "
            "content updates, priority/status changes, and event time updates."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "entry_id": {
                    "type": "integer",
                    "description": "Entry ID to update."
                },
                "title": {
                    "type": "string",
                    "description": "Updated title."
                },
                "content": {
                    "type": "string",
                    "description": "Updated content/details. Use empty string to clear."
                },
                "list_name": {
                    "type": "string",
                    "description": "Move entry to this list (creates list if missing)."
                },
                "due_at": {
                    "type": "string",
                    "description": "Task due datetime (ISO). Use empty string to clear."
                },
                "priority": {
                    "type": "integer",
                    "description": "Task priority 1-5."
                },
                "task_status": {
                    "type": "string",
                    "enum": ["todo", "in_progress", "done"],
                    "description": "Task status."
                },
                "start_at": {
                    "type": "string",
                    "description": "Event start datetime (ISO)."
                },
                "end_at": {
                    "type": "string",
                    "description": "Event end datetime (ISO)."
                },
                "all_day": {
                    "type": "boolean",
                    "description": "Event all-day flag."
                },
                "location": {
                    "type": "string",
                    "description": "Event location. Use empty string to clear."
                },
                "event_color": {
                    "type": "string",
                    "description": "Event color (hex or named value)."
                }
            },
            "required": ["entry_id"]
        }
    }
}

# ---------------------------------------------------------------------------
# 2. DYNAMIC TOOL LIST BUILDER
# ---------------------------------------------------------------------------

# Cache for tool list (invalidated when config changes)
_tools_cache: dict = {"fingerprint": "", "tools": [], "tools_anon": []}


def _tools_fingerprint() -> str:
    """Cheap fingerprint for tool-affecting config sections."""
    cfg = settings_mod.CFG
    parts = [
        str(cfg.get("home_assistant", {}).get("enabled")),
        str(cfg.get("searxng", {}).get("enabled")),
        str(cfg.get("searxng", {}).get("url", "")),
        str((cfg.get("intelligence") or {}).get("lazy_history", True)),
        str((cfg.get("intelligence") or {}).get("file_read", {}).get("enabled", True)),
        str((cfg.get("intelligence") or {}).get("run_script", {}).get("enabled", True)),
        str((cfg.get("intelligence") or {}).get("propose_patch", {}).get("enabled", True)),
        str((cfg.get("security") or {}).get("restrict_mutating_tools_on_untrusted_content", True)),
        str(cfg.get("skills_disabled") or []),
        str(bool((cfg.get("cctv") or {}).get("enabled"))),
        str(bool((cfg.get("comfyui") or {}).get("enabled"))),
        str(bool((cfg.get("coder") or {}).get("target_url", "").strip()
                  or (cfg.get("llm") or {}).get("target_url", "").strip())),
        # Device list mtime (changes when user toggles devices)
        str(_device_list_mtime()),
    ]
    return "|".join(parts)


def _device_list_mtime() -> float:
    try:
        return os.path.getmtime("ha_entities.json")
    except OSError:
        return 0.0


def get_available_tools(user_id: str, is_anonymous: bool = False) -> List[Dict]:
    """Build the tools array based on what is currently enabled. Descriptions may be dynamic (e.g. device count).
    When is_anonymous=True, dangerous tools (shell, HA control, file ops, forge) are excluded.
    Results are cached and invalidated when config changes."""
    fp = _tools_fingerprint()
    cache_key = "tools_anon" if is_anonymous else "tools"
    if _tools_cache["fingerprint"] == fp and _tools_cache[cache_key]:
        return list(_tools_cache[cache_key])  # shallow copy
    tools = _build_tools_list(is_anonymous)
    _tools_cache["fingerprint"] = fp
    _tools_cache[cache_key] = tools
    return list(tools)


def _build_tools_list(is_anonymous: bool) -> List[Dict]:
    """Build the tools array (uncached inner function)."""
    tools = []
    cfg = settings_mod.CFG

    # Home Assistant tools (not for anonymous users)
    if not is_anonymous and cfg.get("home_assistant", {}).get("enabled"):
        # control_device: inject dynamic device count into description
        control_tool = json.loads(json.dumps(TOOL_CONTROL_DEVICE))
        try:
            device_text = get_device_list_text()
            n = len([ln for ln in (device_text or "").split("\n") if ln.strip()]) if device_text else 0
            if n > 0:
                control_tool["function"]["description"] = (
                    (control_tool["function"].get("description") or "").rstrip(". ")
                    + f" There are {n} controllable devices listed in [AVAILABLE DEVICES]."
                )
        except Exception as e:
            log_line("warn", "⚠️", "TOOLS", f"Device count enrichment failed: {e}")
        tools.append(control_tool)
        tools.append(TOOL_GET_HOME_STATUS)
        tools.append(TOOL_CONTROL_DEVICES_BATCH)
        tools.append(TOOL_CONTROL_MULTI_DEVICE)
        tools.append(TOOL_SET_AUTOMATION)

    if not is_anonymous:
        tools.append(TOOL_VALIDATE_AUTOMATION_YAML)
        tools.append(TOOL_LIST_AUTOMATION_DEFINITIONS)
        tools.append(TOOL_GET_AUTOMATION_DEFINITION)
        tools.append(TOOL_CREATE_AUTOMATION_DEFINITION)
        tools.append(TOOL_UPDATE_AUTOMATION_DEFINITION)
        tools.append(TOOL_ENABLE_AUTOMATION_DEFINITION)
        tools.append(TOOL_DISABLE_AUTOMATION_DEFINITION)
        tools.append(TOOL_DELETE_AUTOMATION_DEFINITION)
        tools.append(TOOL_RUN_AUTOMATION_DEFINITION)

    # Planner tools (always available)
    tools.append(TOOL_PLANNER_ADD_LIST)
    tools.append(TOOL_PLANNER_LIST_LISTS)
    tools.append(TOOL_PLANNER_DELETE_LIST)
    tools.append(TOOL_PLANNER_ADD_ENTRY)
    tools.append(TOOL_PLANNER_UPDATE_ENTRY)
    tools.append(TOOL_PLANNER_LIST_ENTRIES)
    tools.append(TOOL_PLANNER_COMPLETE_ENTRY)
    tools.append(TOOL_PLANNER_DELETE_ENTRY)

    # Web search + read page + extract by selectors (when SearXNG/web is enabled)
    if cfg.get("searxng", {}).get("enabled") and cfg.get("searxng", {}).get("url"):
        tools.append(TOOL_SEARCH_WEB)
        tools.append(TOOL_SEARCH_WEB_IMAGES)
        tools.append(TOOL_READ_WEB_PAGE)
        tools.append(TOOL_EXTRACT_WEB_DATA)

    # Memory recall and store (always available – user memory about preferences/facts)
    tools.append(TOOL_RECALL_MEMORY)
    tools.append(TOOL_STORE_MEMORY)

    # Conversation history tool (only in lazy_history mode)
    intel = cfg.get("intelligence") or {}
    if intel.get("lazy_history", True):
        tools.append(TOOL_GET_CONVERSATION_HISTORY)

    # Skills
    try:
        from skills import get_skill_registry
        skill_list = get_skill_registry()
        disabled = cfg.get("skills_disabled") or []
        active_skills = [s for s in skill_list if s["name"] not in disabled]
        if active_skills:
            tools.append(TOOL_RUN_SKILL)
    except Exception as e:
        log_line("error", "⚠️", "TOOLS", f"Skill registry error: {e}")

    # Shell (allow_shell + run_shell + suggest_shell) — only when enabled in config; never for anon
    if not is_anonymous and _shell_config().get("enabled", True):
        tools.append(TOOL_ALLOW_SHELL)
        tools.append(TOOL_RUN_SHELL)
        tools.append(TOOL_SUGGEST_SHELL)

    # read_file (when enabled)
    fr_cfg = (cfg.get("intelligence") or {}).get("file_read") or {}
    if fr_cfg.get("enabled", True):
        tools.append(TOOL_READ_FILE)

    # run_script (when enabled; same permission as shell; never for anon)
    rs_cfg = (cfg.get("intelligence") or {}).get("run_script") or {}
    if not is_anonymous and rs_cfg.get("enabled", True) and _shell_config().get("enabled", True):
        tools.append(TOOL_RUN_SCRIPT)

    # propose_patch / propose_file (when enabled; never for anon)
    pp_cfg = (cfg.get("intelligence") or {}).get("propose_patch") or {}
    if not is_anonymous and pp_cfg.get("enabled", True):
        tools.append(TOOL_PROPOSE_PATCH)
        tools.append(TOOL_PROPOSE_FILE)

    # CCTV (when enabled, vision_llm OR main llm configured, and at least one camera)
    cctv_cfg = cfg.get("cctv") or {}
    vision_cfg = cfg.get("vision_llm") or {}
    llm_cfg_cctv = cfg.get("llm") or {}
    has_vision = bool((vision_cfg.get("target_url") or "").strip() and (vision_cfg.get("model_name") or "").strip())
    has_main_llm = bool((llm_cfg_cctv.get("target_url") or "").strip())
    if cctv_cfg.get("enabled") and (has_vision or has_main_llm):
        cameras = cctv_cfg.get("cameras") or []
        if cameras:
            cctv_tool = json.loads(json.dumps(TOOL_CCTV_DESCRIBE))
            cam_list = ", ".join(f"'{c.get('id') or c.get('name') or '?'}' ({c.get('name', '')})" for c in cameras[:20])
            cctv_tool["function"]["description"] = (
                (cctv_tool["function"].get("description") or "").rstrip(". ")
                + f" Available cameras: {cam_list}."
            )
            tools.append(cctv_tool)

    # ComfyUI image generation (when enabled)
    comfyui_cfg = cfg.get("comfyui") or {}
    if comfyui_cfg.get("enabled") and (comfyui_cfg.get("url") or "").strip():
        tools.append(TOOL_GENERATE_IMAGE)

    # Pago Plătește (bills, vehicles, payments — when enabled)
    pago_cfg = cfg.get("pago") or {}
    if pago_cfg.get("enabled") and (pago_cfg.get("email") or "").strip():
        tools.append(TOOL_GET_PAGO_DATA)

    # Forge (skill creation, edit, improve; never for anon)
    coder = cfg.get("coder") or {}
    llm = cfg.get("llm") or {}
    if not is_anonymous and ((coder.get("target_url") or "").strip() or (llm.get("target_url") or "").strip()):
        tools.append(TOOL_CREATE_SKILL)
        tools.append(TOOL_EDIT_SKILL)
        tools.append(TOOL_IMPROVE_SKILL)

    return tools


def get_device_list_text() -> str:
    """Return a compact device list for the agent system prompt (only controllable, selected devices)."""
    if not settings_mod.CFG.get("home_assistant", {}).get("enabled"):
        return ""
    try:
        return home_assistant.get_agent_device_list()
    except Exception as e:
        log_line("warn", "⚠️", "HA", f"get_agent_device_list failed: {e}")
    return ""


def get_skills_list_text() -> str:
    """Return a compact skills list for the system prompt."""
    try:
        from skills import get_skill_registry
        skill_list = get_skill_registry()
        disabled = settings_mod.CFG.get("skills_disabled") or []
        active = [s for s in skill_list if s["name"] not in disabled]
        if active:
            return "\n".join(f"- {s['name']}: {s['description']}" for s in active)
    except Exception as e:
        log_line("warn", "⚠️", "SKILLS", f"get_skill_registry failed: {e}")
    return "None available."


# ---------------------------------------------------------------------------
# 3. TOOL EXECUTOR
# ---------------------------------------------------------------------------

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
        if name == "control_device":
            return await _exec_control_device(arguments, user_id)
        elif name == "control_devices_batch":
            return await _exec_control_devices_batch(arguments, user_id)
        elif name == "control_multi_device":
            return await _exec_control_multi_device(arguments, user_id)
        elif name == "get_home_status":
            return await _exec_get_home_status(user_id)
        elif name == "set_automation":
            return await _exec_set_automation(arguments, user_id)
        elif name == "validate_automation_yaml":
            return await _exec_validate_automation_yaml(arguments)
        elif name == "list_automation_definitions":
            return await _exec_list_automation_definitions(user_id)
        elif name == "get_automation_definition":
            return await _exec_get_automation_definition(arguments, user_id)
        elif name == "create_automation_definition":
            return await _exec_create_automation_definition(arguments, user_id)
        elif name == "update_automation_definition":
            return await _exec_update_automation_definition(arguments, user_id)
        elif name == "enable_automation_definition":
            return await _exec_enable_automation_definition(arguments, user_id)
        elif name == "disable_automation_definition":
            return await _exec_disable_automation_definition(arguments, user_id)
        elif name == "delete_automation_definition":
            return await _exec_delete_automation_definition(arguments, user_id)
        elif name == "run_automation_definition":
            return await _exec_run_automation_definition(arguments, user_id)
        elif name == "search_web":
            return await _exec_search_web(arguments)
        elif name == "search_web_images":
            return await _exec_search_web_images(arguments)
        elif name == "read_web_page":
            return await _exec_read_web_page(arguments)
        elif name == "extract_web_data":
            return await _exec_extract_web_data(arguments)
        elif name == "recall_memory":
            return await _exec_recall_memory(arguments, user_id)
        elif name == "store_memory":
            return await _exec_store_memory(arguments, user_id)
        elif name == "get_conversation_history":
            return _exec_get_conversation_history(arguments, user_id)
        elif name == "run_skill":
            return await _exec_run_skill(arguments, user_id)
        elif name == "create_skill":
            return await _exec_create_skill(arguments, status_queue=status_queue)
        elif name == "edit_skill":
            return await _exec_edit_skill(arguments)
        elif name == "improve_skill":
            return await _exec_improve_skill(arguments)
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
            return await _exec_cctv_describe(arguments)
        elif name == "generate_image":
            return await _exec_generate_image(arguments)
        elif name == "get_pago_data":
            from brain.tool_pago import exec_get_pago_data
            return await exec_get_pago_data(arguments)
        elif name == "planner_add_entry":
            return await _exec_planner_add_entry(arguments, user_id)
        elif name == "planner_add_list":
            return await _exec_planner_add_list(arguments, user_id)
        elif name == "planner_list_lists":
            return await _exec_planner_list_lists(arguments, user_id)
        elif name == "planner_delete_list":
            return await _exec_planner_delete_list(arguments, user_id)
        elif name == "planner_update_entry":
            return await _exec_planner_update_entry(arguments, user_id)
        elif name == "planner_list_entries":
            return await _exec_planner_list_entries(arguments, user_id)
        elif name == "planner_complete_entry":
            return await _exec_planner_complete_entry(arguments, user_id)
        elif name == "planner_delete_entry":
            return await _exec_planner_delete_entry(arguments, user_id)
        else:
            return f"Unknown tool: {name}"
    except Exception as e:
        log_line("error", "⚠️", "TOOL ERROR", f"{name}: {type(e).__name__}: {e}")
        return f"Error executing {name}: {type(e).__name__}: {e}"


# ---------------------------------------------------------------------------
# 4. INDIVIDUAL TOOL IMPLEMENTATIONS
# ---------------------------------------------------------------------------

async def _exec_control_device(args: Dict, user_id: str) -> str:
    from brain.cortex import find_device_details, CONTEXT_LOCK, USER_CONTEXT

    target = (args.get("target") or "").strip()
    action = (args.get("action") or "toggle").strip().lower()
    if not target:
        return "Error: No target device specified."
    if action not in ("turn_on", "turn_off", "toggle"):
        return f"Error: Invalid action '{action}'. Use turn_on, turn_off, or toggle."

    entity_id, friendly_name = await find_device_details(target, user_id, user_message=target)
    if not entity_id:
        return f"Error: Could not find a device matching '{target}'. Check the device name or alias. Use only names/aliases from the [AVAILABLE DEVICES] list."

    # Build service_data for brightness / color_temp if provided
    service_data = {}
    brightness = args.get("brightness")
    if brightness is not None:
        try:
            brightness = int(brightness)
            if brightness < 0:
                brightness = 0
            elif brightness > 255:
                brightness = 255
            service_data["brightness"] = brightness
            # brightness=0 means turn off
            if brightness == 0:
                action = "turn_off"
                service_data = {}
            elif action != "turn_on":
                action = "turn_on"  # brightness requires turn_on service
        except (ValueError, TypeError):
            pass

    color_temp_kelvin = args.get("color_temp_kelvin")
    if color_temp_kelvin is not None:
        try:
            color_temp_kelvin = int(color_temp_kelvin)
            if 1000 <= color_temp_kelvin <= 10000:
                service_data["color_temp_kelvin"] = color_temp_kelvin
                if action != "turn_on":
                    action = "turn_on"
        except (ValueError, TypeError):
            pass

    domain = entity_id.split(".")[0]

    # ── POST-ACTION VERIFICATION: capture expected state before calling ──
    expected_state = "on" if action == "turn_on" else ("off" if action == "turn_off" else None)
    expected_attrs = {}
    if service_data.get("brightness") is not None:
        expected_attrs["brightness"] = service_data["brightness"]

    result = await home_assistant.call_service(domain, action, entity_id, service_data=service_data or None)
    if not result.get("ok"):
        err = result.get("error") or "Unknown error"
        log_line("agent", "❌", "DEVICE", f"HA call failed: {err}")

        # ── RETRY ONCE on transient errors ──
        if "timeout" in str(err).lower() or "exception" in str(err).lower():
            log_line("agent", "🔄", "DEVICE", f"Retrying {action} on {entity_id}...")
            await asyncio.sleep(0.5)
            result = await home_assistant.call_service(domain, action, entity_id, service_data=service_data or None)
            if not result.get("ok"):
                err2 = result.get("error") or "Unknown error"
                return f"Error: Home Assistant call failed after retry — {err2}. Device: {entity_id}."
        else:
            return f"Error: Home Assistant call failed — {err}. Device: {entity_id}."

    name = friendly_name or entity_id
    # Build descriptive action word
    if service_data.get("brightness") is not None:
        pct = round(service_data["brightness"] / 255 * 100)
        action_word = f"set to {pct}% brightness"
    else:
        action_word = {"turn_on": "turned on", "turn_off": "turned off", "toggle": "toggled"}.get(action, action)
    if service_data.get("color_temp_kelvin"):
        action_word += f" ({service_data['color_temp_kelvin']}K)"

    async with CONTEXT_LOCK:
        USER_CONTEXT[user_id] = {"entity_id": entity_id, "name": name, "last_action": action}

    # ── POST-ACTION VERIFICATION: confirm device actually changed state ──
    verification_note = ""
    try:
        from ha_websocket import ha_ws
        if ha_ws.is_connected and expected_state:
            verified, actual = await ha_ws.verify_entity_state(
                entity_id,
                expected_state,
                timeout=3.0,
                check_attrs=expected_attrs or None,
            )
            if verified:
                log_line("agent", "✅", "VERIFY", f"{entity_id} confirmed → {expected_state}")
                verification_note = " (verified)"
            else:
                actual_state = actual.get("state", "unknown") if actual else "unknown"
                log_line("agent", "⚠️", "VERIFY", f"{entity_id} expected={expected_state} actual={actual_state}")
                if actual_state != "unknown":
                    verification_note = f" (warning: device reports '{actual_state}' instead of '{expected_state}')"
    except ImportError:
        pass  # websocket module not available, skip verification
    except Exception as exc:
        log_line("agent", "⚠️", "VERIFY", f"Check failed: {type(exc).__name__}: {exc}")

    log_line("agent", "✅", "DEVICE", f"{action_word} {name} ({entity_id}){verification_note}")
    out = f"Success: {action_word} {name} ({entity_id}).{verification_note}"
    if (settings_mod.CFG.get("intelligence") or {}).get("richer_tool_results"):
        out = out.rstrip() + " You can use get_home_status to verify or control other devices."
    return out


async def _exec_control_devices_batch(args: Dict, user_id: str) -> str:
    """Execute a batch device control command (all lights in bedroom, all switches, etc.)."""
    from brain.cortex import CONTEXT_LOCK, USER_CONTEXT

    room_or_group = (args.get("room_or_group") or "").strip()
    action = (args.get("action") or "toggle").strip().lower()
    domain_filter = (args.get("domain_filter") or "").strip().lower() or None
    brightness = args.get("brightness")
    color_temp_kelvin = args.get("color_temp_kelvin")

    if not room_or_group:
        return "Error: No room or group specified."
    if action not in ("turn_on", "turn_off", "toggle"):
        return f"Error: Invalid action '{action}'. Use turn_on, turn_off, or toggle."

    # Resolve devices matching the room/group (with HA Areas API enrichment)
    try:
        entity_area_map = await home_assistant.fetch_entity_area_map()
    except Exception:
        entity_area_map = None
    devices = home_assistant.resolve_room_devices(room_or_group, domain_filter=domain_filter, entity_area_map=entity_area_map)
    if not devices:
        return f"Error: No controllable devices found for '{room_or_group}'" + (f" (domain: {domain_filter})" if domain_filter else "") + "."

    # Build service_data
    service_data = {}
    effective_action = action
    if brightness is not None:
        try:
            brightness = int(brightness)
            brightness = max(0, min(255, brightness))
            if brightness == 0:
                effective_action = "turn_off"
            else:
                service_data["brightness"] = brightness
                effective_action = "turn_on"
        except (ValueError, TypeError):
            pass

    if color_temp_kelvin is not None:
        try:
            color_temp_kelvin = int(color_temp_kelvin)
            if 1000 <= color_temp_kelvin <= 10000:
                service_data["color_temp_kelvin"] = color_temp_kelvin
                if effective_action != "turn_on":
                    effective_action = "turn_on"
        except (ValueError, TypeError):
            pass

    # Execute all calls in PARALLEL
    async def _call_one(dev: dict) -> tuple[dict, bool, str]:
        entity_id = dev["entity_id"]
        domain = dev.get("domain") or entity_id.split(".")[0]
        call_data = service_data if domain == "light" and service_data else None
        call_action = effective_action
        result = await home_assistant.call_service(domain, call_action, entity_id, service_data=call_data)
        if result.get("ok"):
            return dev, True, ""
        # Retry once on transient errors
        err = result.get("error") or "unknown"
        if "timeout" in str(err).lower() or "exception" in str(err).lower():
            await asyncio.sleep(0.5)
            result = await home_assistant.call_service(domain, call_action, entity_id, service_data=call_data)
            if result.get("ok"):
                return dev, True, ""
            err = result.get("error") or "unknown"
        return dev, False, err

    call_results = await asyncio.gather(*[_call_one(dev) for dev in devices])

    success_names = []
    failed_msgs = []
    for dev, ok, err in call_results:
        if ok:
            success_names.append(dev["name"])
        else:
            failed_msgs.append(f"{dev['name']} ({err})")

    # Build response
    total = len(devices)
    ok_count = len(success_names)
    fail_count = len(failed_msgs)

    if service_data.get("brightness") is not None:
        pct = round(service_data["brightness"] / 255 * 100)
        action_word = f"set to {pct}% brightness"
    else:
        action_word = {"turn_on": "turned on", "turn_off": "turned off", "toggle": "toggled"}.get(effective_action, effective_action)
    if service_data.get("color_temp_kelvin"):
        action_word += f" ({service_data['color_temp_kelvin']}K)"

    if fail_count == 0:
        msg = f"Success: {action_word} {ok_count} device(s) in '{room_or_group}': {', '.join(success_names)}."
    elif ok_count == 0:
        msg = f"Error: All {fail_count} device(s) failed: {'; '.join(failed_msgs)}."
    else:
        msg = f"Partial: {action_word} {ok_count}/{total} device(s). Failed: {'; '.join(failed_msgs)}."

    log_line("agent", "✅", "BATCH", msg[:200])

    # Update context with batch info
    if success_names:
        async with CONTEXT_LOCK:
            batch_entities = [{"entity_id": dev["entity_id"], "name": dev["name"]} for dev in devices if dev["name"] in success_names]
            USER_CONTEXT[user_id] = {
                "entity_id": devices[0]["entity_id"],
                "name": f"{room_or_group} ({ok_count} devices)",
                "last_action": effective_action,
                "entities": batch_entities,
            }

    return msg


async def _exec_control_multi_device(args: Dict, user_id: str) -> str:
    """Execute multiple individual device commands in parallel (each with its own target/action/brightness/color_temp)."""
    from brain.cortex import find_device_details, CONTEXT_LOCK, USER_CONTEXT

    commands = args.get("commands") or []
    if not commands or not isinstance(commands, list):
        return "Error: No commands provided. Expected array of {target, action} objects."

    # 1. Resolve all targets in parallel
    resolve_tasks = [
        find_device_details((cmd.get("target") or "").strip(), user_id, user_message=(cmd.get("target") or "").strip())
        for cmd in commands
    ]
    resolved = await asyncio.gather(*resolve_tasks)

    # 2. Build execution tasks for resolved devices
    exec_tasks = []
    exec_meta = []  # (cmd_dict, entity_id, friendly_name, service_data, effective_action)
    for cmd, (entity_id, friendly_name) in zip(commands, resolved):
        target = (cmd.get("target") or "").strip()
        action = (cmd.get("action") or "toggle").strip().lower()
        if not entity_id:
            exec_meta.append((cmd, None, target, None, action))
            continue
        if action not in ("turn_on", "turn_off", "toggle"):
            action = "toggle"

        service_data = {}
        brightness = cmd.get("brightness")
        if brightness is not None:
            try:
                brightness = int(brightness)
                brightness = max(0, min(255, brightness))
                if brightness == 0:
                    action = "turn_off"
                    service_data = {}
                else:
                    service_data["brightness"] = brightness
                    action = "turn_on"
            except (ValueError, TypeError):
                pass

        color_temp_kelvin = cmd.get("color_temp_kelvin")
        if color_temp_kelvin is not None:
            try:
                color_temp_kelvin = int(color_temp_kelvin)
                if 1000 <= color_temp_kelvin <= 10000:
                    service_data["color_temp_kelvin"] = color_temp_kelvin
                    if action != "turn_on":
                        action = "turn_on"
            except (ValueError, TypeError):
                pass

        domain = entity_id.split(".")[0]

        async def _do_call(d=domain, a=action, eid=entity_id, sd=service_data or None):
            result = await home_assistant.call_service(d, a, eid, service_data=sd)
            if not result.get("ok"):
                err = result.get("error") or "unknown"
                if "timeout" in str(err).lower() or "exception" in str(err).lower():
                    await asyncio.sleep(0.5)
                    result = await home_assistant.call_service(d, a, eid, service_data=sd)
            return result

        exec_tasks.append(_do_call())
        exec_meta.append((cmd, entity_id, friendly_name or entity_id, service_data or None, action))

    # 3. Execute all HA calls in parallel
    if exec_tasks:
        exec_results = await asyncio.gather(*exec_tasks, return_exceptions=True)
    else:
        exec_results = []

    # 4. Build response
    success_parts = []
    error_parts = []
    context_entities = []
    result_idx = 0
    for _cmd, entity_id, name, svc_data, action in exec_meta:
        if entity_id is None:
            error_parts.append(f"'{name}': device not found")
            continue
        result = exec_results[result_idx]
        result_idx += 1
        if isinstance(result, Exception):
            error_parts.append(f"{name}: {type(result).__name__}")
            continue
        if result.get("ok"):
            # Build descriptive action word
            if svc_data and svc_data.get("brightness") is not None:
                pct = round(svc_data["brightness"] / 255 * 100)
                action_word = f"set to {pct}%"
            else:
                action_word = {"turn_on": "turned on", "turn_off": "turned off", "toggle": "toggled"}.get(action, action)
            if svc_data and svc_data.get("color_temp_kelvin"):
                action_word += f" ({svc_data['color_temp_kelvin']}K)"
            success_parts.append(f"{action_word} {name}")
            context_entities.append({"entity_id": entity_id, "name": name})
            log_line("agent", "✅", "MULTI_DEV", f"{action_word} {name} ({entity_id})")
        else:
            err = result.get("error") or "unknown"
            error_parts.append(f"{name}: {err}")
            log_line("agent", "❌", "MULTI_DEV", f"Failed {name} ({entity_id}): {err}")

    # 5. Update context with all controlled devices
    if context_entities:
        async with CONTEXT_LOCK:
            USER_CONTEXT[user_id] = {
                "entities": context_entities,
                "last_action": exec_meta[-1][4] if exec_meta else "toggle",
            }

    # 6. Format output
    parts = []
    if success_parts:
        parts.append(f"Success: {'; '.join(success_parts)}.")
    if error_parts:
        parts.append(f"Failed: {'; '.join(error_parts)}.")
    return " ".join(parts) if parts else "Error: No commands could be executed."


async def _exec_get_home_status(user_id: str = "") -> str:
    try:
        status = await home_assistant.get_ai_context()
        if not status:
            return "No devices configured or Home Assistant offline."
        intel = settings_mod.CFG.get("intelligence") or {}
        if intel.get("richer_tool_results"):
            status = status.rstrip() + "\n\nYou can use control_device to change any of these."
        return status
    except Exception as e:
        return f"Error getting home status: {e}"


async def _exec_set_automation(args: Dict, user_id: str) -> str:
    commands = args.get("commands") or []
    skill_name = (args.get("skill_name") or "").strip()
    skill_input = args.get("skill_input") if isinstance(args.get("skill_input"), dict) else {}
    if not commands and not skill_name:
        return "Error: Provide either commands (HA devices) or skill_name (e.g. yahoo_finance with skill_input like {\"symbol\": \"AAPL\"})."

    notify_msg = (args.get("notify_message") or "").strip() or None
    display_msg = (args.get("display_message") or "").strip() or None
    date_str = (args.get("date") or "").strip()
    time_str = (args.get("time") or "09:00").strip()
    recurrence = (args.get("recurrence") or "none").strip().lower()
    weekday = (args.get("weekday") or "").strip().lower()

    channel = "whatsapp" if "@" in user_id else "web"

    title = (args.get("title") or display_msg or notify_msg or "").strip()
    description = (args.get("description") or "").strip() or None
    automation_id = (args.get("automation_id") or "").strip() or None
    try:
        source_yaml = _build_automation_yaml_from_legacy_args(
            args=args,
            user_id=user_id,
            title=title,
            description=description,
            automation_id=automation_id,
            channel=channel,
        )
    except automation_definitions.AutomationValidationError as exc:
        return f"Error: {exc}"

    db = database.SessionLocal()
    try:
        owner_id = _automation_owner_id(user_id)
        actor = _automation_actor(user_id)
        normalized = automation_definitions.validate_source_yaml(source_yaml)
        existing = db.query(models.AutomationDefinition).filter(
            models.AutomationDefinition.id == normalized["id"],
            models.AutomationDefinition.owner_id == owner_id,
        ).first()
        if existing:
            definition = automation_definitions.replace_definition(
                db,
                existing,
                actor=actor,
                source_yaml=source_yaml,
                expected_revision=int(existing.revision),
            )
            action = "updated"
        else:
            definition = automation_definitions.create_definition(
                db,
                owner_id=owner_id,
                actor=actor,
                source_yaml=source_yaml,
            )
            action = "created"
        item = automation_definitions.serialize_definition(definition)
        return (
            f"Automation definition {action}: id='{item['id']}', revision={item['revision']}, "
            f"yaml_path='{item['yaml_path']}', next_runs={json.dumps(item['next_runs'], ensure_ascii=False)}"
        )
    except Exception as exc:
        return f"Error: Could not save automation definition. {exc}"
    finally:
        db.close()


def _automation_owner_id(user_id: str) -> str:
    return str(user_id or "user_1")


def _automation_actor(user_id: str) -> str:
    return f"assistant:{user_id or 'unknown'}"


def _legacy_action_to_service(command: Dict[str, Any]) -> str:
    action = (command.get("action") or "toggle").strip().lower()
    target = str(command.get("target") or "").strip()
    domain = target.split(".", 1)[0] if "." in target else "homeassistant"
    if action not in {"turn_on", "turn_off", "toggle"}:
        action = "toggle"
    return f"{domain}.{action}"


def _build_automation_yaml_from_legacy_args(
    args: Dict[str, Any],
    user_id: str,
    title: str | None,
    description: str | None,
    automation_id: str | None,
    channel: str,
) -> str:
    commands = args.get("commands") or []
    skill_name = (args.get("skill_name") or "").strip()
    skill_input = args.get("skill_input") if isinstance(args.get("skill_input"), dict) else {}
    notify_msg = (args.get("notify_message") or "").strip() or None
    display_msg = (args.get("display_message") or "").strip() or None
    date_str = (args.get("date") or "").strip()
    time_str = (args.get("time") or "09:00").strip()
    recurrence = (args.get("recurrence") or "none").strip().lower()
    weekday = (args.get("weekday") or "").strip().lower()
    if recurrence not in {"none", "daily", "weekly", "biweekly"}:
        raise automation_definitions.AutomationValidationError(f"Unsupported recurrence '{recurrence}'")

    trigger = []
    if recurrence == "none":
        if date_str:
            trigger.append({"platform": "datetime", "at": f"{date_str}T{time_str}:00"})
        else:
            trigger.append({"platform": "time", "at": time_str})
    elif recurrence == "daily":
        trigger.append({"platform": "time", "at": time_str})
    elif recurrence == "weekly":
        if not weekday:
            raise automation_definitions.AutomationValidationError("weekday is required for weekly automation")
        trigger.append({"platform": "time", "at": time_str, "weekdays": [weekday]})
    elif recurrence == "biweekly":
        if not weekday:
            raise automation_definitions.AutomationValidationError("weekday is required for biweekly automation")
        trigger.append({"platform": "time", "at": time_str, "weekdays": [weekday]})

    final_title = (title or display_msg or notify_msg or f"Automation {skill_name or 'task'}").strip()
    yaml_obj: Dict[str, Any] = {
        "version": 1,
        "id": (automation_id or automation_definitions._slugify(final_title)),
        "title": final_title,
        "enabled": True,
        "channel": channel,
        "trigger": trigger,
        "action": [],
    }
    if description:
        yaml_obj["description"] = description
    if recurrence == "biweekly":
        yaml_obj["description"] = ((yaml_obj.get("description") or "") + " [legacy biweekly compatibility shim]").strip()

    if skill_name:
        yaml_obj["action"].append({"skill": {"name": skill_name, "input": skill_input}})
    else:
        for command in commands:
            action_entry: Dict[str, Any] = {
                "service": _legacy_action_to_service(command),
                "target": {"entity_id": command.get("target")},
            }
            data = {}
            if command.get("brightness") is not None:
                data["brightness"] = int(command.get("brightness"))
            if command.get("color_temp_kelvin") is not None:
                data["color_temp_kelvin"] = int(command.get("color_temp_kelvin"))
            if data:
                action_entry["data"] = data
            yaml_obj["action"].append(action_entry)
    if notify_msg:
        yaml_obj["action"].append({"notify": {"text": notify_msg}})
    return yaml.safe_dump(yaml_obj, sort_keys=False, allow_unicode=True)


async def _exec_validate_automation_yaml(args: Dict) -> str:
    source_yaml = (args.get("source_yaml") or "").strip()
    if not source_yaml:
        return "Error: source_yaml is required."
    try:
        normalized = automation_definitions.validate_source_yaml(source_yaml)
    except automation_definitions.AutomationValidationError as exc:
        return f"Invalid automation YAML: {exc}"
    return (
        f"Valid automation YAML: id='{normalized['id']}', title='{normalized['title']}', "
        f"triggers={json.dumps(normalized.get('trigger') or [], ensure_ascii=False)}, "
        f"actions={json.dumps(normalized.get('action') or [], ensure_ascii=False)}"
    )


async def _exec_list_automation_definitions(user_id: str) -> str:
    db = database.SessionLocal()
    try:
        items = automation_definitions.list_definitions(db, _automation_owner_id(user_id))
        if not items:
            return "No automation definitions found."
        lines = []
        for index, item in enumerate(items, 1):
            serialized = automation_definitions.serialize_definition(item)
            next_run = serialized.get("next_runs") or []
            next_text = next_run[0].get("next_run_at") if next_run else "none"
            lines.append(
                f"{index}. [AutomationDefinition] {serialized['title']} — id: {serialized['id']}, revision: {serialized['revision']}, "
                f"enabled: {serialized['enabled']}, next_run: {next_text}, yaml: {serialized['yaml_path']}"
            )
        return "\n".join(lines)
    finally:
        db.close()


async def _exec_get_automation_definition(args: Dict, user_id: str) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    if not automation_id:
        return "Error: automation_id is required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        serialized = automation_definitions.serialize_definition(item)
        return json.dumps(serialized, ensure_ascii=False)
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_create_automation_definition(args: Dict, user_id: str) -> str:
    source_yaml = (args.get("source_yaml") or "").strip()
    if not source_yaml:
        return "Error: source_yaml is required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.create_definition(
            db,
            owner_id=_automation_owner_id(user_id),
            actor=_automation_actor(user_id),
            source_yaml=source_yaml,
        )
        serialized = automation_definitions.serialize_definition(item)
        return f"Created automation definition '{serialized['id']}' revision={serialized['revision']} yaml='{serialized['yaml_path']}'"
    except automation_definitions.AutomationValidationError as exc:
        return f"Error: {exc}"
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_update_automation_definition(args: Dict, user_id: str) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    source_yaml = (args.get("source_yaml") or "").strip()
    expected_revision = args.get("expected_revision")
    if not automation_id or not source_yaml or expected_revision is None:
        return "Error: automation_id, source_yaml, and expected_revision are required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        updated = automation_definitions.replace_definition(
            db,
            item,
            actor=_automation_actor(user_id),
            source_yaml=source_yaml,
            expected_revision=int(expected_revision),
        )
        serialized = automation_definitions.serialize_definition(updated)
        return f"Updated automation definition '{serialized['id']}' to revision={serialized['revision']} yaml='{serialized['yaml_path']}'"
    except automation_definitions.AutomationValidationError as exc:
        return f"Error: {exc}"
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_enable_automation_definition(args: Dict, user_id: str) -> str:
    return await _exec_toggle_automation_definition(args, user_id, True)


async def _exec_disable_automation_definition(args: Dict, user_id: str) -> str:
    return await _exec_toggle_automation_definition(args, user_id, False)


async def _exec_toggle_automation_definition(args: Dict, user_id: str, enabled: bool) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    expected_revision = args.get("expected_revision")
    if not automation_id or expected_revision is None:
        return "Error: automation_id and expected_revision are required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        updated = automation_definitions.set_enabled(db, item, _automation_actor(user_id), enabled, int(expected_revision))
        serialized = automation_definitions.serialize_definition(updated)
        return f"Automation definition '{serialized['id']}' enabled={serialized['enabled']} revision={serialized['revision']}"
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_delete_automation_definition(args: Dict, user_id: str) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    if not automation_id:
        return "Error: automation_id is required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        automation_definitions.delete_definition(db, item)
        return f"Deleted automation definition '{automation_id}'."
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_run_automation_definition(args: Dict, user_id: str) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    if not automation_id:
        return "Error: automation_id is required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        await asyncio.to_thread(automation_definitions.execute_automation_definition, item.id, "manual")
        refreshed = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        history = automation_definitions.list_history(db, refreshed, limit=1)
        return f"Ran automation definition '{automation_id}'. Last run: {json.dumps(history[0] if history else {}, ensure_ascii=False)}"
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_search_web(args: Dict) -> str:
    query = (args.get("query") or "").strip()
    if not query:
        return "Error: No search query provided."

    result, status_messages, sources = await searxng_search(query)
    set_last_search_sources(sources or [])
    if result:
        cutoff = (settings_mod.CFG.get("intelligence") or {}).get("knowledge_cutoff", "2024-01")
        raw = (
            f"Web search results for '{query}' (your knowledge cutoff: {cutoff}, use these results for current info):\n"
            f"{result}"
        )
        return _guard(raw, "web_search")
    else:
        return f"No web results found for '{query}'."


async def _exec_search_web_images(args: Dict) -> str:
    query = (args.get("query") or "").strip()
    if not query:
        return "Error: No search query provided for image search."
    result, _ = await searxng_search_images(query)
    if result:
        return _guard(result, "web_images")
    return f"No image results found for '{query}'. The SearXNG instance may not have image search enabled (categories=images)."


async def _exec_read_web_page(args: Dict) -> str:
    """Fetch a single URL and return its main text content. Works alongside search_web (e.g. search first, then read URLs)."""
    url = (args.get("url") or "").strip()
    if not url:
        return "Error: No URL provided."
    if not url.startswith("http://") and not url.startswith("https://"):
        return "Error: URL must start with http:// or https://."
    if _is_internal_url(url):
        log_line("agent", "🛡️", "SSRF_BLOCK", f"Blocked internal URL: {url[:80]}")
        return "Error: Cannot access internal/private network addresses for security reasons."
    _def = _searxng_defaults()
    searxng = settings_mod.CFG.get("searxng", {})
    max_chars_cfg = int(searxng.get("read_page_max_chars", _def.get("read_page_max_chars", 6000)))
    max_chars = int(args.get("max_chars") or 0) or max_chars_cfg
    max_chars = max(500, min(15000, max_chars))
    timeout = float(searxng.get("search_timeout", _def.get("search_timeout", 10)))
    log_line("ha", "📄", "READ_PAGE", f"Fetching: {url[:60]}...")
    text = await _fetch_page_text(url, max_chars=max_chars, timeout=timeout)
    if text:
        log_line("ha", "📄", "READ_PAGE", f"Got {len(text)} chars from {url[:50]}...")
        raw = f"Content from {url}:\n\n{text}"
        return _guard(raw, "web_page")
    log_line("error", "⚠️", "READ_PAGE", f"Failed or empty: {url[:50]}...")
    return f"Could not read page at {url} (failed, empty, or not text)."


async def _exec_extract_web_data(args: Dict) -> str:
    """Fetch a page and extract text or attributes for given CSS selectors."""
    url = (args.get("url") or "").strip()
    selectors = (args.get("selectors") or "").strip()
    attr = (args.get("attr") or "").strip() or None
    if not url:
        return "Error: No URL provided."
    if not url.startswith("http://") and not url.startswith("https://"):
        return "Error: URL must start with http:// or https://."
    if not selectors:
        return "Error: No selectors provided. Use comma-separated CSS selectors (e.g. h1, .price, #main)."
    _def = _searxng_defaults()
    searxng = settings_mod.CFG.get("searxng", {})
    timeout = float(searxng.get("search_timeout", _def.get("search_timeout", 10)))
    log_line("ha", "🔧", "EXTRACT_WEB", f"Fetching: {url[:50]}... selectors: {selectors[:60]}")
    html_raw = await _fetch_page_html(url, timeout=timeout)
    if not html_raw:
        return f"Could not fetch page at {url} (failed, empty, or too large)."
    ok, result = await asyncio.to_thread(_extract_by_selectors, html_raw, selectors, attr)
    if not ok:
        return str(result)
    lines = [f"Extracted from {url}:"]
    for item in result:
        sel = item.get("selector", "")
        err = item.get("error")
        matches = item.get("matches") or []
        if err:
            lines.append(f"  [{sel}]: error — {err}")
        elif matches:
            lines.append(f"  [{sel}]:")
            for m in matches:
                lines.append(f"    - {m}")
        else:
            lines.append(f"  [{sel}]: (no matches)")
    log_line("ha", "🔧", "EXTRACT_WEB", f"Got {sum(len(i.get('matches') or []) for i in result)} matches")
    return _guard("\n".join(lines), "web_extract")


async def _exec_recall_memory(args: Dict, user_id: str) -> str:
    topic = (args.get("topic") or "").strip()
    if not topic:
        return "Error: No topic specified for memory recall."

    import asyncio
    facts = await asyncio.to_thread(get_memory_context, topic, "", user_id)
    if facts and facts.strip():
        return f"Memories about '{topic}':\n{facts}"
    else:
        return f"No memories found about '{topic}'."


async def _exec_store_memory(args: Dict, user_id: str) -> str:
    fact = (args.get("fact") or "").strip()
    if not fact:
        return "Error: No fact provided. Use the 'fact' parameter with a clear statement about the user (e.g. 'User likes Type O Negative')."
    log_line("mem", "🔧", "STORE_MEMORY", f"Tool called: {fact[:80]}{'…' if len(fact) > 80 else ''}")
    try:
        from brain.cortex import save_fact_from_agent
        out = await save_fact_from_agent(fact, user_id)
        log_line("mem", "🔧", "STORE_MEMORY", f"Result: {out[:60]}{'…' if len(out) > 60 else ''}")
        return out
    except Exception as e:
        log_line("error", "⚠️", "STORE_MEMORY", f"{type(e).__name__}: {e}")
        return f"Memory save failed: {type(e).__name__}."


def _exec_get_conversation_history(args: Dict, user_id: str) -> str:
    """Return earlier conversation messages from lazy history buffer."""
    last_n = min(int(args.get("last_n") or 10), 30)
    full_history = _lazy_history_store.get(user_id, [])
    if not full_history:
        return "No earlier conversation history available. This appears to be a new conversation or the beginning of the session."

    # Format messages cleanly — skip tool/system noise
    lines = []
    for msg in full_history[-last_n:]:
        role = msg.get("role", "")
        content = (msg.get("content") or "").strip()
        if role == "system" or role == "tool":
            continue
        if not content:
            continue
        if role == "user":
            lines.append(f"User: {content[:500]}")
        elif role == "assistant":
            from brain.cortex import strip_think
            clean = strip_think(content)
            if clean:
                lines.append(f"Assistant: {clean[:500]}")

    if not lines:
        return "No meaningful earlier messages found."

    header = f"Earlier conversation ({len(lines)} messages):"
    return header + "\n" + "\n".join(lines)


def set_lazy_history(user_id: str, messages: List[Dict]) -> None:
    """Store full conversation history for lazy retrieval by get_conversation_history tool."""
    _lazy_history_store[user_id] = list(messages)


def clear_lazy_history(user_id: str) -> None:
    """Remove lazy history for a user (cleanup)."""
    _lazy_history_store.pop(user_id, None)




async def _exec_run_skill(args: Dict, user_id: str) -> str:
    skill_name = (args.get("skill_name") or "").strip()
    if not skill_name:
        return "Error: No skill name specified."

    skill_input = dict(args.get("input") or {})
    if isinstance(args.get("input"), str):
        skill_input = {"query": args.get("input")}
    # Inject SearXNG URL as plain data so sandboxed skills can use urllib for web search
    allow_network = False
    searxng = settings_mod.CFG.get("searxng") or {}
    if searxng.get("enabled") and (searxng.get("url") or "").strip():
        skill_input["_searxng_url"] = searxng["url"].strip()
        allow_network = True

    # Check if skill exists and is enabled
    try:
        from skills import get_skill_registry
        available = [s["name"] for s in get_skill_registry()]
    except Exception:
        available = []

    if skill_name not in available:
        return f"Error: Skill '{skill_name}' not found. Available skills: {', '.join(available) if available else 'none'}."

    disabled = settings_mod.CFG.get("skills_disabled") or []
    if skill_name in disabled:
        return f"Error: Skill '{skill_name}' is currently disabled."

    try:
        import asyncio
        import skills as skills_mod
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, lambda: skills_mod.run_skill(skill_name, skill_input, allow_network=allow_network),
        )
        msg = result.get("message", "")
        data = result.get("data") or {}
        success = result.get("success", False)

        # Format data nicely if it has results
        if isinstance(data, dict) and data.get("results"):
            results_preview = data["results"][:8]
            parts = []
            for i, r in enumerate(results_preview, 1):
                title = (r.get("title") or r.get("url") or "")[:100]
                content = (r.get("content") or r.get("snippet") or "").strip()[:400]
                url = (r.get("url") or "")[:80]
                line = f"[{i}] {title}"
                if content:
                    line += f" — {content}"
                if url:
                    line += f" (URL: {url})"
                parts.append(line)
            data_text = "\n".join(parts)
            return _guard(f"Skill '{skill_name}' result: {msg}\n{data_text}", "skill_output")
        elif data:
            return _guard(f"Skill '{skill_name}' result: {msg}. Data: {json.dumps(data, ensure_ascii=False)[:800]}", "skill_output")
        else:
            return f"Skill '{skill_name}': {'success' if success else 'failed'}. {msg}"
    except Exception as e:
        return f"Error running skill '{skill_name}': {type(e).__name__}: {e}"


async def _exec_create_skill(args: Dict, status_queue: Optional[Any] = None) -> str:
    description = (args.get("description") or "").strip()
    if not description or len(description) < 3:
        return "Error: Skill description too short. Describe what the skill should do."

    name_hint = (args.get("name_hint") or "").strip() or None
    inputs_hint = (args.get("inputs_hint") or "").strip() or None
    allow_network = bool(args.get("allow_network"))

    def _status_cb(t: str, label: str) -> None:
        if status_queue is not None:
            try:
                status_queue.put_nowait({"t": "status", "type": t, "label": label})
            except Exception:
                pass  # queue full; non-critical UI status drop

    last_preview_sent = ""
    last_preview_at = 0.0

    def _preview_cb(code: str, done: bool = False) -> None:
        nonlocal last_preview_sent, last_preview_at
        if status_queue is None:
            return
        code = code or ""
        now = time.monotonic()
        grew_by = len(code) - len(last_preview_sent)
        if not done and code == last_preview_sent:
            return
        if not done and grew_by < 16 and (now - last_preview_at) < 0.08:
            return
        last_preview_sent = code
        last_preview_at = now
        try:
            status_queue.put_nowait({"t": "forge_preview", "language": "python", "content": code, "done": done})
        except Exception:
            pass  # queue full; non-critical streaming preview drop

    try:
        import forge as forge_mod
        ok, msg, _ = await forge_mod.run_forge(
            description, save=True,
            name_hint=name_hint, inputs_hint=inputs_hint, allow_network=allow_network,
            status_callback=_status_cb,
            preview_callback=_preview_cb,
        )
        if ok:
            try:
                from brain.cortex import invalidate_prompt_cache
                invalidate_prompt_cache()
            except Exception as e:
                log_line("warn", "⚠️", "FORGE", f"Cache invalidation failed after forge: {e}")
        return msg if msg else ("Skill created successfully." if ok else "Forge failed to create the skill.")
    except Exception as e:
        return f"Error creating skill: {type(e).__name__}: {e}"


async def _exec_edit_skill(args: Dict) -> str:
    skill_name = (args.get("skill_name") or "").strip()
    instruction = (args.get("instruction") or "").strip()
    if not skill_name or not instruction:
        return "Error: edit_skill requires skill_name and instruction."
    try:
        import forge as forge_mod
        ok, msg = await forge_mod.run_forge_edit(skill_name, instruction)
        if ok:
            try:
                from brain.cortex import invalidate_prompt_cache
                invalidate_prompt_cache()
            except Exception as e:
                log_line("warn", "⚠️", "FORGE", f"Cache invalidation failed after edit: {e}")
        return msg
    except Exception as e:
        return f"Error editing skill: {type(e).__name__}: {e}"


async def _exec_improve_skill(args: Dict) -> str:
    skill_name = (args.get("skill_name") or "").strip()
    error_message = (args.get("error_message") or "").strip()
    if not skill_name or not error_message:
        return "Error: improve_skill requires skill_name and error_message."
    try:
        import forge as forge_mod
        ok, msg = await forge_mod.run_forge_improve(skill_name, error_message)
        if ok:
            try:
                from brain.cortex import invalidate_prompt_cache
                invalidate_prompt_cache()
            except Exception as e:
                log_line("warn", "⚠️", "FORGE", f"Cache invalidation failed after improve: {e}")
        return msg
    except Exception as e:
        return f"Error improving skill: {type(e).__name__}: {e}"


async def _exec_cctv_describe(arguments: Dict[str, Any]) -> str:
    """Capture a frame from the given CCTV camera and return vision model description."""
    camera_id = (arguments.get("camera_id") or "").strip()
    if not camera_id:
        return "Error: camera_id is required."
    cctv_cfg = settings_mod.CFG.get("cctv") or {}
    cameras = cctv_cfg.get("cameras") or []
    cam = None
    cid_lower = camera_id.lower()
    for c in cameras:
        c_id = (c.get("id") or "").strip().lower()
        c_name = (c.get("name") or "").strip().lower()
        if c_id == cid_lower or c_name == cid_lower or (c_name and cid_lower in c_name) or (c_id and cid_lower in c_id):
            cam = c
            break
    if not cam:
        names = ", ".join((c.get("name") or c.get("id") or "?") for c in cameras[:10])
        return f"Error: Camera '{camera_id}' not found. Available: {names or 'none'}."
    rtsp_url = (cam.get("rtsp_url") or "").strip()
    if not rtsp_url:
        return f"Error: Camera '{cam.get('name') or cam.get('id')}' has no RTSP URL configured."
    try:
        import cctv_capture
        loop = asyncio.get_event_loop()
        frame_bytes = await loop.run_in_executor(None, cctv_capture.get_rtsp_frame, rtsp_url)
    except Exception as e:
        log_line("agent", "⚠️", "CCTV", f"Frame capture: {e}")
        return f"Error: Could not capture frame from camera (check RTSP URL and ffmpeg). {type(e).__name__}: {e}"
    if not frame_bytes:
        return "Error: No frame received from camera (stream unavailable or ffmpeg failed)."
    image_b64 = base64.b64encode(frame_bytes).decode("ascii")
    context_hint = (cam.get("context") or "").strip()
    base_instruction = (
        "CCTV frame. Reply in 1–3 short sentences. ALLOWED only: "
        "people present or 'nobody visible'; vehicles (type, color, where parked); lights on/off; doors/gates open or closed; movement or something out of place. "
        "FORBIDDEN: do not mention plants, trees, shrubs, garden, fence, trash bin, stones, pavement, alley surface, sky, decoration, or any static background. "
        "Example: 'Nobody visible. Two black cars parked in front. Outside lights on.'"
    )
    if context_hint:
        prompt = (
            "Expected: " + context_hint + ". "
            + base_instruction
            + " If something doesn't match, add: 'Unusual: ...'"
        )
    else:
        prompt = base_instruction
    try:
        from brain.cortex import _describe_image_with_vision_llm
        description = await _describe_image_with_vision_llm(image_b64, prompt)
    except Exception as e:
        log_line("agent", "⚠️", "CCTV", f"Vision: {e}")
        return f"Error: Vision model failed. {type(e).__name__}: {e}"
    if not description:
        vision_cfg = settings_mod.CFG.get("vision_llm") or {}
        has_vision = (vision_cfg.get("target_url") or "").strip() and (vision_cfg.get("model_name") or "").strip()
        if not has_vision:
            return "Error: Vision model returned no description (no vision_llm configured; main LLM may not support images — set a vision_llm in Settings › AI Models)."
        return "Error: Vision model returned no description."
    name = cam.get("name") or cam.get("id") or "Camera"
    return f"[{name}]\n{description}"


async def _exec_generate_image(arguments: Dict[str, Any]) -> str:
    """Generate an image using ComfyUI and return a markdown image link."""
    import comfyui

    prompt_text = (arguments.get("prompt") or "").strip()
    if not prompt_text:
        return "Error: No prompt provided for image generation."

    negative = (arguments.get("negative_prompt") or "").strip()
    width = int(arguments.get("width") or 0)
    height = int(arguments.get("height") or 0)
    steps = int(arguments.get("steps") or 0)

    try:
        image_url, metadata = await comfyui.generate_image(
            prompt=prompt_text,
            negative_prompt=negative,
            width=width,
            height=height,
            steps=steps,
        )
        return (
            f"Image generated successfully.\n"
            f"![Generated Image]({image_url})\n"
            f"URL: {image_url}"
        )
    except Exception as e:
        log_line("error", "⚠️", "COMFYUI", f"Generation failed: {type(e).__name__}: {e}")
        return f"Error generating image: {type(e).__name__}: {e}"


# ---------------------------------------------------------------------------
# Planner tool implementations
# ---------------------------------------------------------------------------

def _resolve_user(db, user_id: str):
    """Resolve brain user_id (e.g. 'user_1') to a User row."""
    if user_id and user_id.startswith("user_"):
        try:
            numeric_id = int(user_id.split("_", 1)[1])
            return db.query(models.User).filter(models.User.id == numeric_id).first()
        except (ValueError, IndexError):
            pass
    return db.query(models.User).filter(models.User.username == user_id).first()


def _planner_get_or_create_list(db, uid: int, list_name: str) -> models.TodoList:
    normalized = (list_name or "Inbox").strip()[:128] or "Inbox"
    todo_list = db.query(models.TodoList).filter(
        models.TodoList.user_id == uid,
        models.TodoList.title == normalized,
        models.TodoList.archived.is_(False),
    ).first()
    if todo_list:
        return todo_list
    todo_list = models.TodoList(user_id=uid, title=normalized)
    db.add(todo_list)
    db.flush()
    return todo_list


async def _exec_planner_add_list(args: Dict, user_id: str) -> str:
    title = (args.get("title") or "").strip()
    if not title:
        return "Error: title is required."

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        existing = db.query(models.TodoList).filter(
            models.TodoList.user_id == user.id,
            models.TodoList.title == title,
            models.TodoList.archived.is_(False),
        ).first()
        if existing:
            return f"List already exists: '{existing.title}' (id={existing.id})."

        row = models.TodoList(
            user_id=user.id,
            title=title[:128],
            color=((args.get("color") or "").strip()[:64] or None),
            icon=((args.get("icon") or "").strip()[:64] or None),
            archived=False,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return f"Created list '{row.title}' (id={row.id})."
    finally:
        db.close()


async def _exec_planner_list_lists(args: Dict, user_id: str) -> str:
    include_archived = bool(args.get("include_archived", False))
    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        q = db.query(models.TodoList).filter(models.TodoList.user_id == user.id)
        if not include_archived:
            q = q.filter(models.TodoList.archived.is_(False))
        rows = q.order_by(models.TodoList.updated_at.desc()).all()
        if not rows:
            return "No planner lists found."

        lines = [f"- id={row.id} title='{row.title}'" + (" [archived]" if row.archived else "") for row in rows]
        return f"Found {len(rows)} list(s):\n" + "\n".join(lines)
    finally:
        db.close()


async def _exec_planner_delete_list(args: Dict, user_id: str) -> str:
    list_id = args.get("list_id")
    list_name = (args.get("list_name") or "").strip()
    if list_id is None and not list_name:
        return "Error: provide list_id or list_name."

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        q = db.query(models.TodoList).filter(models.TodoList.user_id == user.id)
        if list_id is not None:
            q = q.filter(models.TodoList.id == int(list_id))
        else:
            q = q.filter(models.TodoList.title == list_name)
        row = q.first()
        if not row:
            return "Error: list not found."

        title = row.title
        db.delete(row)
        db.commit()
        return f"Deleted list '{title}' (id={row.id})."
    finally:
        db.close()


async def _exec_planner_add_entry(args: Dict, user_id: str) -> str:
    items = args.get("items") or []
    if not isinstance(items, list) or not items:
        return "Error: 'items' must be a non-empty array."

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."
        uid = user.id

        created = []
        for item in items[:10]:
            entry_type = (item.get("entry_type") or "task").strip().lower()
            if entry_type not in ("task", "event"):
                entry_type = "task"
            title = (item.get("title") or "").strip()
            if not title:
                continue

            # Resolve list
            list_name = (item.get("list_name") or "Inbox").strip()[:128]
            todo_list = _planner_get_or_create_list(db, uid, list_name)

            from sqlalchemy import func as sa_func
            max_pos = db.query(sa_func.max(models.Entry.position)).filter(
                models.Entry.user_id == uid,
                models.Entry.list_id == todo_list.id,
            ).scalar()
            next_pos = int(max_pos or 0) + 1

            due_at = _planner_parse_dt(item.get("due_at"))
            start_at = _planner_parse_dt(item.get("start_at"))
            end_at = _planner_parse_dt(item.get("end_at"))
            priority = None
            if item.get("priority") is not None:
                try:
                    p = int(item["priority"])
                    if 1 <= p <= 5:
                        priority = p
                except (TypeError, ValueError):
                    pass

            row = models.Entry(
                user_id=uid,
                list_id=todo_list.id,
                entry_type=entry_type,
                title=title[:200],
                content=(item.get("content") or "")[:5000] or None,
                status="active",
                task_status="todo" if entry_type == "task" else None,
                priority=priority if entry_type == "task" else None,
                due_at=due_at if entry_type == "task" else None,
                start_at=start_at if entry_type == "event" else None,
                end_at=end_at if entry_type == "event" else None,
                all_day=item.get("all_day") if entry_type == "event" else None,
                location=(item.get("location") or "")[:200] or None if entry_type == "event" else None,
                position=next_pos,
            )
            db.add(row)
            db.flush()
            created.append(f"- [{entry_type}] {title} (id={row.id}, list='{todo_list.title}')")

        db.commit()
        if not created:
            return "No valid items to create. Each item must have a title."
        return f"Created {len(created)} planner entry(ies):\n" + "\n".join(created)
    finally:
        db.close()


async def _exec_planner_update_entry(args: Dict, user_id: str) -> str:
    entry_id = args.get("entry_id")
    if entry_id is None:
        return "Error: entry_id is required."

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        row = db.query(models.Entry).filter(
            models.Entry.id == int(entry_id),
            models.Entry.user_id == user.id,
            models.Entry.status == "active",
        ).first()
        if not row:
            return f"Error: entry {entry_id} not found."

        changed = []

        if "title" in args:
            title = (args.get("title") or "").strip()
            if not title:
                return "Error: title cannot be empty."
            row.title = title[:200]
            changed.append("title")

        if "content" in args:
            content = (args.get("content") or "").strip()
            row.content = content[:5000] if content else None
            changed.append("content")

        if "list_name" in args:
            target_list = _planner_get_or_create_list(db, user.id, (args.get("list_name") or "Inbox"))
            row.list_id = target_list.id
            changed.append("list")

        if row.entry_type == "task":
            if "due_at" in args:
                due_raw = args.get("due_at")
                if due_raw in (None, ""):
                    row.due_at = None
                else:
                    due_at = _planner_parse_dt(due_raw)
                    if due_at is None:
                        return "Error: due_at must be ISO datetime (e.g. 2026-03-25T17:00)."
                    row.due_at = due_at
                changed.append("due_at")

            if "priority" in args:
                priority_raw = args.get("priority")
                if priority_raw in (None, ""):
                    row.priority = None
                else:
                    try:
                        priority = int(priority_raw)
                    except (ValueError, TypeError):
                        return "Error: priority must be an integer 1-5."
                    if priority < 1 or priority > 5:
                        return "Error: priority must be between 1 and 5."
                    row.priority = priority
                changed.append("priority")

            if "task_status" in args:
                task_status = (args.get("task_status") or "").strip().lower()
                if task_status not in {"todo", "in_progress", "done"}:
                    return "Error: task_status must be todo, in_progress, or done."
                row.task_status = task_status
                row.completed_at = datetime.now() if task_status == "done" else None
                changed.append("task_status")
        else:
            next_start = row.start_at
            next_end = row.end_at

            if "start_at" in args:
                start_raw = args.get("start_at")
                if start_raw in (None, ""):
                    next_start = None
                else:
                    parsed = _planner_parse_dt(start_raw)
                    if parsed is None:
                        return "Error: start_at must be ISO datetime (e.g. 2026-03-25T17:00)."
                    next_start = parsed
                changed.append("start_at")

            if "end_at" in args:
                end_raw = args.get("end_at")
                if end_raw in (None, ""):
                    next_end = None
                else:
                    parsed = _planner_parse_dt(end_raw)
                    if parsed is None:
                        return "Error: end_at must be ISO datetime (e.g. 2026-03-25T18:00)."
                    next_end = parsed
                changed.append("end_at")

            if next_start and next_end and next_end <= next_start:
                return "Error: end_at must be after start_at."

            row.start_at = next_start
            row.end_at = next_end

            if "all_day" in args:
                row.all_day = bool(args.get("all_day"))
                changed.append("all_day")

            if "location" in args:
                location = (args.get("location") or "").strip()
                row.location = location[:200] if location else None
                changed.append("location")

            if "event_color" in args:
                color = (args.get("event_color") or "").strip()
                row.event_color = color[:32] if color else None
                changed.append("event_color")

        if not changed:
            return f"No changes requested for entry {row.id}."

        db.commit()
        return f"Updated entry '{row.title}' (id={row.id}): {', '.join(changed)}."
    finally:
        db.close()


async def _exec_planner_list_entries(args: Dict, user_id: str) -> str:
    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."
        uid = user.id

        q = db.query(models.Entry).filter(
            models.Entry.user_id == uid,
            models.Entry.status == "active",
        )

        entry_type = (args.get("entry_type") or "").strip().lower()
        if entry_type in ("task", "event"):
            q = q.filter(models.Entry.entry_type == entry_type)

        status_filter = (args.get("status") or "all").strip().lower()
        if status_filter == "open":
            q = q.filter(
                (models.Entry.entry_type != "task") |
                (models.Entry.task_status != "done")
            )
        elif status_filter == "done":
            q = q.filter(
                models.Entry.entry_type == "task",
                models.Entry.task_status == "done",
            )

        view = (args.get("view") or "all").strip().lower()
        now = datetime.now()
        if view == "today":
            start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            end = start + timedelta(days=1)
            q = q.filter(
                (models.Entry.due_at.between(start, end)) |
                (models.Entry.start_at.between(start, end))
            )
        elif view == "upcoming":
            q = q.filter(
                (models.Entry.due_at > now) | (models.Entry.start_at > now)
            )
        elif view == "overdue":
            q = q.filter(
                models.Entry.entry_type == "task",
                models.Entry.task_status != "done",
                models.Entry.due_at < now,
            )

        list_name = (args.get("list_name") or "").strip()
        if list_name:
            todo_list = db.query(models.TodoList).filter(
                models.TodoList.user_id == uid,
                models.TodoList.title == list_name,
            ).first()
            if todo_list:
                q = q.filter(models.Entry.list_id == todo_list.id)
            else:
                return f"No list named '{list_name}' found."

        rows = q.order_by(
            models.Entry.due_at.asc().nulls_last(),
            models.Entry.start_at.asc().nulls_last(),
            models.Entry.position.asc(),
        ).limit(50).all()

        if not rows:
            return "No planner entries found matching your criteria."

        lines = []
        for r in rows:
            when = r.due_at or r.start_at
            when_str = when.strftime("%Y-%m-%d %H:%M") if when else ""
            status = ""
            if r.entry_type == "task":
                status = f" [{r.task_status or 'todo'}]"
                if r.priority:
                    status += f" P{r.priority}"
            lines.append(f"- id={r.id} [{r.entry_type}]{status} {r.title}{(' | ' + when_str) if when_str else ''}")

        return f"Found {len(rows)} entries:\n" + "\n".join(lines)
    finally:
        db.close()


async def _exec_planner_complete_entry(args: Dict, user_id: str) -> str:
    entry_id = args.get("entry_id")
    if entry_id is None:
        return "Error: entry_id is required."
    done = args.get("done", True)

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        row = db.query(models.Entry).filter(
            models.Entry.id == int(entry_id),
            models.Entry.user_id == user.id,
        ).first()
        if not row:
            return f"Error: entry {entry_id} not found."
        if row.entry_type != "task":
            return f"Entry {entry_id} is a {row.entry_type}, not a task. Only tasks can be marked done."

        row.task_status = "done" if done else "todo"
        if done:
            row.completed_at = datetime.now()
        else:
            row.completed_at = None
        db.commit()
        return f"Task '{row.title}' (id={row.id}) marked as {'done' if done else 'todo'}."
    finally:
        db.close()


async def _exec_planner_delete_entry(args: Dict, user_id: str) -> str:
    entry_id = args.get("entry_id")
    entry_type = (args.get("entry_type") or "").strip().lower()
    title_contains = (args.get("title_contains") or "").strip().lower()
    date_str = (args.get("date") or "").strip()
    time_hm = (args.get("time_hm") or "").strip()

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        row = None
        if entry_id is not None:
            row = db.query(models.Entry).filter(
                models.Entry.id == int(entry_id),
                models.Entry.user_id == user.id,
            ).first()
            if not row:
                return f"Error: entry {entry_id} not found."
        else:
            q = db.query(models.Entry).filter(
                models.Entry.user_id == user.id,
                models.Entry.status == "active",
            )
            if entry_type in ("task", "event"):
                q = q.filter(models.Entry.entry_type == entry_type)

            candidates = q.all()
            if title_contains:
                candidates = [c for c in candidates if title_contains in (c.title or "").lower()]
            if date_str:
                candidates = [
                    c for c in candidates
                    if ((c.start_at or c.due_at) and (c.start_at or c.due_at).strftime("%Y-%m-%d") == date_str)
                ]
            if time_hm:
                candidates = [
                    c for c in candidates
                    if ((c.start_at or c.due_at) and (c.start_at or c.due_at).strftime("%H:%M") == time_hm)
                ]

            if not candidates:
                return "Error: no matching entry found for delete filters."
            if len(candidates) > 1:
                preview = "\n".join(
                    f"- id={c.id} [{c.entry_type}] {c.title}"
                    + (f" | {(c.start_at or c.due_at).strftime('%Y-%m-%d %H:%M')}" if (c.start_at or c.due_at) else "")
                    for c in candidates[:5]
                )
                return "Multiple entries match. Please specify entry_id.\n" + preview
            row = candidates[0]

        title = row.title
        db.delete(row)
        db.commit()
        return f"Deleted entry '{title}' (id={row.id})."
    finally:
        db.close()


def _planner_parse_dt(value) -> Optional[datetime]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    text = text.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


