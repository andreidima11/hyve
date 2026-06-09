# Derived entities ("template sensors")

Entități virtuale calculate din stările altor entități (din orice integrare:
Mosquitto/Zigbee2MQTT, Pago, FusionSolar, etc.). Apar ca orice alt senzor în
UI-ul Smart Home și pot fi incluse în contextul AI.

## Arhitectură

```
┌────────────────────────────────────────────────────────────────┐
│ UI: view-smarthome                                             │
│  ├─ "+ Derived" button  → openDerivedModal()                   │
│  └─ row click (source=derived)  → openDerivedModal(eid)        │
│                                                                │
│ features_derived.js                                            │
│  ├─ openDerivedModal / closeDerivedModal                       │
│  ├─ saveDerived (POST /create | PUT /{eid})                    │
│  ├─ deleteDerivedFromModal (DELETE /{eid})                     │
│  ├─ runDerivedPreview (POST /preview)   — debounced live       │
│  └─ loadCandidates (GET /candidates)                           │
└────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────┐
│ routers/derived.py  →  /api/derived/*                          │
│  list | raw | create | update | delete | selection | aliases  │
│  preview | candidates                                          │
└────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────┐
│ derived_entities.py                                            │
│  ├─ storage → derived_entities.json                            │
│  ├─ safe AST evaluator (whitelist)                             │
│  ├─ preset evaluators (sum/avg/min/max/diff/any_on/...)        │
│  └─ evaluate_entry(entry, state_map)                           │
└────────────────────────────────────────────────────────────────┘
                             │
                             ▼
       aggregated state_map from routers/integrations._all_entities
       (include_derived=False to avoid cycles when evaluating)
```

## Model de date (`derived_entities.json`)

```json
[
  {
    "entity_id": "derived.consum_total",
    "name": "Consum total",
    "value_type": "number",         // number | binary | text
    "unit": "W",
    "aliases": ["consum casă"],
    "selected": true,                // include in AI context
    "formula": {
      "type": "expression",          // expression | sum | avg | min | max |
                                     // difference | any_on | all_on |
                                     // count_on | concat
      "expression": "sensor.solar_power + sensor.grid_power",
      "inputs": ["sensor.solar_power", "sensor.grid_power"]
    }
  }
]
```

## Evaluator de expresii (safe)

Nu rulăm `eval()`. Expresia e parsată cu `ast.parse(..., mode="eval")`, iar
walk-ul AST acceptă doar:

- literali (numere, string, True/False/None)
- nume → variabile (entity refs rescrise ca `_e_sensor_foo`)
- operatori binari: `+ - * / // % **`
- operatori unari: `+ -` și `not`
- comparatori: `== != < <= > >=`
- operatori booleni: `and`, `or`
- expresie ternară `a if cond else b`
- apeluri doar către whitelist: `min max abs round sum len int float bool str sqrt floor ceil`

Orice alt tip de nod (atribute, subscript, import, lambda, comprehensions,
keyword args etc.) aruncă `UnsafeExpression` → rezultatul devine `unavailable`.

## Conversia stărilor

`_to_number(raw)` acceptă:

- `bool` → 1/0
- `int`/`float` direct
- string `"on/off/open/home/playing/..."` → 1/0
- string cu unități (`"12.5 W"`, `"72%"`) → extrage primul număr

Pentru `value_type=binary`, rezultatul expresiei e trecut prin `_is_on` înainte
să devină `"on"`/`"off"`. Pentru `value_type=number`, se formatează cu până la
3 zecimale trim-uite.

## Integrare

1. **`routers/integrations._all_entities()`** – adăugat flag `include_derived`
   (default True). Când e True, construiește un `state_map` din rezultatul
   intermediar (Mosquitto/Z2M + Pago + FusionSolar + …) și apelează
   `derived_entities.evaluate_all(state_map)` înainte de sort. Astfel derived
   entities apar natural în `/api/integrations/all-entities` folosite de Smart
   Home și dashboard.

2. **Context AI** – după ce adaugă entitățile selectate în prompt, iterează
   și prin `derived_entities.load_config()`.
   Entitățile cu `selected=true` sunt evaluate și apar în contextul AI ca orice
   alt senzor.

3. **`routers/derived._build_state_map()`** – folosește
   `_all_entities(include_derived=False)` pentru preview/evaluare, ca să
   evităm loop-uri self-referenciale între entitățile derivate.

## UI

- Buton nou în toolbar-ul Smart Home: `+ Derived` (icon calculator).
- Modal `#derived-modal` cu:
  - Name, Type (number/binary/text), Unit
  - Tabs: Preset / Expression
  - Preset: dropdown operație + listă entități cu search
  - Expression: textarea monospace + dropdown "Insert entity"
  - Preview live (debounced 400ms) — apelează `/preview`
- Rândurile cu `data-source="derived"` au:
  - icon fa-calculator, culoare pink
  - click → edit modal
  - AI toggle wired la `/selection`
  - buton ✎ pentru edit (în loc de X)

## API

| Method | Path                                   | Descriere                                         |
|--------|----------------------------------------|---------------------------------------------------|
| GET    | `/api/derived/list`                    | toate entitățile derivate evaluate live           |
| GET    | `/api/derived/raw`                     | entry-urile raw (pentru editare)                  |
| GET    | `/api/derived/candidates`              | entități disponibile ca input                     |
| POST   | `/api/derived/create`                  | creează entitate                                  |
| PUT    | `/api/derived/{entity_id}`             | update                                            |
| DELETE | `/api/derived/{entity_id}`             | șterge                                            |
| POST   | `/api/derived/{entity_id}/selection`   | include/exclude din contextul AI                  |
| POST   | `/api/derived/{entity_id}/aliases`     | setează aliasuri                                  |
| POST   | `/api/derived/preview`                 | evaluează o formulă pe stările curente (dry-run)  |

## Limitări (v1)

- Nu persistăm istoric / grafice — doar valoarea live.
- Nu generăm acțiuni sau notificări când trec praguri (urmează separat).
- Nu expunem `attributes` complexe, doar `state` + `unit`.
- Formulele nu pot referi alte entități derivate decât indirect prin
  `/api/integrations/all-entities`; derivatele nu se evaluează recursiv.
