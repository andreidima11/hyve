"""Agent-mode tool-call execution loop (search, devices, forge, UI emits)."""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, Set

import core.settings as settings_mod
from core.logger import log_line, log_detail, log_conversation_model_activity

from brain.cortex.agent_helpers import _event_status, _tool_call_status_label
from brain.cortex.prompt import _should_skip_web_search
from brain.cortex.prompt_cache import (
    _filter_tools_for_untrusted_context,
    _tool_result_taints_context,
)

ExecuteToolFn = Callable[..., Any]


@dataclass
class AgentToolLoopState:
    user_msg: str
    user_id: str
    llm_messages: List[Dict]
    agent_turn_messages: List[Dict]
    tool_catalog: List[Dict]
    restrict_mutating_tools: bool
    untrusted_context_active: bool
    safe_untrusted_tool_names: Set[Optional[str]]
    max_searches_per_request: int
    max_read_pages_per_request: int
    search_web_calls_this_request: int = 0
    read_web_page_calls_this_request: int = 0
    forge_preview: str = ""
    forge_preview_language: str = "python"


def _append_assistant_tool_message(
    state: AgentToolLoopState,
    text_content: str,
    tool_calls: List[Dict],
    stream_done: Dict[str, Any],
) -> None:
    reasoning_content = stream_done.get("reasoning_content") or ""
    assistant_msg = {"role": "assistant", "content": text_content or "", "tool_calls": tool_calls}
    if reasoning_content and isinstance(reasoning_content, str):
        assistant_msg["reasoning_content"] = reasoning_content
    state.llm_messages.append(assistant_msg)
    state.agent_turn_messages.append({
        "role": "assistant",
        "content": text_content or "",
        "tool_calls": tool_calls,
    })


