# Cum se scrie o integrare Hyve

Hyve folosește un model **declarativ pe foldere**: un folder per integrare +
`manifest.json` + schemă declarativă = UI auto-generat, multi-cont, secrete
criptate, sync periodic și control.

## Tier A — path generic (țintă)

Pentru integrări care expun entități, acceptă config entries și nu necesită
streaming sau protocoale speciale:

> Drop a folder in [components/](../components/) (bundled) or [custom_components/](../custom_components/) → restart → integrarea apare în UI.

**Nu ar trebui** să atingi routere platformă, `features.js`, sau `startup_phases.py`.

## Tier B — excepții documentate (încă necesită cod platformă)

Unele capabilități nu încap în schema generică. Dacă adaugi una din acestea,
planifică și cod în `routers/` sau `core/http/startup_phases.py`:

| Capabilitate | Exemple | Unde trăiește azi |
|--------------|---------|-------------------|
| Streaming video / WebSocket camere | Tapo, Reolink, Mammotion | `components/mammotion/router.py` (Mammotion); rest în `routers/cameras.py` |
| Wyoming voice (TTS/STT) | Piper, Whisper | `components/piper/router.py`, `components/whisper/router.py` |
| Workflow UI extern | ComfyUI | `components/comfyui/router.py` |
| MQTT bridge la boot | Mosquitto | `components/mosquitto/bridge.py`, `startup_phases.py` |
| Webhook inbound | WAHA | `routers/webhook_waha.py` |

**Ținta pe termen mediu:** capabilities în `manifest.json` + hook-uri `lifecycle.py` (în loc de `if slug == …` în platformă). Exemple live: `mosquitto` (`mqtt_bridge`), `mammotion` (`streaming`).

---

## 0. Layout pe foldere (recomandat, Phase 2+)

Integrările noi ar trebui livrate ca folder cu `manifest.json`:

```
components/my_service/          # sau custom_components/my_service/
├── manifest.json               # domain, name, version (obligatoriu)
├── entity.py                   # clasă BaseEntity (sau integration.py)
├── lifecycle.py                # opțional: startup, wiring, rename, shutdown
├── extract.py                  # opțional: transformă payload în entități
├── client.py                   # opțional
└── translations/
    ├── en.json
    └── ro.json
```

**manifest.json** minim:

```json
{
  "domain": "my_service",
  "name": "My Service",
  "version": "1.0.0",
  "integration_type": "entity"
}
```

`domain` trebuie să coincidă cu `slug` din clasă și (de preferință) cu numele folderului.

### Lifecycle (`lifecycle.py`)

Pentru comportament la boot, după creare entry, rename sau shutdown — **nu** adăuga `if slug == "my_service"` în `startup_phases.py` sau `entries.py`.

În `manifest.json`:

```json
{
  "capabilities": ["mqtt_bridge"],
  "lifecycle_module": "lifecycle"
}
```

`capabilities` documentează ce face integrarea (ex. `mqtt_bridge`, `streaming`). Platforma le poate indexa fără import hardcodat.

În `components/<slug>/lifecycle.py` implementează doar hook-urile necesare (toate opționale):

| Hook | Când rulează |
|------|----------------|
| `ENTRY_TEST_TIMEOUT_SECONDS` | Timeout la `POST …/entries/test` |
| `before_initial_sync(manager, entry_id, slug)` | Înainte de primul sync după create |
| `after_entry_wired(manager, entry_id, slug)` | După wiring fetcher/sync |
| `startup_all(manager, slug)` | La boot Hyve (toate entry-urile) |
| `shutdown(slug)` | La oprire proces |
| `purge_discovery_on_rename(manager, slug, canonical_id, old_names)` | După rename device |

Dispatcher: `integrations/lifecycle.py`. Teste: `tests/test_integration_lifecycle.py`.

### HTTP router (`router.py`)

Pentru rute API specifice integrării (streaming, Wyoming, workflow extern) — **nu**
adăuga import în `core/http/routers.py` per slug.

În `manifest.json` (opțional):

```json
{
  "router_module": "router"
}
```

În `components/<slug>/router.py`:

```python
from fastapi import APIRouter

router = APIRouter(prefix="/api/my_service", tags=["my_service"])
```

La boot, `integrations/capability_routers.py` descoperă modulele și le înregistrează
automat. Rutele rămase în `routers/cameras.py`, `routers/comfyui.py`, … se
migrează treptat în folderele lor.

Teste: `tests/test_capability_routers.py`.

### Traduceri

