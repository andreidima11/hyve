import asyncio
from typing import Any, Callable, List, Optional

import brain
import settings
import storage


class PostResponseManager:
    def __init__(self, log_line: Callable[[str, str, str, str], None]):
        self._log_line = log_line
        self._queue: Optional[asyncio.Queue] = None
        self._workers_count = 0
        self._lock = asyncio.Lock()

    def _get_queue(self) -> asyncio.Queue:
        if self._queue is None:
            self._queue = asyncio.Queue()
        return self._queue

    async def _update_session_summary_if_needed(self, session_id: str):
        """Summarize the conversation and persist working memory."""
        try:
            settings.reload_config()
            cfg = settings.CFG
            summarize_every = cfg.get("memory", {}).get("summarize_every", 8)
            session = storage.get_session(session_id)
            if not session or len(session.get("messages", [])) < summarize_every:
                return
            summary = await brain.summarize_conversation(session["messages"])
            if summary:
                session["summary"] = summary
                storage.save_session(session_id, session)
                self._log_line("mem", "📋", "SUMMARY", f"Updated ({len(session['messages'])} msgs)")
        except Exception as exc:
            self._log_line("error", "⚠️", "SUMMARY", str(exc))

    async def _run_post_response_tasks(
        self,
        user_id: str,
        user_msg: str,
        full_response: str,
        session_id: str,
        history: list,
        skip_memory_pipeline: bool = False,
    ):
        """Run post-response steps sequentially."""
        if not skip_memory_pipeline:
            try:
                await brain.process_memory_pipeline(user_msg or "", user_id, full_response, recent_exchanges=history)
            except Exception as exc:
                self._log_line("error", "⚠️", "MEMORY", str(exc))
        try:
            await self._update_session_summary_if_needed(session_id)
        except Exception as exc:
            self._log_line("error", "⚠️", "SUMMARY", str(exc))
        try:
            from core.memory_maintenance import consolidate_session_memory_mvp

            await asyncio.to_thread(consolidate_session_memory_mvp, session_id, "threshold")
        except Exception as exc:
            self._log_line("error", "⚠️", "MEMORY_MVP", str(exc))
        # Index session exchanges into ChromaDB for searchable transcripts
        try:
            from core.session_indexer import index_session_exchanges
            session = storage.get_session(session_id)
            if session:
                count = await asyncio.to_thread(index_session_exchanges, session, user_id)
                if count:
                    self._log_line("mem", "📚", "SESSION INDEX", f"Indexed {count} exchanges")
        except Exception as exc:
            self._log_line("error", "⚠️", "SESSION INDEX", str(exc))

    async def _worker(self):
        """Consume queued post-response jobs."""
        queue = self._get_queue()
        try:
            while True:
                job = await queue.get()
                try:
                    await self._run_post_response_tasks(*job)
                except Exception as exc:
                    self._log_line("error", "⚠️", "POST_RESPONSE", str(exc))
                finally:
                    queue.task_done()
        finally:
            self._workers_count = max(0, self._workers_count - 1)

    async def _maybe_spawn_workers(self):
        try:
            cfg = settings.CFG.get("intelligence") or {}
            target_workers = max(1, min(5, int(cfg.get("post_response_concurrency", 1))))
        except Exception as exc:
            self._log_line("error", "⚠️", "CONFIG", f"post_response_concurrency read failed: {exc}")
            target_workers = 1
        async with self._lock:
            while self._workers_count < target_workers:
                self._workers_count += 1
                from task_utils import create_tracked_task

                create_tracked_task(self._worker(), name="post_response_worker")

    def enqueue(
        self,
        user_id: str,
        user_msg: str,
        full_response: str,
        session_id: str,
        history: List[Any],
        skip_memory_pipeline: bool = False,
    ):
        self._get_queue().put_nowait((user_id, user_msg, full_response, session_id, history, skip_memory_pipeline))
        from task_utils import create_tracked_task

        create_tracked_task(self._maybe_spawn_workers(), name="post_response_spawn")
