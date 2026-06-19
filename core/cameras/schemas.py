"""Camera API request bodies."""

from __future__ import annotations

from pydantic import BaseModel, Field


class CameraAudioBody(BaseModel):
    action: str = Field(..., description="set_speaker_muted | set_microphone_muted | set_speaker_volume")
    enabled: bool | None = None
    volume: int | None = Field(None, ge=0, le=100)


class CameraStreamTokenBody(BaseModel):
    entity_id: str = Field(..., min_length=1, description="Camera entity to scope the stream token")