Vezi **[I18N.md](I18N.md)** — reguli complete. Pe scurt:

- Shell UI → `static/js/lang/en.js` + `ro.js`
- Integrare → `components/<slug>/translations/`
- Add-on → `addons/translations/` + `addons/available/<slug>/translations/`
- Platformă (camere, scene, …) → `core/i18n/<bundle>/translations/`
- UI încarcă totul prin `GET /api/i18n/bundles` — **nu** adăuga stringuri de integrare în mother lang.

**Override utilizator:** copiază folderul în `custom_components/` sau setează `HYVE_CUSTOM_COMPONENTS_DIR`. Custom suprascrie același `domain` din `components/`.

**Contract entități:** vezi [ENTITY_CONTRACT.md](ENTITY_CONTRACT.md) pentru `state`, `attributes.status_key` și `attributes.status`.

---

## 1. Anatomia unui provider

Un provider este o subclasă de [`BaseEntity`](../integrations/base.py)
în `components/<slug>/entity.py` (sau `custom_components/<slug>/entity.py`).

### Structura minimă

```python
from __future__ import annotations
from typing import Any
from integrations.base import BaseEntity


class MyServiceEntity(BaseEntity):
    # ── identitate (obligatoriu) ──────────────────────────────────────
    slug = "my_service"            # unic, snake_case, devine cheie API
    label = "My Service"            # nume afișat în UI
    icon = "fa-bolt"                # FontAwesome class
    color = "text-amber-400"        # Tailwind text color

    # ── comportament ──────────────────────────────────────────────────
    scan_interval_seconds = 300     # sync default (sec)
    supports_sync = True            # False = nu se face sync periodic
    SUPPORTS_MULTIPLE = True        # True = permite N conturi/instanțe

    # ── schemă config (declarativă) ───────────────────────────────────
    CONFIG_SCHEMA = [
        {"key": "host",     "label": "Host",     "type": "url",      "required": True},
        {"key": "username", "label": "User",     "type": "text",     "required": True},
        {"key": "password", "label": "Parola",   "type": "password", "required": True, "secret": True},
        {"key": "scan_interval", "label": "Interval (sec)", "type": "number", "default": 300, "min": 60},
    ]

    # ── obligatoriu: fetch + extract ──────────────────────────────────
    async def fetch_entities(self) -> dict[str, Any]:
        cfg = self.entry_data            # dict cu valorile din formular
        # ... apeluri HTTP, MQTT, etc.
        return {"raw": ...}

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        # transformă payload-ul în lista plată de entități
        return [
            {
                "id": f"{self.slug}_{self.entry_id[:8]}_temp",
                "name": "Temperatura",
                "state": payload["raw"]["t"],
                "unit": "°C",
                "domain": "sensor",
            },
        ]
```

Atât. Restartează serverul și integrarea apare în Setări → Integrări cu buton
**„Adaugă cont”** și formular auto-randat din `CONFIG_SCHEMA`.

---

## 2. Atribute de clasă

| Atribut                 | Tip         | Implicit              | Rol |
|-------------------------|-------------|-----------------------|-----|
| `slug`                  | `str`       | — (obligatoriu)       | Cheie unică (URL, DB, API). |
| `label`                 | `str`       | `slug`                | Nume afișat. |
| `icon`                  | `str`       | `"fa-puzzle-piece"`   | Clasă FontAwesome 6. |
| `color`                 | `str`       | `"text-slate-400"`    | Clasă Tailwind. |
| `scan_interval_seconds` | `int`       | `300`                 | Frecvență sync (min. 60). |
| `supports_sync`         | `bool`      | `True`                | `False` = doar acțiuni, fără polling. |
| `SUPPORTS_MULTIPLE`     | `bool`      | `False`               | `True` = N instanțe (ex: 2 conturi). |
| `CONFIG_SCHEMA`         | `list[dict]`| `[]`                  | Câmpurile formularului. |

---

## 3. `CONFIG_SCHEMA` — referință câmpuri

Fiecare câmp este un dict:

```python
{
    "key":         "username",          # obligatoriu — cheie în entry_data
    "label":       "Utilizator",        # text afișat
    "type":        "text",              # vezi tabel mai jos
    "required":    True,                # default False
    "secret":      False,               # True = criptat la rest, mascat în UI
    "placeholder": "name@example.com",
    "default":     "",                  # valoare prefilledă
    "help":        "Email-ul contului", # text ajutător sub câmp
    "options":     [                    # doar pentru type=select
        {"value": "auto", "label": "Automat"},
        {"value": "manual", "label": "Manual"},
    ],
}
```

