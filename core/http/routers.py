"""Register API routers on the FastAPI application."""

from __future__ import annotations

from fastapi import FastAPI

from routers import addons as addons_router
from routers import areas as areas_router
from routers import auth_tokens as auth_tokens_router
from routers import automations_reminders as automations_reminders_router
from routers import backup as backup_router
from routers import cameras as cameras_router
from routers import cctv as cctv_router
from routers import chat_web as chat_web_router
from routers import comfyui as comfyui_router
from routers import config_profiles as config_profiles_router
from routers import i18n as i18n_router
from routers import dashboard as dashboard_router
from routers import dashboard_ws as dashboard_ws_router
from routers import debug as debug_router
from routers import derived as derived_router
from routers import entries as entries_router
from routers import integrations as integrations_router
from routers import media_proxy as media_proxy_router
from routers import memory as memory_router
from routers import notifications as notifications_router
from routers import notifications_push as notifications_push_router
from routers import notifications_ws as notifications_ws_router
from routers import ollama_proxy as ollama_proxy_router
from routers import openai_proxy as openai_proxy_router
from routers import piper as piper_router
from routers import scenes as scenes_router
from routers import setup as setup_router
from routers import sessions as sessions_router
from routers import shell_proposals as shell_proposals_router
from routers import skills_api as skills_router
from routers import slash as slash_router
from routers import system as system_router
from routers import updates as updates_router
from routers import users_auth as users_auth_router
from routers import webhook_waha as webhook_waha_router
from routers import whisper as whisper_router


def register_routers(app: FastAPI) -> None:
    app.include_router(skills_router.router)
    app.include_router(memory_router.router)
    app.include_router(system_router.router)
    app.include_router(backup_router.router)
    app.include_router(setup_router.router)
    app.include_router(auth_tokens_router.router)
    app.include_router(chat_web_router.router)
    app.include_router(slash_router.router)
    app.include_router(webhook_waha_router.router)
    app.include_router(users_auth_router.router)
    app.include_router(config_profiles_router.router)
    app.include_router(i18n_router.router)
    app.include_router(automations_reminders_router.router)
    app.include_router(shell_proposals_router.router)
    app.include_router(cctv_router.router)
    app.include_router(cameras_router.router)
    app.include_router(sessions_router.router)
    app.include_router(notifications_router.router)
    app.include_router(notifications_push_router.router)
    app.include_router(notifications_ws_router.router)
    app.include_router(openai_proxy_router.router)
    app.include_router(ollama_proxy_router.router)
    app.include_router(whisper_router.router)
    app.include_router(piper_router.router)
    app.include_router(comfyui_router.router)
    app.include_router(entries_router.router)
    app.include_router(addons_router.router)
    app.include_router(integrations_router.router)
    app.include_router(debug_router.router)
    app.include_router(dashboard_router.router)
    app.include_router(dashboard_ws_router.router)
    app.include_router(scenes_router.router)
    app.include_router(areas_router.router)
    app.include_router(derived_router.router)
    app.include_router(media_proxy_router.router)
    app.include_router(updates_router.router)
