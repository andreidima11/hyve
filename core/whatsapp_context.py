"""Bounded in-memory WhatsApp conversation history for WAHA webhook."""

from __future__ import annotations

import asyncio
from collections import OrderedDict


def _make_bounded_whatsapp_store(maxsize: int = 5000):
    class BoundedContextStore(OrderedDict):
        def __setitem__(self, key, value):
            if key in self:
                self.move_to_end(key)
            else:
                while len(self) >= maxsize and self:
                    self.popitem(last=False)
            super().__setitem__(key, value)

    return BoundedContextStore()


whatsapp_context_store = _make_bounded_whatsapp_store()
whatsapp_context_lock = asyncio.Lock()