### Tipuri suportate (`type`)

| Tip        | Render UI            | Validare/Notă |
|------------|----------------------|---------------|
| `text`     | `<input type=text>`  | string |
| `password` | `<input type=password>` | combinat de obicei cu `"secret": True` |
| `number`   | `<input type=number>`| acceptă `min`, `max`, `step` |
| `url`      | `<input type=url>`   | validare browser URL |
| `bool`     | `<input type=checkbox>` | salvează `True`/`False` |
| `select`   | `<select>`           | necesită `options: [{value, label}]` |

### Câmpuri marcate `secret: True`

- Valoarea se criptează cu **Fernet** ([`integrations/secrets.py`](../integrations/secrets.py))
  înainte de scriere în SQLite.
- În răspunsurile API apare ca `"••••••"` (mască).
- La PATCH, dacă utilizatorul lasă masca neschimbată, valoarea veche se
  păstrează automat.

---

## 4. Metode pe care le implementezi

### 4.1 `async fetch_entities(self) -> dict` — **obligatoriu**

Apelat periodic de scheduler. Citește credențiale din `self.entry_data`,
contactează serviciul extern, întoarce payload brut.

```python
async def fetch_entities(self) -> dict[str, Any]:
    host = self.entry_data["host"]
    user = self.entry_data["username"]
    pwd  = self.entry_data["password"]
    async with httpx.AsyncClient() as cli:
        r = await cli.post(f"{host}/login", json={"u": user, "p": pwd})
        r.raise_for_status()
        return r.json()
```

### 4.2 `extract_entities(self, payload) -> list[dict]` — **obligatoriu**

Transformă payload-ul în lista plată de entități. **Schema Hyve** (după
normalizare automată în `BaseEntity.list_entities`):

```python
{
    "entity_id": "sensor.my_service_a1b2c3d4_temp1",  # <domain>.<object_id>
    "unique_id": "my_service:a1b2c3d4:temp1",         # ID intern stabil pentru routing
    "name":      "Temperatura living",
    "state":     22.5,
    "unit":      "°C",
    "domain":    "sensor",   # sensor | binary_sensor | switch | light | climate |
                             # water_heater | number | select | scene | weather | sun | …
    "source":    "my_service",
    # opțional:
    "icon":      "fa-thermometer-half",
    "controllable": False,
    "attributes": {...},
    "capabilities": {"min": 0, "max": 100, "step": 1, "options": [...]},
}
```

> **Cum funcționează normalizarea**: poți returna `entity_id` în formatul
> intern al integrării (ex. `"my_service:a1b2c3d4:temp1"`) — `BaseEntity.list_entities`
> aplică `smart_home_registry.normalize_entity_record()` care:
> - mută id-ul vechi în `unique_id` (păstrat pentru routing intern),
> - rescrie `entity_id` ca `<domain>.<object_id>` (slug din nume),
> - validează `domain` ∈ `KNOWN_DOMAINS` (default `sensor`).
>
> Funcția e **idempotentă**: dacă întorci deja id în format `domain.x`, nu se
> schimbă nimic. Recomandare: lasă normalizarea pe seama framework-ului.

> **Important pentru multi-instanță**: include `self.entry_id[:8]` în
> `unique_id` ca să nu coliziuneze două conturi.

**Domain-uri standard** (vizibile în UI/automatizări):

| Domain | Folosință |
|--------|-----------|
| `sensor` | valori numerice/text read-only |
| `binary_sensor` | stări on/off read-only (online, mișcare, ușă) |
| `switch` | comutator on/off controlabil |
| `light` | bec/lumină (brightness, color) |
| `climate` | termostat/AC (target_temp, hvac_mode, fan, swing) |
| `water_heater` | boiler (target_temp, mode, away) |
| `number` | input numeric (setpoint, delay) |
| `select` | dropdown (mod operare, presetare) |
| `scene` | scenă declanșabilă |
| `weather` | prognoză + condiții curente |
| `sun` | poziție soare (next_rising, elevation, ...) |
| `cover` / `lock` / `vacuum` / `fan` / `media_player` / `button` | controale standard smart home |

### 4.3 `async control_entity(entity_id, action, data=None)` — opțional

Pentru integrări cu device-uri controlabile (switch, light, climate):

