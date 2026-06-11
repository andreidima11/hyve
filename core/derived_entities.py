"""Derived ("template") entities.

Entități virtuale calculate din stările altor entități (din orice integrare).
Stocate în `derived_entities.json`. Evaluate live la fiecare cerere pe baza
unui dict `entity_id -> state` agregat din toate sursele.

Formulă suportată (v1):
  - preset: sum | avg | min | max | difference | any_on | all_on | count_on
  - expression: expresie matematică safe (whitelist AST) cu referințe la entity_id

Exemplu formulă expression:
    "sensor.solar_power + sensor.grid_power"
    "(sensor.a - sensor.b) / 2"
    "max(sensor.a, sensor.b)"
"""
from __future__ import annotations

import ast
import json
import math
import operator
import os
import re
import tempfile
import traceback
from typing import Any, Iterable, Optional

import core.logger as log_mod


CONFIG_FILE = "derived_entities.json"
DERIVED_SOURCE = "derived"
DERIVED_PREFIX = "derived."

VALUE_TYPES = ("number", "binary", "text")
PRESETS = ("sum", "avg", "min", "max", "difference",
           "any_on", "all_on", "count_on", "concat", "transform")
TRANSFORM_FILTERS = ("none", "only_positive", "only_negative",
                     "clamp_positive", "clamp_negative", "abs")
_ON_STATES = {"on", "open", "unlocked", "home", "playing", "cleaning", "active", "true"}
_OFF_STATES = {"off", "closed", "locked", "away", "idle", "paused", "false",
               "unavailable", "unknown", "none", "null", ""}
# Match HA-style entity_id (`light.kitchen`) AND integration-prefixed ids
# that use `:` (Z2M, Pago, FusionSolar etc.: `fusion_solar:device:123:active_power`).
_ENTITY_ID_RE = re.compile(
    r"[a-z_][a-z0-9_]*(?:\.[a-z0-9_:]+|(?::[a-z0-9_]+){1,})",
    re.IGNORECASE,
)


# ---------- storage ---------------------------------------------------------
def load_config() -> list[dict[str, Any]]:
    if not os.path.exists(CONFIG_FILE):
        return []
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        log_mod.log_line("error", "❌", "Derived load", traceback.format_exc())
        return []


