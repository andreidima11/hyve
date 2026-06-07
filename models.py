from sqlalchemy import Column, Integer, String, Boolean, ForeignKey, DateTime, Text, Index, text
from sqlalchemy.orm import relationship
from datetime import datetime
from database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True) # Folosit la login
    full_name = Column(String)
    email = Column(String, nullable=True)
    location = Column(String, nullable=True)
    about_me = Column(Text, nullable=True)
    hashed_password = Column(String)
    is_active = Column(Boolean, default=True)
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.now)
    persona_override = Column(Text, nullable=True)  # Personalitate asistent per user (dacă e setat, suprascrie config)
    default_profile_id = Column(String, nullable=True)  # ID profil model implicit pentru acest user (selector chat)
    notification_preferences = Column(Text, nullable=True)  # JSON: {"app": true, "whatsapp": true}

    # Relație cu numerele de telefon (Un user poate avea mai multe numere)
    phone_numbers = relationship("PhoneNumber", back_populates="owner", cascade="all, delete-orphan")
    todo_lists = relationship("TodoList", back_populates="owner", cascade="all, delete-orphan")
    entries = relationship("Entry", back_populates="owner", cascade="all, delete-orphan")
    notifications = relationship("Notification", back_populates="owner", cascade="all, delete-orphan")
    push_devices = relationship("PushDevice", back_populates="owner", cascade="all, delete-orphan")
    scenes = relationship("Scene", back_populates="owner", cascade="all, delete-orphan")

class PhoneNumber(Base):
    __tablename__ = "phone_numbers"

    id = Column(Integer, primary_key=True, index=True)
    number = Column(String, unique=True, index=True) # Format uman: 0728...
    waha_id = Column(String, unique=True, index=True) # Format tehnic: 40728...@c.us
    user_id = Column(Integer, ForeignKey("users.id"))

    owner = relationship("User", back_populates="phone_numbers")


class PushDevice(Base):
    __tablename__ = "push_devices"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    platform = Column(String, nullable=False, default="android")
    installation_id = Column(String, index=True, nullable=False)
    push_token = Column(String, unique=True, index=True, nullable=False)
    device_name = Column(String, nullable=True)
    app_version = Column(String, nullable=True)
    enabled = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)
    last_seen_at = Column(DateTime, default=datetime.now, nullable=False)

    owner = relationship("User", back_populates="push_devices")


class Notification(Base):
    __tablename__ = "notifications"

    id = Column(String, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    title = Column(String, nullable=False, default="Hyve")
    body = Column(Text, nullable=False)
    category = Column(String, index=True, nullable=False, default="system")
    source_type = Column(String, index=True, nullable=True)
    source_id = Column(String, index=True, nullable=True)
    severity = Column(String, nullable=False, default="info")
    priority = Column(String, nullable=False, default="normal")
    dedupe_key = Column(String, index=True, nullable=True)
    payload_json = Column(Text, nullable=True)
    action_url = Column(String, nullable=True)
    read_at = Column(DateTime, nullable=True)
    archived_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.now, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)

    owner = relationship("User", back_populates="notifications")
    deliveries = relationship("NotificationDelivery", back_populates="notification", cascade="all, delete-orphan")

    __table_args__ = (
        Index("ix_notifications_user_unread", "user_id", "read_at", "archived_at"),
        Index("ix_notifications_user_created", "user_id", "created_at"),
    )


class NotificationDelivery(Base):
    __tablename__ = "notification_deliveries"

    id = Column(Integer, primary_key=True, index=True)
    notification_id = Column(String, ForeignKey("notifications.id"), index=True, nullable=False)
    transport = Column(String, index=True, nullable=False)
    target = Column(String, nullable=True)
    status = Column(String, index=True, nullable=False, default="pending")
    attempts = Column(Integer, nullable=False, default=0)
    provider_message_id = Column(String, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    sent_at = Column(DateTime, nullable=True)
    delivered_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)

    notification = relationship("Notification", back_populates="deliveries")


class RevokedToken(Base):
    __tablename__ = "revoked_tokens"

    id = Column(Integer, primary_key=True, index=True)
    jti = Column(String, unique=True, index=True)
    username = Column(String, index=True)
    expires_at = Column(DateTime, nullable=True, index=True)
    revoked_at = Column(DateTime, default=datetime.now)


class AutomationDefinition(Base):
    __tablename__ = "automation_definitions"

    id = Column(String, primary_key=True, index=True)
    owner_type = Column(String, nullable=False, default="user")
    owner_id = Column(String, index=True, nullable=False)
    title = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    enabled = Column(Boolean, default=True, nullable=False)
    channel = Column(String, nullable=False, default="web")
    source_yaml = Column(Text, nullable=False)
    normalized_json = Column(Text, nullable=False)
    source_version = Column(Integer, nullable=False, default=1)
    revision = Column(Integer, nullable=False, default=1)
    trigger_hash = Column(String, nullable=True)
    last_compiled_at = Column(DateTime, nullable=True)
    last_run_at = Column(DateTime, nullable=True)
    last_run_status = Column(String, nullable=True)
    last_error = Column(Text, nullable=True)
    created_by = Column(String, nullable=False)
    updated_by = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)

    runs = relationship("AutomationRun", back_populates="automation", cascade="all, delete-orphan")


