# Pachet brain: cortex (orchestrator), toolbox (tools), hippocampus (consolidare), synapses (log evenimente).

from brain.cortex import (
    generate_response_stream,
    generate_response,
    process_memory_pipeline,
    resolve_and_save,
    get_coder_cfg,
    clean_history,
    summarize_conversation,
    strip_think,
    strip_think_content,
    log_line,
    CONTEXT_LOCK,
    USER_CONTEXT,
)

__all__ = [
    "generate_response_stream",
    "generate_response",
    "process_memory_pipeline",
    "resolve_and_save",
    "get_coder_cfg",
    "clean_history",
    "summarize_conversation",
    "strip_think",
    "strip_think_content",
    "log_line",
    "CONTEXT_LOCK",
    "USER_CONTEXT",
]