def save_config(data: list[dict[str, Any]]) -> None:
    dir_name = os.path.dirname(CONFIG_FILE) or "."
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, CONFIG_FILE)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ---------- helpers ---------------------------------------------------------
def _slugify(text: str) -> str:
    text = (text or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_")
    return text or "entity"


def make_entity_id(name: str, existing: Optional[Iterable[str]] = None) -> str:
    base = DERIVED_PREFIX + _slugify(name)
    existing = set(existing or [])
    if base not in existing:
        return base
    i = 2
    while f"{base}_{i}" in existing:
        i += 1
    return f"{base}_{i}"


def extract_entity_ids(expression: str) -> list[str]:
    """Return all entity_id references found inside an expression string."""
    if not expression:
        return []
    matches = _ENTITY_ID_RE.findall(expression)
    allowed = {"And", "Or", "Not"}
    return [m for m in matches if m.lower() not in allowed]


def _to_number(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return None
    low = s.lower()
    if low in _ON_STATES:
        return 1.0
    if low in _OFF_STATES:
        return 0.0
    # extract first numeric token (handles "12.3 W", "72%", etc.)
    m = re.search(r"-?\d+(?:[.,]\d+)?", s)
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", "."))
    except ValueError:
        return None


def _is_on(value: Any) -> Optional[bool]:
    if value is None:
        return None
    s = str(value).strip().lower()
    if s in _ON_STATES:
        return True
    if s in _OFF_STATES:
        return False
    num = _to_number(value)
    if num is None:
        return None
    return num != 0


# ---------- safe expression evaluator --------------------------------------
_BIN_OPS: dict[type, Any] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY_OPS: dict[type, Any] = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
    ast.Not: operator.not_,
}
_CMP_OPS: dict[type, Any] = {
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
}
_SAFE_FUNCS: dict[str, Any] = {
    "min": min, "max": max, "abs": abs, "round": round,
    "sum": sum, "len": len, "int": int, "float": float,
    "bool": bool, "str": str,
    "sqrt": math.sqrt, "floor": math.floor, "ceil": math.ceil,
}


class UnsafeExpression(Exception):
    pass


def _eval_ast(node: ast.AST, variables: dict[str, Any]) -> Any:
    if isinstance(node, ast.Expression):
        return _eval_ast(node.body, variables)
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in variables:
            return variables[node.id]
        if node.id in _SAFE_FUNCS:
            return _SAFE_FUNCS[node.id]
        if node.id in ("True", "true"):
            return True
        if node.id in ("False", "false"):
            return False
        if node.id in ("None", "null"):
            return None
        raise UnsafeExpression(f"Unknown name: {node.id}")
    if isinstance(node, ast.BinOp):
        op_fn = _BIN_OPS.get(type(node.op))
        if not op_fn:
            raise UnsafeExpression(f"Unsupported operator: {type(node.op).__name__}")
        return op_fn(_eval_ast(node.left, variables), _eval_ast(node.right, variables))
    if isinstance(node, ast.UnaryOp):
        op_fn = _UNARY_OPS.get(type(node.op))
        if not op_fn:
            raise UnsafeExpression(f"Unsupported unary: {type(node.op).__name__}")
        return op_fn(_eval_ast(node.operand, variables))
    if isinstance(node, ast.BoolOp):
        values = [_eval_ast(v, variables) for v in node.values]
        if isinstance(node.op, ast.And):
            result = True
            for v in values:
                result = result and v
            return result
        if isinstance(node.op, ast.Or):
            result = False
            for v in values:
                result = result or v
            return result
        raise UnsafeExpression(f"Unsupported boolop: {type(node.op).__name__}")
    if isinstance(node, ast.Compare):
        left = _eval_ast(node.left, variables)
        for op, comparator in zip(node.ops, node.comparators):
            op_fn = _CMP_OPS.get(type(op))
            if not op_fn:
                raise UnsafeExpression(f"Unsupported cmp: {type(op).__name__}")
            right = _eval_ast(comparator, variables)
            if not op_fn(left, right):
                return False
            left = right
        return True
    if isinstance(node, ast.IfExp):
        cond = _eval_ast(node.test, variables)
        return _eval_ast(node.body if cond else node.orelse, variables)
    if isinstance(node, ast.Call):
        func = _eval_ast(node.func, variables)
        if func not in _SAFE_FUNCS.values():
            raise UnsafeExpression("Only whitelisted functions allowed")
        args = [_eval_ast(a, variables) for a in node.args]
        if node.keywords:
            raise UnsafeExpression("Keyword args not supported")
        return func(*args)
    if isinstance(node, ast.Tuple):
        return tuple(_eval_ast(e, variables) for e in node.elts)
    if isinstance(node, ast.List):
        return [_eval_ast(e, variables) for e in node.elts]
    raise UnsafeExpression(f"Unsupported node: {type(node).__name__}")


# Permissive regex used when we *don't* yet know the real entity_id set
# (e.g. when extracting refs for storage or validating a draft formula).
# It allows any char that commonly appears in our integration-prefixed ids,
# including `=` (FusionSolar station codes) and `-`.
_REWRITE_RE = re.compile(
    r"[a-zA-Z_][a-zA-Z0-9_]*"
    r"(?:\.[a-zA-Z0-9_:.=\-]+|(?::[a-zA-Z0-9_.=\-]+){1,})"
)


def _var_for_entity(eid: str) -> str:
    return "_e_" + re.sub(r"[^a-zA-Z0-9]", "_", eid)


def _rewrite_entity_refs(expression: str,
                         state_map: Optional[dict[str, Any]] = None
                         ) -> tuple[str, dict[str, str]]:
    """Replace each entity_id token with a safe Python identifier.

    When `state_map` is provided, we first substitute any literal entity_id
    that appears in the map (longest-first, so that longer ids aren't shadowed
    by shorter prefixes). This is the most reliable strategy because real ids
    can contain characters that no regex will anticipate (e.g. `=`, `-`).

    Remaining occurrences are then matched by a permissive regex, which handles
    fresh drafts where the id isn't in `state_map` yet.

    Returns ``(rewritten_expression, var_name -> entity_id)``.
    """
    mapping: dict[str, str] = {}
    text = expression

    if state_map:
        # Replace literal entity_ids. Sort longest first to avoid shadowing.
        keys = sorted((k for k in state_map.keys() if k), key=len, reverse=True)
        for eid in keys:
            if eid not in text:
                continue
            var = _var_for_entity(eid)
            mapping[var] = eid
            text = text.replace(eid, var)

    def _repl(match: re.Match) -> str:
        eid = match.group(0)
        if re.fullmatch(r"\d+\.\d+", eid):  # don't touch numeric literals
            return eid
        if eid.startswith("_e_"):  # already rewritten above
            return eid
        var = _var_for_entity(eid)
        mapping[var] = eid
        return var

    rewritten = _REWRITE_RE.sub(_repl, text)
    return rewritten, mapping


def evaluate_expression(expression: str, state_map: dict[str, Any],
                        value_type: str = "number") -> Any:
    """Evaluate a safe expression against the given state_map. Returns computed value
    or None if any required input is missing/invalid."""
    if not expression or not expression.strip():
        return None
    try:
        rewritten, mapping = _rewrite_entity_refs(expression, state_map)
        variables: dict[str, Any] = {}
        for var, eid in mapping.items():
            raw = _resolve_state(state_map, eid)
            if raw is None or raw == "unavailable" or raw == "unknown":
                return None
            # Prefer numeric binding; fall back to raw string so that expressions
            # using state == "on" keep working. value_type only dictates how the
            # final result is formatted.
            num = _to_number(raw)
            variables[var] = num if num is not None else raw
        tree = ast.parse(rewritten, mode="eval")
        return _eval_ast(tree, variables)
    except UnsafeExpression as e:
        log_mod.log_line("warn", "⚠️", "Derived expr", f"unsafe: {e}")
        return None
    except Exception:
        log_mod.log_line("warn", "⚠️", "Derived expr", traceback.format_exc())
        return None


def _resolve_state(state_map: dict[str, Any], entity_id: str) -> Any:
    val = state_map.get(entity_id)
    if isinstance(val, dict):
        return val.get("state")
    return val


# ---------- preset evaluators ----------------------------------------------
def evaluate_preset(preset: str, inputs: list[str], state_map: dict[str, Any],
                    value_type: str = "number") -> Any:
    if not preset or not inputs:
        return None
    raw_values = [_resolve_state(state_map, eid) for eid in inputs]
    numbers = [n for n in (_to_number(v) for v in raw_values) if n is not None]
    bools = [b for b in (_is_on(v) for v in raw_values) if b is not None]

    if preset == "sum":
        return sum(numbers) if numbers else None
    if preset == "avg":
        return sum(numbers) / len(numbers) if numbers else None
    if preset == "min":
        return min(numbers) if numbers else None
    if preset == "max":
        return max(numbers) if numbers else None
    if preset == "difference":
        if len(numbers) < 2:
            return None
        return numbers[0] - sum(numbers[1:])
    if preset == "any_on":
        return any(bools) if bools else None
    if preset == "all_on":
        if not bools or len(bools) < len(inputs):
            return None
        return all(bools)
    if preset == "count_on":
        return sum(1 for b in bools if b)
    if preset == "concat":
        parts = [str(v) for v in raw_values if v not in (None, "")]
        return " ".join(parts) if parts else ""
    return None


def apply_transform(value: Any, *, filter_kind: str = "none",
                    scale: float = 1.0, offset: float = 0.0) -> Any:
    """Apply a numeric filter / scale / offset to a value.

    `filter_kind`:
      - none           pass-through
      - only_positive  return None when value < 0  (entity becomes unavailable)
      - only_negative  return None when value > 0
      - clamp_positive max(value, 0)
      - clamp_negative min(value, 0)
      - abs            absolute value
    Then result = result * scale + offset.
    Non-numeric values are passed through unchanged.
    """
    if value is None:
        return None
    num = _to_number(value)
    if num is None:
        return value
    fk = (filter_kind or "none").lower()
    if fk == "only_positive":
        if num < 0:
            return None
    elif fk == "only_negative":
        if num > 0:
            return None
    elif fk == "clamp_positive":
        num = max(num, 0.0)
    elif fk == "clamp_negative":
        num = min(num, 0.0)
    elif fk == "abs":
        num = abs(num)
    try:
        s = float(scale) if scale is not None else 1.0
    except (TypeError, ValueError):
        s = 1.0
    try:
        o = float(offset) if offset is not None else 0.0
    except (TypeError, ValueError):
        o = 0.0
    return num * s + o


def evaluate_transform(formula: dict[str, Any], state_map: dict[str, Any]) -> Any:
    inputs = list(formula.get("inputs") or [])
    if not inputs:
        return None
    raw = _resolve_state(state_map, inputs[0])
    if raw is None or raw == "unavailable" or raw == "unknown":
        return None
    return apply_transform(
        raw,
        filter_kind=str(formula.get("filter") or "none"),
        scale=formula.get("scale", 1),
        offset=formula.get("offset", 0),
    )


# ---------- public API ------------------------------------------------------
def format_state(value: Any, value_type: str) -> str:
    """Format a computed value into a string state (consistent with HA states)."""
    if value is None:
        return "unavailable"
    if value_type == "binary":
        if isinstance(value, bool):
            return "on" if value else "off"
        as_bool = _is_on(value)
        if as_bool is None:
            return "unavailable"
        return "on" if as_bool else "off"
    if value_type == "number":
        try:
            num = float(value)
        except (TypeError, ValueError):
            return "unavailable"
        if math.isnan(num) or math.isinf(num):
            return "unavailable"
        if num.is_integer():
            return str(int(num))
        return f"{num:.3f}".rstrip("0").rstrip(".")
    return str(value)


def _get_formula_inputs(entry: dict[str, Any]) -> list[str]:
    formula = entry.get("formula") or {}
    inputs = list(formula.get("inputs") or [])
    if formula.get("type") == "expression":
        inputs.extend(extract_entity_ids(formula.get("expression") or ""))
    # dedupe preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for eid in inputs:
        if eid and eid not in seen:
            seen.add(eid)
            unique.append(eid)
    return unique


def evaluate_entry(entry: dict[str, Any], state_map: dict[str, Any]) -> dict[str, Any]:
    """Evaluate a single derived entry against state_map → a dict compatible with
    the unified entity schema used in /api/integrations/all-entities."""
    formula = entry.get("formula") or {}
    ftype = (formula.get("type") or "").lower()
    value_type = (entry.get("value_type") or "number").lower()
    if value_type not in VALUE_TYPES:
        value_type = "number"

    value: Any = None
    if ftype == "expression":
        value = evaluate_expression(formula.get("expression") or "", state_map, value_type)
    elif ftype == "transform":
        value = evaluate_transform(formula, state_map)
    elif ftype in PRESETS:
        value = evaluate_preset(ftype, formula.get("inputs") or [], state_map, value_type)
    else:
        value = None

    eid = str(entry.get("entity_id") or "")
    domain = eid.split(".", 1)[0] if "." in eid else (
        "sensor" if value_type == "number" else
        "binary_sensor" if value_type == "binary" else "sensor"
    )
    return {
        "entity_id": eid,
        "name": entry.get("name") or eid,
        "state": format_state(value, value_type),
        "domain": domain,
        "source": DERIVED_SOURCE,
        "aliases": entry.get("aliases") or [],
        "unit": entry.get("unit") or "",
        "controllable": False,
        "selected": bool(entry.get("selected", False)),
        "derived": True,
        "value_type": value_type,
        "formula": formula,
        "inputs": _get_formula_inputs(entry),
    }


def evaluate_all(state_map: dict[str, Any]) -> list[dict[str, Any]]:
    """Evaluate all derived entries. `state_map` can map entity_id to a raw state
    string or a dict like {'state': ..., 'unit': ...}."""
    return [evaluate_entry(entry, state_map) for entry in load_config()]


# ---------- CRUD ------------------------------------------------------------
def _validate_formula(formula: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(formula, dict):
        raise ValueError("formula must be an object")
    ftype = (formula.get("type") or "").strip().lower()
    if ftype == "expression":
        expr = str(formula.get("expression") or "").strip()
        if not expr:
            raise ValueError("expression is required")
        # dry-run: ensure it parses and uses only safe nodes
        rewritten, _mapping = _rewrite_entity_refs(expr)
        try:
            ast.parse(rewritten, mode="eval")
        except SyntaxError as e:
            raise ValueError(f"invalid expression syntax: {e}") from e
        return {"type": "expression", "expression": expr,
                "inputs": list(formula.get("inputs") or []) or extract_entity_ids(expr)}
    if ftype == "transform":
        inputs = [str(x).strip() for x in (formula.get("inputs") or []) if str(x).strip()]
        if not inputs:
            raise ValueError("transform requires one input entity")
        filter_kind = str(formula.get("filter") or "none").lower()
        if filter_kind not in TRANSFORM_FILTERS:
            raise ValueError(f"transform filter must be one of {TRANSFORM_FILTERS}")
        try:
            scale = float(formula.get("scale", 1))
        except (TypeError, ValueError):
            raise ValueError("scale must be a number")
        try:
            offset = float(formula.get("offset", 0))
        except (TypeError, ValueError):
            raise ValueError("offset must be a number")
        return {"type": "transform", "inputs": inputs[:1],
                "filter": filter_kind, "scale": scale, "offset": offset}
    if ftype in PRESETS:
        inputs = list(formula.get("inputs") or [])
        inputs = [str(x).strip() for x in inputs if str(x).strip()]
        if not inputs:
            raise ValueError("inputs list is required")
        return {"type": ftype, "inputs": inputs}
    raise ValueError(f"unknown formula type: {ftype!r}")


def create_entry(name: str, value_type: str, formula: dict[str, Any],
                 unit: str = "", aliases: Optional[list[str]] = None,
                 selected: bool = True) -> dict[str, Any]:
    name = (name or "").strip()
    if not name:
        raise ValueError("name is required")
    if value_type not in VALUE_TYPES:
        raise ValueError(f"value_type must be one of {VALUE_TYPES}")
    formula = _validate_formula(formula)
    config = load_config()
    existing_ids = {item.get("entity_id") for item in config}
    entity_id = make_entity_id(name, existing_ids)
    entry = {
        "entity_id": entity_id,
        "name": name,
        "value_type": value_type,
        "unit": str(unit or "").strip(),
        "aliases": [str(a).strip() for a in (aliases or []) if str(a).strip()],
        "selected": bool(selected),
        "formula": formula,
    }
    config.append(entry)
    save_config(config)
    return entry


def update_entry(entity_id: str, **updates: Any) -> Optional[dict[str, Any]]:
    config = load_config()
    for item in config:
        if item.get("entity_id") != entity_id:
            continue
        if "name" in updates and updates["name"]:
            item["name"] = str(updates["name"]).strip()
        if "value_type" in updates and updates["value_type"]:
            vt = str(updates["value_type"]).lower()
            if vt not in VALUE_TYPES:
                raise ValueError(f"value_type must be one of {VALUE_TYPES}")
            item["value_type"] = vt
        if "unit" in updates:
            item["unit"] = str(updates["unit"] or "").strip()
        if "aliases" in updates and updates["aliases"] is not None:
            aliases = updates["aliases"]
            if not isinstance(aliases, list):
                raise ValueError("aliases must be a list")
            item["aliases"] = [str(a).strip() for a in aliases if str(a).strip()]
        if "selected" in updates and updates["selected"] is not None:
            item["selected"] = bool(updates["selected"])
        if "formula" in updates and updates["formula"] is not None:
            item["formula"] = _validate_formula(updates["formula"])
        save_config(config)
        return item
    return None


def delete_entry(entity_id: str) -> bool:
    config = load_config()
    new_config = [item for item in config if item.get("entity_id") != entity_id]
    if len(new_config) == len(config):
        return False
    save_config(new_config)
    return True


def set_selected(entity_id: str, selected: bool) -> bool:
    config = load_config()
    for item in config:
        if item.get("entity_id") == entity_id:
            item["selected"] = bool(selected)
            save_config(config)
            return True
    return False


def set_aliases(entity_id: str, aliases: list[str]) -> bool:
    config = load_config()
    for item in config:
        if item.get("entity_id") == entity_id:
            item["aliases"] = [str(a).strip() for a in (aliases or []) if str(a).strip()]
            save_config(config)
            return True
    return False