class AutomationRun(Base):
    __tablename__ = "automation_runs"

    id = Column(Integer, primary_key=True, index=True)
    automation_id = Column(String, ForeignKey("automation_definitions.id"), index=True, nullable=False)
    status = Column(String, nullable=False)
    trigger_source = Column(String, nullable=False, default="manual")
    message = Column(Text, nullable=True)
    details_json = Column(Text, nullable=True)
    started_at = Column(DateTime, default=datetime.now, nullable=False)
    finished_at = Column(DateTime, nullable=True)

    automation = relationship("AutomationDefinition", back_populates="runs")


class AutomationBlueprint(Base):
    """Reusable, parameterized automation template.

    A blueprint stores raw YAML containing ``{{ inputs.foo }}``-style
    Jinja-ish placeholders together with an inputs schema describing each
    placeholder (id, label, type, default, required). Instantiating a
    blueprint substitutes the supplied values and produces a normal
    AutomationDefinition that the runner already understands.
    """

    __tablename__ = "automation_blueprints"

    id = Column(String, primary_key=True, index=True)
    owner_id = Column(String, index=True, nullable=False)
    title = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    source_yaml = Column(Text, nullable=False)
    inputs_json = Column(Text, nullable=False, default="[]")
    version = Column(Integer, nullable=False, default=1)
    created_by = Column(String, nullable=False)
    updated_by = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)


class TodoList(Base):
    __tablename__ = "todo_lists"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    title = Column(String, nullable=False)
    color = Column(String, nullable=True)
    icon = Column(String, nullable=True)
    archived = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)

    owner = relationship("User", back_populates="todo_lists")
    entries = relationship("Entry", back_populates="todo_list", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_todo_lists_user_archived_updated", "user_id", "archived", "updated_at"),
    )


class Entry(Base):
    __tablename__ = "entries"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    list_id = Column(Integer, ForeignKey("todo_lists.id"), index=True, nullable=False)
    entry_type = Column(String, nullable=False)  # task | event
    title = Column(String, nullable=False)
    content = Column(Text, nullable=True)
    status = Column(String, nullable=False, default="active")

    # Task fields
    task_status = Column(String, nullable=True)  # todo | in_progress | done
    priority = Column(Integer, nullable=True)
    due_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    # Event fields
    start_at = Column(DateTime, nullable=True)
    end_at = Column(DateTime, nullable=True)
    all_day = Column(Boolean, nullable=True)
    location = Column(String, nullable=True)
    event_color = Column(String, nullable=True)
    event_notify = Column(Boolean, nullable=True, default=True)
    event_notify_minutes = Column(Integer, nullable=True, default=30)
    event_notify_job_id = Column(String, nullable=True)
    event_action_enabled = Column(Boolean, nullable=True, default=False)
    event_action_entity_id = Column(String, nullable=True)
    event_action_service = Column(String, nullable=True)
    event_action_offset_minutes = Column(Integer, nullable=True, default=0)
    event_action_job_id = Column(String, nullable=True)

    position = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)

    owner = relationship("User", back_populates="entries")
    todo_list = relationship("TodoList", back_populates="entries")

    __table_args__ = (
        Index("idx_entries_user_list_status_due", "user_id", "list_id", "task_status", "due_at"),
        Index("idx_entries_user_type_updated", "user_id", "entry_type", "updated_at"),
        Index("idx_entries_list_position", "list_id", "position"),
        Index("idx_entries_user_type_start", "user_id", "entry_type", "start_at"),
    )


class Scene(Base):
    __tablename__ = "scenes"

    id = Column(String, primary_key=True, index=True)
    owner_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    icon = Column(String, nullable=True)
    color = Column(String, nullable=True)
    is_shared = Column(Boolean, default=False, nullable=False)
    enabled = Column(Boolean, default=True, nullable=False)
    entries_json = Column(Text, nullable=False, default="[]")
    last_activated_at = Column(DateTime, nullable=True)
    activation_count = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)

    owner = relationship("User", back_populates="scenes")


class Area(Base):
    __tablename__ = "areas"

    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)
    ha_area_id = Column(String, nullable=True, index=True)
    icon = Column(String, nullable=True)
    color = Column(String, nullable=True)
    floor = Column(String, nullable=True)
    aliases_json = Column(Text, nullable=False, default="[]")
    extra_entities_json = Column(Text, nullable=False, default="[]")
    ordering = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)