async def _run_parallel_searches(
    tool_calls: List[Dict],
    state: AgentToolLoopState,
    execute_tool: ExecuteToolFn,
) -> Dict[Any, str]:
    search_calls_to_parallel = []
    knowledge_cutoff_str = (settings_mod.CFG.get("intelligence") or {}).get("knowledge_cutoff", "").strip()

    for idx, tc in enumerate(tool_calls):
        fn = tc.get("function", {})
        fn_name = fn.get("name", "")
        if fn_name != "search_web" or state.search_web_calls_this_request >= state.max_searches_per_request:
            continue
        fn_args_raw = fn.get("arguments", "")
        try:
            fn_args = json.loads(fn_args_raw) if fn_args_raw else {}
        except json.JSONDecodeError:
            continue
        query = fn_args.get("query", "").strip()
        skip_search, _skip_reason = _should_skip_web_search(query, knowledge_cutoff_str, state.user_msg)
        if not skip_search:
            search_calls_to_parallel.append((idx, fn_name, fn_args, tc.get("id")))

    parallel_results: Dict[Any, str] = {}
    if len(search_calls_to_parallel) < 2:
        return parallel_results

    log_line("agent", "⚡", "PARALLEL_SEARCH", f"Running {len(search_calls_to_parallel)} searches in parallel")
    tasks = [
        execute_tool(fn_name, fn_args, state.user_id, untrusted_context=state.untrusted_context_active)
        for (_, fn_name, fn_args, _) in search_calls_to_parallel
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    for i, (idx, fn_name, fn_args, tc_id) in enumerate(search_calls_to_parallel):
        result = results[i]
        if isinstance(result, Exception):
            result = f"Search error: {type(result).__name__}: {result}"
        parallel_results[tc_id or idx] = result
    state.search_web_calls_this_request += len(search_calls_to_parallel)
    return parallel_results


async def _run_parallel_device_controls(
    tool_calls: List[Dict],
    state: AgentToolLoopState,
    execute_tool: ExecuteToolFn,
    parallel_results: Dict[Any, str],
) -> None:
    device_calls_to_parallel = []
    for idx, tc in enumerate(tool_calls):
        fn = tc.get("function", {})
        fn_name = fn.get("name", "")
        if fn_name != "control_device":
            continue
        fn_args_raw = fn.get("arguments", "")
        try:
            fn_args = json.loads(fn_args_raw) if fn_args_raw else {}
        except json.JSONDecodeError:
            continue
        device_calls_to_parallel.append((idx, fn_name, fn_args, tc.get("id")))

    if len(device_calls_to_parallel) < 2:
        return

    log_line("agent", "⚡", "PARALLEL_DEVICE", f"Running {len(device_calls_to_parallel)} device controls in parallel")
    tasks = [
        execute_tool(fn_name, fn_args, state.user_id, untrusted_context=state.untrusted_context_active)
        for (_, fn_name, fn_args, _) in device_calls_to_parallel
    ]
    dev_results = await asyncio.gather(*tasks, return_exceptions=True)
    for i, (idx, fn_name, fn_args, tc_id) in enumerate(device_calls_to_parallel):
        result = dev_results[i]
        if isinstance(result, Exception):
            result = f"Device error: {type(result).__name__}: {result}"
        parallel_results[tc_id or f"dev_{idx}"] = result


def _parse_tool_call(tc: Dict[str, Any]) -> tuple[str, Dict[str, Any], str]:
    fn = tc.get("function", {})
    fn_name = fn.get("name", "")
    if fn_name and not fn_name.replace("_", "").isalpha():
        clean = re.match(r"^[a-zA-Z_]+", fn_name)
        if clean:
            log_line("agent", "🩹", "TOOL NAME FIX", f"'{fn_name}' → '{clean.group()}'")
            fn_name = clean.group()
    fn_args_raw = fn.get("arguments", "")
    try:
        fn_args = json.loads(fn_args_raw) if fn_args_raw else {}
    except json.JSONDecodeError:
        fn_args = {}
        if fn_args_raw:
            quoted = re.findall(r'"([^"]{2,})"', fn_args_raw)
            if quoted and fn_name in ("search_web", "search_web_images"):
                best = max(quoted, key=len)
                fn_args = {"query": best}
                log_line("agent", "🩹", "ARGS FIX", f"Salvaged query from malformed args: '{best[:60]}'")
            elif quoted:
                log_line("agent", "⚠️", "ARGS PARSE", f"Could not parse args for {fn_name}: {fn_args_raw[:100]}")
    return fn_name, fn_args, fn_args_raw


async def _execute_single_tool(
    fn_name: str,
    fn_args: Dict[str, Any],
    tc: Dict[str, Any],
    state: AgentToolLoopState,
    execute_tool: ExecuteToolFn,
    parallel_results: Dict[Any, str],
) -> AsyncIterator[Any]:
    result = ""
    if fn_name == "search_web":
        tc_id = tc.get("id")
        if tc_id in parallel_results or (tc_id is None and parallel_results):
            result = parallel_results.get(tc_id) or parallel_results.get(list(parallel_results.keys())[0])
            if tc_id in parallel_results:
                del parallel_results[tc_id]
            else:
                parallel_results.pop(list(parallel_results.keys())[0])
        elif state.search_web_calls_this_request >= state.max_searches_per_request:
            result = (
                f"Search limit reached (max {state.max_searches_per_request} per message). "
                "Use the previous search results to answer."
            )
            log_line("agent", "🔎", "SEARCH_LIMIT", f"{state.search_web_calls_this_request} >= {state.max_searches_per_request}")
        else:
            query = fn_args.get("query", "").strip()
            knowledge_cutoff_str = (settings_mod.CFG.get("intelligence") or {}).get("knowledge_cutoff", "").strip()
            skip_search, skip_reason = _should_skip_web_search(query, knowledge_cutoff_str, state.user_msg)
            if skip_search:
                result = f"[SEARCH SKIPPED] {skip_reason}\n\nUse your existing knowledge to answer this question directly."
                log_line("agent", "🚫", "SEARCH_SKIP", skip_reason)
            else:
                result = await execute_tool(fn_name, fn_args, state.user_id, untrusted_context=state.untrusted_context_active)
                state.search_web_calls_this_request += 1
    elif fn_name == "read_web_page":
        if state.read_web_page_calls_this_request >= state.max_read_pages_per_request:
            result = (
                f"Read-page limit reached (max {state.max_read_pages_per_request} per message). "
                "Use the content already fetched to answer."
            )
            log_line("agent", "📄", "READ_PAGE_LIMIT", f"{state.read_web_page_calls_this_request} >= {state.max_read_pages_per_request}")
        else:
            result = await execute_tool(fn_name, fn_args, state.user_id, untrusted_context=state.untrusted_context_active)
            state.read_web_page_calls_this_request += 1
    elif fn_name == "create_skill":
        async for event in _execute_create_skill(fn_name, fn_args, state, execute_tool):
            if isinstance(event, dict) and event.get("t") == "_create_skill_result":
                result = event.get("result", "")
                if isinstance(result, str) and (result.startswith("Forge:") or result.startswith("Error creating skill:")):
                    friendly = result
                    if not friendly.lower().startswith("i couldn't"):
                        friendly = (
                            "I couldn't create the skill automatically. "
                            + result
                            + " Try a narrower request, or ask for a smaller first version and then improve it."
                        )
                    yield friendly
                    log_line("agent", "⚠️", "CREATE_SKILL_FAIL", result[:220])
                    yield {"t": "_tool_loop_abort"}
                    return
                break
            yield event
    elif fn_name == "control_device":
        tc_id = tc.get("id")
        if tc_id and tc_id in parallel_results:
            result = parallel_results.pop(tc_id)
        else:
            result = await execute_tool(fn_name, fn_args, state.user_id, untrusted_context=state.untrusted_context_active)
    else:
        result = await execute_tool(fn_name, fn_args, state.user_id, untrusted_context=state.untrusted_context_active)

    yield {"t": "_tool_result", "fn_name": fn_name, "tc": tc, "result": result}


async def _execute_create_skill(
    fn_name: str,
    fn_args: Dict[str, Any],
    state: AgentToolLoopState,
    execute_tool: ExecuteToolFn,
) -> AsyncIterator[Any]:
    status_queue = asyncio.Queue()
    task = asyncio.create_task(
        execute_tool(fn_name, fn_args, state.user_id, status_queue=status_queue, untrusted_context=state.untrusted_context_active),
    )
    skill_timeout = 180
    skill_elapsed = 0.0
    result = ""
    while True:
        try:
            ev = await asyncio.wait_for(status_queue.get(), timeout=0.05)
            if isinstance(ev, dict) and ev.get("t") == "status":
                yield _event_status(ev.get("type", ""), label=ev.get("label", ""))
            elif isinstance(ev, dict) and ev.get("t"):
                if ev.get("t") == "forge_preview":
                    state.forge_preview = ev.get("content") or ""
                    state.forge_preview_language = ev.get("language") or "python"
                yield ev
            skill_elapsed = 0.0
        except asyncio.TimeoutError:
            skill_elapsed += 0.05
            if task.done():
                try:
                    result = task.result()
                except Exception as forge_exc:
                    result = f"Error creating skill: {forge_exc}"
                break
            if skill_elapsed >= skill_timeout:
                task.cancel()
                result = "Error creating skill: timed out after 3 minutes."
                break
    yield {"t": "_create_skill_result", "result": result}


def _emit_tool_ui_events(fn_name: str, result: str) -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []
    if fn_name == "store_memory" and ("saved" in result.lower() or "updated" in result.lower()):
        events.append(_event_status("store_memory", label="Memorie actualizată"))
    if fn_name == "search_web":
        try:
            from brain.toolbox import get_last_search_sources, clear_last_search_sources

            sources = get_last_search_sources()
            if sources:
                events.append({"t": "search_sources", "sources": sources})
                clear_last_search_sources()
        except Exception as exc:
            log_line("warn", "⚠️", "UI_EMIT", f"search_sources emit failed: {exc}")
    if fn_name == "run_shell":
        try:
            from brain.tool_shell import get_last_shell_run

            last = get_last_shell_run()
            if last:
                if last.get("requested_but_denied"):
                    events.append({"t": "shell_request", "command": last.get("command", "")})
                else:
                    events.append({
                        "t": "shell_done",
                        "command": last.get("command", ""),
                        "exit_code": last.get("exit_code"),
                        "output_preview": last.get("output_preview", ""),
                    })
        except Exception as exc:
            log_line("warn", "⚠️", "UI_EMIT", f"shell_done emit failed: {exc}")
    if fn_name == "suggest_shell":
        try:
            from brain.tool_shell import get_last_suggest_shell

            last = get_last_suggest_shell()
            if last:
                events.append({
                    "t": "shell_suggest",
                    "command": last.get("command", ""),
                    "reason": last.get("reason", ""),
                })
        except Exception as exc:
            log_line("warn", "⚠️", "UI_EMIT", f"shell_suggest emit failed: {exc}")
    if fn_name in ("propose_patch", "propose_file"):
        try:
            from brain.tool_workspace import get_last_proposal

            prop = get_last_proposal()
            if prop:
                events.append({"t": "proposal", "proposal": prop})
        except Exception as exc:
            log_line("warn", "⚠️", "UI_EMIT", f"proposal emit failed: {exc}")
    return events


async def execute_agent_tool_calls(
    *,
    tool_calls: List[Dict],
    text_content: str,
    stream_done: Dict[str, Any],
    state: AgentToolLoopState,
    execute_tool: ExecuteToolFn,
    md_buf,
) -> AsyncIterator[Any]:
    """Run tool calls for one agent turn. Yields UI/status events; aborts with ``_tool_loop_abort``."""
    _append_assistant_tool_message(state, text_content, tool_calls, stream_done)

    parallel_results = await _run_parallel_searches(tool_calls, state, execute_tool)
    await _run_parallel_device_controls(tool_calls, state, execute_tool, parallel_results)

    for tc in tool_calls:
        fn_name, fn_args, fn_args_raw = _parse_tool_call(tc)
        status_label = _tool_call_status_label(fn_name, fn_args)
        yield _event_status(fn_name, label=status_label)
        log_conversation_model_activity(
            "calls",
            f"{fn_name}"
            + (f"({fn_args_raw[:60]}…)" if len(fn_args_raw or "") > 60 else (f"({fn_args_raw})" if fn_args_raw else "")),
        )

        tool_result: Optional[Dict[str, Any]] = None
        async for event in _execute_single_tool(fn_name, fn_args, tc, state, execute_tool, parallel_results):
            if isinstance(event, dict) and event.get("t") == "_tool_loop_abort":
                yield event
                return
            if isinstance(event, dict) and event.get("t") == "_tool_result":
                tool_result = event
                break
            yield event
        if not tool_result:
            continue
        fn_name = tool_result["fn_name"]
        tc = tool_result["tc"]
        result = tool_result["result"]

        log_detail("agent", "TOOL_RESULT", tool=fn_name, result_len=len(result))
        if (
            state.restrict_mutating_tools
            and not state.untrusted_context_active
            and _tool_result_taints_context(fn_name, result)
        ):
            state.untrusted_context_active = True
            restricted_count = len(_filter_tools_for_untrusted_context(state.tool_catalog, state.safe_untrusted_tool_names))
            log_line(
                "agent",
                "🛡️",
                "TOOL POLICY",
                f"Restricted tools after untrusted content from {fn_name}: {len(state.tool_catalog)}→{restricted_count}",
            )

        tool_result_max = int((settings_mod.CFG.get("intelligence") or {}).get("tool_result_max_chars", 6000) or 6000)
        if len(result) > tool_result_max:
            result = result[:tool_result_max] + "\n... (output truncated)"
            log_line("agent", "✂️", "TOOL TRUNCATE", f"{fn_name} result truncated to {tool_result_max} chars")

        for ui_event in _emit_tool_ui_events(fn_name, result):
            yield ui_event

        tool_msg = {"role": "tool", "tool_call_id": tc.get("id", ""), "content": result}
        state.llm_messages.append(tool_msg)
        state.agent_turn_messages.append(tool_msg)

    buf_tail = md_buf.flush()
    if buf_tail:
        yield buf_tail
    yield {"t": "clear_content"}
    yield {"t": "_tool_loop_complete"}
