#!/usr/bin/env python3
"""Verify one Bridge-generated Python package: syntax, import, round-trip.

Usage: python3 python_roundtrip.py <generated-python-dir>

Steps, all deterministic:
1. `ast.parse` every `*.py` file in the package directory (syntax gate).
2. Import the package normally (importlib, parent dir on sys.path).
3. For every dataclass defined in the package's modules that carries both
   `to_dict` and `from_dict`, build a deterministic instance from its type
   annotations, serialize with `to_dict()`, decode with `from_dict()` and
   assert the decoded instance equals the original.
4. Call `validate()` on every instance (constraint code must at least run;
   dummy values may legitimately violate constraints, so the error list is
   reported, not asserted empty).

Exits non-zero on any failure.
"""
import ast
import dataclasses
import enum
import importlib
import sys
import typing
from pathlib import Path
from typing import Any


def build_value(hint):
    """Build a deterministic dummy value for a resolved type hint."""
    origin = typing.get_origin(hint)

    if origin is typing.Union or (hasattr(typing, "UnionType") and origin is typing.UnionType):
        args = [a for a in typing.get_args(hint) if a is not type(None)]
        if len(args) != len(typing.get_args(hint)):
            return None  # Optional[X] -> None
        return build_value(args[0])

    if origin in (list, set, dict):
        return origin()

    if hint is Any:
        return {}

    if hint is str:
        return "bridge"
    if hint is bool:
        return True
    if hint is int:
        return 7
    if hint is float:
        return 0.5
    if hint is bytes:
        return b"bridge"

    if isinstance(hint, type) and dataclasses.is_dataclass(hint):
        return build_dataclass(hint)

    if isinstance(hint, type) and issubclass(hint, enum.Enum):
        return next(iter(hint))

    # Unknown annotation: prefer an empty dict (the `Any`-shaped wire value).
    return {}


def build_dataclass(cls):
    """Build a deterministic instance of a generated dataclass."""
    hints = typing.get_type_hints(cls)
    kwargs = {}
    for field in dataclasses.fields(cls):
        kwargs[field.name] = build_value(hints[field.name])
    return cls(**kwargs)


def find_package_dir(root: Path) -> Path:
    """The importable package dir: the child containing __init__.py."""
    candidates = sorted(p for p in root.iterdir() if (p / "__init__.py").is_file())
    if not candidates:
        raise SystemExit(f"FAIL: no package (dir with __init__.py) under {root}")
    return candidates[0]


def main(root: Path) -> int:
    # 1. Syntax gate: ast.parse every module.
    for path in sorted(root.rglob("*.py")):
        try:
            ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError as error:
            print(f"FAIL syntax: {path}: {error}")
            return 1

    # 2. Import the package (e.g. <root>/payments_v1 -> import payments_v1).
    pkg_dir = find_package_dir(root)
    sys.path.insert(0, str(root))
    package = importlib.import_module(pkg_dir.name)

    # 3. Round-trip every dataclass with to_dict/from_dict.
    checked = 0
    seen = set()
    for attr_name in sorted(vars(package)):
        cls = getattr(package, attr_name)
        if attr_name in seen or not isinstance(cls, type):
            continue
        if not dataclasses.is_dataclass(cls):
            continue
        # Only classes defined inside this generated package, not re-exports.
        if getattr(cls, "__module__", "").split(".")[0] != pkg_dir.name:
            continue
        if not (
            callable(getattr(cls, "to_dict", None))
            and callable(getattr(cls, "from_dict", None))
        ):
            continue
        seen.add(attr_name)
        instance = build_dataclass(cls)
        wire = instance.to_dict()
        decoded = cls.from_dict(wire)
        if decoded != instance:
            print(f"FAIL round-trip: {cls.__name__}: {wire!r}")
            return 1
        # Constraint code must run; dummy values may legitimately violate
        # constraints, so findings are reported, not asserted empty.
        errors = instance.validate() if hasattr(instance, "validate") else []
        note = f", validate() -> {len(errors)} finding(s)" if errors else ""
        print(f"round-trip OK: {cls.__name__}{note}")
        checked += 1

    if checked == 0:
        print("FAIL: no round-trippable dataclasses found")
        return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    target = Path(sys.argv[1])
    if not target.is_dir():
        print(f"FAIL: {target} is not a directory")
        sys.exit(2)
    sys.exit(main(target))
