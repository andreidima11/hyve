#!/usr/bin/env python3
"""CI checks for router API error payloads and user-facing Romanian in HTTP errors."""

from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROUTERS_DIR = ROOT / "routers"
COMPONENT_ROUTERS_GLOB = "components/*/router.py"
DIACRITICS = set("ăâîșțĂÂÎȘȚ")
ALLOWED_DETAIL_NAMES = frozenset({"detail", "payload", "credentials_exception"})
# Exceptions whose message may bubble to clients — must not use Romanian diacritics.
_RAISE_EXCEPTION_NAMES = frozenset({
    "HTTPException",
    "ValueError",
    "RuntimeError",
    "PermissionError",
    "LookupError",
})


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Call):
        func = node.func
        if isinstance(func, ast.Name):
            return func.id
        if isinstance(func, ast.Attribute):
            return func.attr
    return ""


def _dict_keys(node: ast.Dict) -> list[str]:
    keys: list[str] = []
    for key in node.keys:
        if isinstance(key, ast.Constant) and isinstance(key.value, str):
            keys.append(key.value)
    return keys


def _is_structured_detail(node: ast.AST | None) -> bool:
    if node is None:
        return True
    if isinstance(node, ast.Call):
        name = _call_name(node)
        if name == "error_detail":
            return True
        if isinstance(node.func, ast.Attribute) and node.func.attr in ("as_detail", "errors"):
            return True
    if isinstance(node, ast.Dict):
        keys = _dict_keys(node)
        if "key" in keys:
            return True
        if keys == ["errors"]:
            return True
    if isinstance(node, ast.Name) and node.id in ALLOWED_DETAIL_NAMES:
        return True
    return False


def _detail_has_diacritics(node: ast.AST | None) -> bool:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return any(ch in DIACRITICS for ch in node.value)
    if isinstance(node, ast.JoinedStr):
        for part in node.values:
            if isinstance(part, ast.Constant) and isinstance(part.value, str):
                if any(ch in DIACRITICS for ch in part.value):
                    return True
    return False


def _raise_exception_name(node: ast.Raise) -> str:
    exc = node.exc
    if exc is None:
        return ""
    if isinstance(exc, ast.Call):
        func = exc.func
        if isinstance(func, ast.Name):
            return func.id
        if isinstance(func, ast.Attribute):
            return func.attr
    return ""


def _raise_message(node: ast.Raise) -> ast.AST | None:
    exc = node.exc
    if not isinstance(exc, ast.Call) or not exc.args:
        return None
    return exc.args[0]


def _http_exception_detail(node: ast.Call) -> ast.AST | None:
    if len(node.args) >= 2:
        return node.args[1]
    for kw in node.keywords:
        if kw.arg == "detail":
            return kw.value
    return None


# Integration/catalog display labels and dashboard defaults — not runtime error text.
_DATA_LITERAL_WHITELIST = frozenset({
    "Acasă",
    "E.ON România",
})


def _string_has_diacritics(value: str) -> bool:
    return any(ch in DIACRITICS for ch in value)


def _is_docstring_expr(node: ast.AST, body: list[ast.stmt], index: int) -> bool:
    if index != 0:
        return False
    if not isinstance(node, ast.Expr):
        return False
    val = node.value
    return isinstance(val, ast.Constant) and isinstance(val.value, str)


def _audit_router_string_literals(tree: ast.AST, rel: Path) -> list[str]:
    """Flag Romanian diacritics in runtime string literals (not docstrings / catalog defaults)."""
    issues: list[str] = []

    class Visitor(ast.NodeVisitor):
        def __init__(self) -> None:
            self._docstring_lines: set[int] = set()

        def _mark_docstring(self, body: list[ast.stmt]) -> None:
            if body and _is_docstring_expr(body[0], body, 0):
                val = body[0].value
                if isinstance(val, ast.Constant) and isinstance(val.lineno, int):
                    self._docstring_lines.add(val.lineno)

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            self._mark_docstring(node.body)
            self.generic_visit(node)

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            self._mark_docstring(node.body)
            self.generic_visit(node)

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            self._mark_docstring(node.body)
            self.generic_visit(node)

        def visit_Module(self, node: ast.Module) -> None:
            self._mark_docstring(node.body)
            self.generic_visit(node)

        def visit_Constant(self, node: ast.Constant) -> None:
            if not isinstance(node.value, str):
                return
            if getattr(node, "lineno", None) in self._docstring_lines:
                return
            if node.value in _DATA_LITERAL_WHITELIST:
                return
            if _string_has_diacritics(node.value):
                issues.append(
                    f"{rel}:{getattr(node, 'lineno', '?')}: string literal must not contain Romanian diacritics"
                )

        def visit_JoinedStr(self, node: ast.JoinedStr) -> None:
            for part in node.values:
                if isinstance(part, ast.Constant) and isinstance(part.value, str):
                    if part.value in _DATA_LITERAL_WHITELIST:
                        continue
                    if _string_has_diacritics(part.value):
                        issues.append(
                            f"{rel}:{node.lineno}: f-string must not contain Romanian diacritics"
                        )

    Visitor().visit(tree)
    return issues


def audit_routers() -> list[str]:
    issues: list[str] = []
    paths = sorted(ROUTERS_DIR.rglob("*.py"))
    paths.extend(sorted(ROOT.glob(COMPONENT_ROUTERS_GLOB)))
    seen: set[Path] = set()
    for path in paths:
        if path in seen:
            continue
        seen.add(path)
        rel = path.relative_to(ROOT)
        source = path.read_text(encoding="utf-8")
        try:
            tree = ast.parse(source, filename=str(path))
        except SyntaxError as exc:
            issues.append(f"{rel}:{exc.lineno}: syntax error: {exc.msg}")
            continue
        issues.extend(_audit_router_string_literals(tree, rel))
        for node in ast.walk(tree):
            if isinstance(node, ast.Raise):
                name = _raise_exception_name(node)
                if name in _RAISE_EXCEPTION_NAMES:
                    msg = _raise_message(node)
                    if msg is not None and _detail_has_diacritics(msg):
                        issues.append(
                            f"{rel}:{node.lineno}: raise {name} message must not contain Romanian diacritics"
                        )
            if not isinstance(node, ast.Call) or _call_name(node) != "HTTPException":
                continue
            detail = _http_exception_detail(node)
            if detail is None:
                continue
            if not _is_structured_detail(detail):
                segment = ast.get_source_segment(source, detail) or "?"
                issues.append(f"{rel}:{node.lineno}: HTTPException detail must use error_detail() or {{'key': ...}} ({segment})")
            elif _detail_has_diacritics(detail):
                issues.append(f"{rel}:{node.lineno}: HTTPException detail must not contain Romanian diacritics")
    return issues


def main() -> int:
    issues = audit_routers()
    if issues:
        print("Router contract checks failed:")
        for issue in issues:
            print(f" - {issue}")
        return 1
    print("Router contract checks passed (routers/ + components/*/router.py).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