```python
async def control_entity(self, entity_id, action, data=None):
    # ``entity_id`` aici este ``unique_id`` (id-ul intern stabil), NU id-ul
    # ``entity_id`` afișat în UI. Routing-ul (router/dashboard/automatizări) face
    # automat traducerea către ``unique_id`` înainte de a chema această metodă.
    if action == "turn_on":
        await self._client.set(entity_id, True)
    elif action == "turn_off":
        await self._client.set(entity_id, False)
    else:
        raise NotImplementedError(action)
    return {"ok": True}
```

### 4.4 `async_validate_entry(cls, data)` classmethod — opțional

Validare la **submit**-ul formularului (înainte de salvare). Aici testezi
conexiunea cu credențialele introduse:

```python
@classmethod
async def async_validate_entry(cls, data: dict) -> dict:
    try:
        async with httpx.AsyncClient() as cli:
            r = await cli.post(f"{data['host']}/login", json={...})
            r.raise_for_status()
        return {"ok": True, "title": data.get("username") or data["host"]}
    except Exception as e:
        return {"ok": False, "errors": {"password": f"Login eșuat: {e}"}}
```

Câmpul `title` returnat devine numele entry-ului (afișat în lista de conturi).

### 4.5 `format_context(self, entities) -> str` — opțional

Text care se injectează în contextul LLM-ului (ex: rezumat meteo).

---

## 5. Cum citești configurația

```python
self.entry_data           # dict cu valorile salvate (decriptate)
self.entry_id             # ID unic UUID
self.entry_title          # numele dat de user (sau slug pentru legacy)
```

**Nu** mai citi din `settings.CFG[slug]`. Acela este folosit doar pentru
migrarea legacy.

---

## 6. Ciclul de viață

```
discover → CONFIG_SCHEMA expusă în /api/integrations/<slug>/schema
         ↓
user „Adaugă cont” → POST /api/integrations/<slug>/entries
         ↓
async_validate_entry()  ← ultima șansă să respingi credențialele
         ↓
SQLite (config/integration_entries.sqlite)  ← secretele criptate Fernet
         ↓
manager.reload() → instanță nouă cu entry_data populat
         ↓
fetch_entities() rulat la fiecare scan_interval
         ↓
extract_entities() → entity_store → UI / LLM / scheduler
```

---

## 7. Backward-compat (legacy `config.json`)

Dacă există încă o secțiune `cfg["my_service"] = {enabled: True, ...}` în
[`config.json`](../config.json) și **niciun entry**, la pornire se creează
automat un entry „My Service (migrat)” cu acele valori. Apoi UI-ul preia
controlul. Nu trebuie să faci nimic pentru migrare.

---

## 8. Exemple în repo

| Folder | Caracteristici demonstrate |
|--------|----------------------------|
| [`components/open_meteo/`](../components/open_meteo/) | Schema simplă, fără secrete, multi-locație |
| [`components/pago/`](../components/pago/) | Email + parolă (secret), multi-cont |
| [`components/fusion_solar/`](../components/fusion_solar/) | `select` cu mai multe moduri (auto/openapi/kiosk) |
| [`components/mosquitto/`](../components/mosquitto/) | Host + port + auth opțional, control switch |
| [`components/ariston_net/`](../components/ariston_net/) | Login persistent + climate control |

---

## 9. Checklist înainte de commit

- [ ] Clasa moștenește `BaseEntity` și are `slug` unic.
- [ ] `CONFIG_SCHEMA` declarat (chiar gol, dacă nu necesită config).
- [ ] Toate parolele/token-urile au `"secret": True`.
- [ ] `SUPPORTS_MULTIPLE` setat corect (True dacă pot fi N conturi).
- [ ] `fetch_entities` citește **doar** din `self.entry_data`.
- [ ] `extract_entities` include `self.entry_id[:8]` în `id` pentru unicity.
- [ ] (opțional) `async_validate_entry` testează credențialele live.
- [ ] Restart server → integrarea apare automat în UI fără modificări frontend.

---

## 10. Ce **NU** mai faci niciodată

- ❌ Nu adăuga template HTML custom per integrare.
- ❌ Nu hardcoda câmpuri în [`features.js`](../static/js/features.js) sau [`index.html`](../templates/index.html).
- ❌ Nu scrie endpoint-uri custom pentru CRUD config — folosește schema.
- ❌ Nu citi parole din `config.json` — folosește `entry_data` (criptat).
- ❌ Nu instanția providerul manual — `IntegrationManager` se ocupă.

> Dacă te trezești editând `features.js` sau routere per-vendor,
> probabil faci ceva greșit. Schema declarativă trebuie să acopere cazul.
