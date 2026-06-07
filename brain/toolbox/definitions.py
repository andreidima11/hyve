from __future__ import annotations

from typing import Any, Dict, List

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
        "description": "Search the web for current, time-sensitive, or post-cutoff facts. REQUIRED before answering who currently holds political office (PM, president, minister), company leadership, sports champions, prices, news, weather, or anything that may have changed since your knowledge cutoff — especially when the user says noul/noua/current/new. Do NOT answer those from memory alone. Use a short keyword query (3-7 words). One search is usually enough.",
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
        "description": "Search long-term memory for facts about this user (preferences, past info). Call proactively when the user mentions personal topics (food, hobbies, habits, possessions, plans, health, work, family) — not only when they explicitly ask what you remember. Also use when they ask about themselves or their preferences.",
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


TOOL_GET_APP_HELP = {
    "type": "function",
    "function": {
        "name": "get_app_help",
        "description": "OPTIONAL look-up of how a feature of the Hyve UI works (theme, dashboard, page, card, automation, integration, settings, planner, memory, skills, derived entities, notifications). Only call this when the user EXPLICITLY asks where something is in the Hyve app or how to do something in its UI, AND you don't already know the answer. Do NOT call it for general conversation, smart-home commands, automations you can build directly with other tools, or any non-Hyve question. Pass the topic in plain words.",
        "parameters": {
            "type": "object",
            "properties": {
                "topic": {
                    "type": "string",
                    "description": "Feature area to look up. Examples: 'theme', 'dashboard', 'card', 'automation', 'integration', 'settings', 'planner', 'memory'. Free-form text is also accepted; leave empty for a topic index."
                }
            },
            "required": []
        }
    }
}

TOOL_GET_SYSTEM_STATUS = {
    "type": "function",
    "function": {
        "name": "get_system_status",
        "description": "Read-only snapshot of Hyve runtime state: integrations, entities, health, dashboard layout, automations, scenes, areas, notifications, add-ons. Use when the user asks about system status, what's configured, or what's running — not for controlling devices.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "enum": [
                        "overview",
                        "integrations",
                        "integration_detail",
                        "entities",
                        "health",
                        "dashboard",
                        "automations",
                        "automation_history",
                        "scenes",
                        "areas",
                        "notifications",
                        "addons",
                    ],
                    "description": "Which snapshot to retrieve. Start with 'overview' when unsure.",
                },
                "slug": {
                    "type": "string",
                    "description": "Integration slug (required for integration_detail, e.g. 'frigate').",
                },
                "source": {
                    "type": "string",
                    "description": "Filter entities by integration source (for query=entities).",
                },
                "domain": {
                    "type": "string",
                    "description": "Filter entities by domain prefix (for query=entities, e.g. 'sensor').",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max entities to list (for query=entities, default 40).",
                },
            },
            "required": ["query"],
        },
    },
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

# ---- Smart Home control tools ----

TOOL_CONTROL_DEVICE = {
    "type": "function",
    "function": {
        "name": "control_device",
        "description": "Control a smart home device: turn on/off, toggle, set brightness, temperature, etc. Use entity_id from the home state context.",
        "parameters": {
            "type": "object",
            "properties": {
                "entity_id": {"type": "string", "description": "The entity_id of the device to control (e.g. 'light.living_room', 'switch.fan')."},
                "action": {"type": "string", "enum": ["turn_on", "turn_off", "toggle", "set"], "description": "Action to perform."},
                "data": {"type": "object", "description": "Optional parameters for the action (e.g. {\"brightness\": 128} for lights, {\"temperature\": 22} for climate)."}
            },
            "required": ["entity_id", "action"]
        }
    }
}

TOOL_GET_HOME_STATUS = {
    "type": "function",
    "function": {
        "name": "get_home_status",
        "description": "Get the current state of all smart home devices grouped by area. Shows entity_id, name, state, and attributes for each device.",
        "parameters": {"type": "object", "properties": {}, "required": []}
    }
}

TOOL_GET_ENTITY_HISTORY = {
    "type": "function",
    "function": {
        "name": "get_entity_history",
        "description": "Get recent numeric history (time-series data) for a sensor or device. Useful for analyzing trends, averages, min/max values.",
        "parameters": {
            "type": "object",
            "properties": {
                "entity_id": {"type": "string", "description": "The entity_id to query history for."},
                "hours": {"type": "number", "description": "How many hours of history to retrieve (default 24, max 336)."}
            },
            "required": ["entity_id"]
        }
    }
}

TOOL_GET_DEVICE_STATE = {
    "type": "function",
    "function": {
        "name": "get_device_state",
        "description": "Get the current state of one smart home entity by entity_id (read-only). Returns name, state, domain, source, and key attributes.",
        "parameters": {
            "type": "object",
            "properties": {
                "entity_id": {
                    "type": "string",
                    "description": "Entity id to look up (e.g. 'light.living_room', 'sensor.temperature').",
                }
            },
            "required": ["entity_id"],
        },
    },
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
