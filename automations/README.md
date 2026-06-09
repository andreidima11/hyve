This folder stores canonical automation definitions as YAML files.

Layout:

- `automations/<owner_id>/<automation_id>.yaml`

Notes:

- YAML files are the source of truth for automation definitions.
- The database stores metadata, revision counters, and run history.
- Files are created and updated through the automation definition API.

Supported `action` items:

- `service: turn_on|turn_off|toggle|set` with `entity_id:` and optional `data: { ... }` — controls any entity exposed by an integration that implements `control_entity` (lights, switches, climate, mosquitto/zigbee2mqtt, ariston_net, midea_ac, …).
- `scene: <scene_id>` (or fully qualified `scene.<scene_id>`) — activates a stored scene; the scene must exist at run time.
- `skill: { name: <skill_name>, input: { ... } }` — runs a registered skill and notifies.
- `notify: { text: "..." }` — creates a Hyve notification.
- `delay: <seconds>` (or `delay: { minutes: 1, seconds: 30 }`, or `"HH:MM:SS"`) — pauses the action sequence.
- `wait_template: "{{ ... }}"` with optional `timeout: <seconds>` (default 60) and `continue_on_timeout: true|false` (default true) — blocks until the Jinja template renders truthy.
- `repeat: { count: <N>, actions: [ ... ] }` — runs the inner action list N times. Inner actions can be any other supported kind, including nested `repeat`.
- `choose: [ { condition: ..., sequence: [...] }, ... ]` with optional `default: [...]` — if/elif/else branching. The first branch whose conditions all pass executes its `sequence`; if none match, `default` runs. Each branch's `condition` may be a single condition object, a list of `kind:` conditions, or a Jinja template string (`'{{ ... }}'`).

Supported `trigger` items:

- `platform: time` with `at: HH:MM` and optional `weekdays: [mon, tue, ...]`.
- `platform: datetime` with `at: <ISO-8601>` for one-shot runs.
- `platform: interval` with `every_minutes: <int>` and optional `start_at:`.
- `platform: state` with `entity_id:`, optional `from:` / `to:` — fires on every state change matching the (optional) transition.
- `platform: numeric_state` with `entity_id:`, `above:` and/or `below:`, optional `attribute:` — fires when the value enters the threshold range. Subsequent ticks while still in range do not refire.
- `platform: template` with `value_template: "{{ ... }}"` — re-evaluated on every state change; fires when the result transitions from falsy to truthy. Helpers: `states('eid')`, `state_attr('eid','attr')`, `is_state('eid','val')`, `now()`.
- `platform: sun` with `event: sunrise|sunset` and optional `offset: "HH:MM:SS"` (signed, e.g. `-00:30:00` fires 30 minutes before). Uses the auto-created `sun.sun` entity (Sun integration). Re-arms automatically after each fire.
- `platform: time_pattern` with any of `hours: <"*"|"/N"|int>`, `minutes:`, `seconds:` — cron-like recurring trigger. `"/15"` means every 15 units, `"*"` means every unit.
- `platform: event` with `event_type: <topic>` and optional `event_data: { key: value, ... }` — listens on the internal event bus; matches if every key in `event_data` equals the value in the published payload.

Supported `condition` items:

- `kind: time_window` with `after:` and/or `before:` (HH:MM).
- `kind: state` with `entity_id:` and `state:` (and optional `operator: '==' | '!='`). YAML's `on/off/yes/no` are normalized to `on/off`.
- `kind: numeric_state` with `entity_id:`, `above:` and/or `below:`, optional `attribute:` (compares an entity attribute instead of state).

Top-level options:

- `mode: single | restart | queued | parallel` (default `single`) — how concurrent triggers are handled. `single` skips new triggers while a run is in flight; `restart` cancels the previous run's result and starts fresh; `queued` serializes runs (cap 10 pending); `parallel` runs concurrently.
- `variables: { name: <value or "{{ template }}"> }` — pre-rendered at the start of each run, in declaration order, so later variables can reference earlier ones. Available by name in every template thereafter (`notify.text`, `wait_template`, `choose` template conditions, etc.).