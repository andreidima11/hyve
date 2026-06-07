"""Shared SlowAPI limiter instance (bound to app.state.limiter in middleware)."""

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address, default_limits=["120/minute"])
