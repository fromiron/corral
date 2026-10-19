#!/usr/bin/env python3
"""Validate a design-token proposal and, optionally, its rendered HTML page.

The JSON check confirms structure, references, evidence for every observed value,
a rationale for every new-system design hypothesis, safe CSS values, and
computable color contrast. The HTML check confirms that no
template placeholders remain and that the page still declares proposal status.
Neither check proves that the values suit the product; render and review them.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, NamedTuple, NoReturn

# Keep UTF-8 output stable on Windows consoles with legacy code pages.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

UNKNOWN = "unknown"
FOUNDATIONS = ("color", "typography", "spacing", "layout", "radius")
TYPE_FIELDS = ("font_family", "font_size", "font_weight", "line_height", "letter_spacing")
SEMANTIC_STATUSES = {"proposed", "retained", "unknown"}
CHANGE_ACTIONS = {"merge", "rename", "delete", "retain", "add"}
RELATIONSHIPS = {"shared-contour", "independent", "pill-or-circle"}
DECISION_GROUPS = ("proposed", "retained", "rejected", "open")
MODES = ("normalize", "new-system")
BASES = ("observed", "hypothesis")
LANGUAGES = ("en", "ko", "ja")
QUESTION_BANK = Path(__file__).resolve().parent.parent / "assets" / "token-questions.json"
QUESTION_STAGES = ("approach", "core", "follow-up")
# Four choices fit the structured question tools some clients offer; plain
# text works everywhere.
MAX_OPTIONS = 4
DELEGATE = "delegate"
CUSTOM = "custom"
APPROACHES = ("auto", "guided")
THEME_CONTEXTS = {"light": ("light",), "dark": ("dark",), "both": ("light", "dark")}
COLOR_QUESTIONS = {"color-family", "brand-color-value"}
# A written answer that starts like a color notation must parse as a supported color.
COLOR_ANSWER = re.compile(r"^\s*(?:#|(?:rgba?|oklch|oklab|hsla?|hwb|lab|lch|color)\()", re.I)
LAYOUT_DIAGRAMS = ("content-width", "page-padding")
TOKEN_NAME = re.compile(r"^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$")
PLACEHOLDER = re.compile(r"\{\{[A-Z0-9_]+\}\}")
# CSS values are written into inline custom properties. Allow plain values only:
# no declarations, blocks, at-rules, escapes, or functions that can load resources.
SAFE_CSS = re.compile(r"^[A-Za-z0-9#%.,+\-*/()\s\"']+$")
UNSAFE_CSS_FUNCTIONS = re.compile(r"(url|image|image-set|cross-fade|element|expression|src)\s*\(", re.I)
HEX_COLOR = re.compile(r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
COLOR_FUNCTION = re.compile(r"^(rgba?|oklch)\(\s*(.*?)\s*\)$", re.I)
COLOR_COMPONENT = re.compile(r"^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|grad|rad|turn)?$", re.I)
# CSS Color 4 gamut mapping: a just-noticeable OKLab difference and search precision.
GAMUT_JND = 0.02
GAMUT_EPSILON = 0.0001


def die(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        die(f"file not found: {path}")
    except json.JSONDecodeError as exc:
        die(f"invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}")
    if not isinstance(data, dict):
        die("top-level value must be an object")
    return data


def non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def load_question_bank(path: Path = QUESTION_BANK) -> dict[str, Any]:
    """Load the guided-proposal question bank and check its structure."""
    bank = read_json(path)
    questions = bank.get("questions")
    if not isinstance(questions, list) or not questions:
        die(f"{path}: questions must be a non-empty array")
    messages = bank.get("messages")
    if not isinstance(messages, dict) or not all(
        isinstance(text, dict) and all(non_empty_string(text.get(lang)) for lang in LANGUAGES)
        for text in messages.values()
    ):
        die(f"{path}: every message needs en, ko, and ja text")
    seen: set[str] = set()
    for index, question in enumerate(questions):
        prefix = f"{path}: questions[{index}]"
        if not isinstance(question, dict) or not non_empty_string(question.get("id")):
            die(f"{prefix} must be an object with an id")
        if question["id"] in seen:
            die(f"{prefix}: duplicate question id {question['id']!r}")
        seen.add(question["id"])
        stage = question.get("stage")
        if stage not in QUESTION_STAGES:
            die(f"{prefix}.stage must be one of {list(QUESTION_STAGES)}")
        texts = [question.get("prompt")]
        if question.get("custom") is not None:
            texts.append(question["custom"])
        options = question.get("options")
        if not isinstance(options, list):
            die(f"{prefix}.options must be an array")
        option_ids = []
        for option in options:
            if not isinstance(option, dict) or not non_empty_string(option.get("id")):
                die(f"{prefix}: every option needs an id")
            option_ids.append(option["id"])
            texts.append(option.get("label"))
        if len(set(option_ids)) != len(option_ids) or "custom" in option_ids:
            die(f"{prefix}: option ids must be unique and must not be 'custom'")
        for text in texts:
            if not isinstance(text, dict) or not all(non_empty_string(text.get(lang)) for lang in LANGUAGES):
                die(f"{prefix}: every prompt, label, and custom hint needs en, ko, and ja text")
        if stage == "core" and (len(options) > MAX_OPTIONS or not options or option_ids[-1] != DELEGATE):
            die(f"{prefix}: a core question has at most {MAX_OPTIONS} options ending with {DELEGATE!r}")
        if stage == "follow-up" and (options or question.get("custom") is None):
            die(f"{prefix}: a follow-up question takes a written answer and has no options")
        if stage == "approach" and len(options) < 2:
            die(f"{prefix}: the approach question needs at least two options")
    core = {question["id"] for question in questions if question["stage"] == "core"}
    for question in questions:
        if question["stage"] == "follow-up" and question.get("after") not in core:
            die(f"{path}: follow-up {question['id']!r} must follow a core question")
    return bank


def string_list(value: Any) -> bool:
    return isinstance(value, list) and all(non_empty_string(item) for item in value)


def css_value_error(value: str) -> str | None:
    if value == UNKNOWN:
        return None
    if not SAFE_CSS.match(value) or UNSAFE_CSS_FUNCTIONS.search(value):
        return "contains characters or functions that are not allowed in a token value"
    return None


class Color(NamedTuple):
    """A parsed CSS color: displayable sRGB channels, alpha, and OKLCH coordinates."""

    rgb: tuple  # gamma-encoded sRGB channels from 0 to 1, after gamut mapping
    alpha: float
    oklch: tuple  # lightness 0-1, chroma, hue in degrees
    in_gamut: bool


def _decode(channel: float) -> float:
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def _encode(channel: float) -> float:
    return 12.92 * channel if channel <= 0.0031308 else 1.055 * channel ** (1 / 2.4) - 0.055


def _linear_to_oklab(red: float, green: float, blue: float) -> tuple:
    def cube_root(value: float) -> float:
        return math.copysign(abs(value) ** (1 / 3), value)

    long = cube_root(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue)
    medium = cube_root(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue)
    short = cube_root(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue)
    return (
        0.2104542553 * long + 0.7936177850 * medium - 0.0040720468 * short,
        1.9779984951 * long - 2.4285922050 * medium + 0.4505937099 * short,
        0.0259040371 * long + 0.7827717662 * medium - 0.8086757660 * short,
    )


def _oklch_to_linear(lightness: float, chroma: float, hue: float) -> tuple:
    a = chroma * math.cos(math.radians(hue))
    b = chroma * math.sin(math.radians(hue))
    long = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
    medium = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
    short = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return (
        4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
        -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
        -0.0041960863 * long - 0.7034186147 * medium + 1.7076147010 * short,
    )


def _in_srgb(linear: tuple) -> bool:
    return all(-0.000001 <= channel <= 1.000001 for channel in linear)


def _oklch_to_srgb(lightness: float, chroma: float, hue: float) -> tuple:
    """Return gamma-encoded sRGB and whether the color was inside sRGB.

    Out-of-gamut colors are mapped as in CSS Color 4: reduce chroma until
    clipping changes the color by less than a just-noticeable difference.
    """
    if lightness >= 1:
        return (1.0, 1.0, 1.0), chroma < 0.0005
    if lightness <= 0:
        return (0.0, 0.0, 0.0), chroma < 0.0005
    linear = _oklch_to_linear(lightness, chroma, hue)
    if _in_srgb(linear):
        return tuple(_encode(min(1.0, max(0.0, c))) for c in linear), True

    def clip(lin: tuple) -> tuple:
        return tuple(min(1.0, max(0.0, c)) for c in lin)

    def distance(lin: tuple, clipped: tuple) -> float:
        return math.dist(_linear_to_oklab(*lin), _linear_to_oklab(*clipped))

    clipped = clip(linear)
    if distance(linear, clipped) < GAMUT_JND:
        return tuple(_encode(c) for c in clipped), False
    low, high, low_in_gamut = 0.0, chroma, True
    while high - low > GAMUT_EPSILON:
        middle = (low + high) / 2
        current = _oklch_to_linear(lightness, middle, hue)
        if low_in_gamut and _in_srgb(current):
            low = middle
            continue
        clipped = clip(current)
        difference = distance(current, clipped)
        if difference < GAMUT_JND:
            if GAMUT_JND - difference < GAMUT_EPSILON:
                break
            low_in_gamut = False
            low = middle
        else:
            high = middle
    return tuple(_encode(c) for c in clipped), False


def _srgb_to_oklch(rgb: tuple) -> tuple:
    lightness, a, b = _linear_to_oklab(*(_decode(channel) for channel in rgb))
    chroma = math.hypot(a, b)
    if chroma < 0.0005:
        return lightness, 0.0, 0.0
    return lightness, chroma, math.degrees(math.atan2(b, a)) % 360


def _components(body: str) -> tuple:
    """Split modern or legacy color syntax into channel strings and an alpha string."""
    alpha = None
    if "/" in body:
        body, alpha = (part.strip() for part in body.split("/", 1))
    parts = [part for part in re.split(r"[\s,]+", body.strip()) if part]
    if alpha is None and len(parts) == 4:
        alpha = parts.pop()
    return parts, alpha


def _number(part: str, *, percent: float, units: bool = False) -> float | None:
    if part.lower() == "none":
        return 0.0
    match = COLOR_COMPONENT.match(part)
    if not match:
        return None
    value, unit = float(match.group(1)), (match.group(2) or "").lower()
    if unit == "%":
        return value / 100 * percent
    if unit and not units:
        return None
    return value * {"": 1, "deg": 1, "grad": 0.9, "rad": 180 / math.pi, "turn": 360}[unit]


def parse_color(value: Any) -> Color | None:
    """Parse hex, rgb(), rgba(), or oklch(); return None for other values."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if HEX_COLOR.match(value):
        digits = value[1:]
        if len(digits) in (3, 4):
            digits = "".join(char * 2 for char in digits)
        channels = [int(digits[index:index + 2], 16) / 255 for index in range(0, len(digits), 2)]
        rgb = tuple(channels[:3])
        alpha = channels[3] if len(channels) == 4 else 1.0
        return Color(rgb, alpha, _srgb_to_oklch(rgb), True)
    match = COLOR_FUNCTION.match(value)
    if not match:
        return None
    kind = match.group(1).lower()
    parts, alpha_part = _components(match.group(2))
    if len(parts) != 3:
        return None
    alpha = 1.0 if alpha_part is None else _number(alpha_part, percent=1)
    if alpha is None:
        return None
    alpha = min(1.0, max(0.0, alpha))
    if kind in ("rgb", "rgba"):
        channels = [_number(part, percent=255) for part in parts]
        if any(channel is None for channel in channels):
            return None
        rgb = tuple(min(1.0, max(0.0, channel / 255)) for channel in channels)
        return Color(rgb, alpha, _srgb_to_oklch(rgb), True)
    lightness = _number(parts[0], percent=1)
    chroma = _number(parts[1], percent=0.4)
    hue = _number(parts[2], percent=1, units=True)
    if lightness is None or chroma is None or hue is None or "%" in parts[2]:
        return None
    # A unitless lightness above 1 is almost always a percentage written without
    # its sign; clamping it to white would hide the mistake.
    if not parts[0].endswith("%") and lightness > 1:
        return None
    lightness, chroma, hue = min(1.0, max(0.0, lightness)), max(0.0, chroma), hue % 360
    rgb, in_gamut = _oklch_to_srgb(lightness, chroma, hue)
    return Color(rgb, alpha, (lightness, chroma, hue), in_gamut)


def color_formats(color: Color) -> dict[str, Any]:
    """The same color in hex, rgb()/rgba(), and oklch() notation, rounded."""
    red, green, blue = (round(channel * 255) for channel in color.rgb)
    lightness, chroma, hue = color.oklch
    if chroma < 0.0005:
        chroma, hue = 0.0, 0.0
    alpha = round(color.alpha, 3)
    opaque = alpha >= 1
    alpha_text = f"{alpha:g}"
    return {
        "hex": f"#{red:02x}{green:02x}{blue:02x}" + ("" if opaque else f"{round(alpha * 255):02x}"),
        "rgb": f"rgb({red}, {green}, {blue})" if opaque else f"rgba({red}, {green}, {blue}, {alpha_text})",
        "oklch": f"oklch({lightness * 100:.1f}% {chroma:.3f} {hue:.1f}"
        + ("" if opaque else f" / {alpha_text}")
        + ")",
        "in_srgb_gamut": color.in_gamut,
    }


def relative_luminance(rgb: tuple) -> float:
    red, green, blue = (_decode(channel) for channel in rgb)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_ratio(foreground: str, background: str) -> float | None:
    """WCAG contrast of two CSS colors, or None when it cannot be determined.

    Translucent text is composited over the background in sRGB. A translucent
    background depends on what is behind it, so its contrast stays unknown.
    """
    front, back = parse_color(foreground), parse_color(background)
    if front is None or back is None or back.alpha < 1:
        return None
    rgb = tuple(
        front.alpha * top + (1 - front.alpha) * bottom for top, bottom in zip(front.rgb, back.rgb)
    )
    lighter, darker = sorted((relative_luminance(rgb), relative_luminance(back.rgb)), reverse=True)
    return round((lighter + 0.05) / (darker + 0.05), 2)


def color_value(target: Any, primitives: dict[str, Any]) -> str | None:
    """The CSS color of a primitive name, or None when it is unknown or unsupported."""
    value = primitives.get(target) if isinstance(target, str) else None
    return value if parse_color(value) is not None else None


def context_target(token: str, context: str, semantic: dict[str, Any]) -> Any:
    """The primitive a color token uses in a context; a primitive is used everywhere."""
    if token not in semantic:
        return token
    references = semantic[token].get("references")
    if not isinstance(references, dict) or not references:
        return None
    if context in references:
        return references[context]
    if "default" in references:
        return references["default"]
    return next(iter(references.values())) if context == "default" else None


def resolve_color(name: str, primitives: dict[str, Any], semantic: dict[str, Any]) -> str | None:
    """Return the CSS color of a primitive or a semantic token's default mapping."""
    if name in semantic:
        references = semantic[name].get("references")
        if isinstance(references, dict):
            name = references.get("default") or next(iter(references.values()), "")
    value = primitives.get(name)
    if parse_color(value) is not None:
        return value
    return None


def check_preferences(preferences: Any, approach: str, errors: list[str]) -> dict[str, dict[str, Any]]:
    """Check recorded guided answers against the question bank."""
    if preferences is None:
        if approach == "guided":
            errors.append("a guided proposal must record the user's answers in preferences")
        return {}
    if not isinstance(preferences, list):
        errors.append("preferences must be an array")
        return {}
    if approach != "guided" and preferences:
        errors.append('preferences record guided answers; set "approach": "guided"')
    if approach == "guided" and not preferences:
        errors.append("a guided proposal must record the user's answers in preferences")
    bank = {
        question["id"]: question
        for question in load_question_bank()["questions"]
        if question["stage"] != "approach"
    }
    choices: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(preferences):
        prefix = f"preferences[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix} must be an object")
            continue
        question = bank.get(item.get("question"))
        if question is None:
            errors.append(f"{prefix}.question must be a question ID from assets/token-questions.json")
            continue
        question_id = question["id"]
        if question_id in choices:
            errors.append(f"{prefix}: duplicate answer for {question_id!r}")
            continue
        allowed = [option["id"] for option in question["options"]]
        if question.get("custom") is not None:
            allowed.append(CUSTOM)
        choice = item.get("choice")
        if choice not in allowed:
            errors.append(f"{prefix}.choice must be one of {allowed}")
            continue
        detail = item.get("detail")
        if choice == CUSTOM:
            if not non_empty_string(detail):
                errors.append(f"{prefix}: a written answer needs its text in detail")
                continue
            if question_id in COLOR_QUESTIONS and COLOR_ANSWER.match(detail) and parse_color(detail) is None:
                errors.append(f"{prefix}.detail: write a color as hex, rgb(), rgba(), or oklch()")
        elif detail is not None:
            errors.append(f"{prefix}.detail is only for a written answer (choice {CUSTOM!r})")
        choices[question_id] = {"choice": choice, "detail": detail if choice == CUSTOM else None, "shaped": []}
    return choices


def check_basis(
    item: dict[str, Any],
    prefix: str,
    label: str,
    stated: bool,
    mode: str,
    errors: list[str],
    hypotheses: list[str],
    citations: list[tuple[str, str, Any]],
) -> None:
    """Observed values need evidence; design hypotheses need a rationale."""
    if "based_on" in item:
        citations.append((prefix, label, item["based_on"]))
    basis = item.get("basis", "observed")
    if basis not in BASES:
        errors.append(f"{prefix}.basis must be one of {list(BASES)}")
        return
    evidence = item.get("evidence", [])
    if not string_list(evidence):
        errors.append(f"{prefix}.evidence must be an array of strings")
        return
    if basis == "hypothesis":
        if mode != "new-system":
            errors.append(
                f"{prefix}: a design hypothesis is only allowed in new-system mode; "
                "normalizing an existing system requires observed evidence"
            )
        if not non_empty_string(item.get("rationale")):
            errors.append(f"{prefix}: a design hypothesis requires a rationale")
        if stated:
            hypotheses.append(label)
    elif stated and not evidence:
        errors.append(f"{prefix}: a stated value requires evidence; use {UNKNOWN!r} otherwise")


def validate(data: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    unknown_values: list[str] = []
    hypotheses: list[str] = []
    contrast: list[dict[str, Any]] = []

    mode = data.get("mode", "normalize")
    if mode not in MODES:
        errors.append(f"mode must be one of {list(MODES)}")
        mode = "normalize"
    approach = data.get("approach", "auto")
    if approach not in APPROACHES:
        errors.append(f"approach must be one of {list(APPROACHES)}")
        approach = "auto"
    choices = check_preferences(data.get("preferences"), approach, errors)
    citations: list[tuple[str, str, Any]] = []

    for field in ("project", "language", "title", "summary", "prepared"):
        if not non_empty_string(data.get(field)):
            errors.append(f"{field} must be a non-empty string")
    if data.get("status") != "proposed":
        errors.append('status must be "proposed"; adoption is recorded by project owners, not by this file')
    if not string_list(data.get("evidence_basis")) or not data.get("evidence_basis"):
        errors.append("evidence_basis must be a non-empty array of strings")

    breakpoints = data.get("breakpoints", [])
    breakpoint_names: set[str] = set()
    if not isinstance(breakpoints, list):
        errors.append("breakpoints must be an array")
        breakpoints = []
    for index, item in enumerate(breakpoints):
        prefix = f"breakpoints[{index}]"
        if not isinstance(item, dict) or not non_empty_string(item.get("name")):
            errors.append(f"{prefix} must be an object with a name")
            continue
        breakpoint_names.add(item["name"])
        min_width = item.get("min_width")
        if not non_empty_string(min_width):
            errors.append(f"{prefix}.min_width must be a string or {UNKNOWN!r}")
        elif min_width == UNKNOWN:
            unknown_values.append(f"{prefix}.min_width")
        elif item.get("basis", "observed") == "observed" and (
            not string_list(item.get("evidence")) or not item.get("evidence")
        ):
            errors.append(f"{prefix}: a stated min_width requires evidence")
        else:
            check_basis(
                item, prefix, f"{item['name']}.min_width", True, mode, errors, hypotheses, citations
            )

    foundations = data.get("foundations")
    if not isinstance(foundations, dict) or not foundations:
        errors.append("foundations must be a non-empty object")
        foundations = {}
    unexpected = sorted(set(foundations) - set(FOUNDATIONS))
    if unexpected:
        errors.append(f"unknown foundations: {', '.join(unexpected)}")

    primitive_values: dict[str, Any] = {}
    formats: dict[str, dict[str, Any]] = {}
    primitive_foundation: dict[str, str] = {}
    semantic_tokens: dict[str, dict[str, Any]] = {}
    counts: dict[str, dict[str, int]] = {}

    for foundation in FOUNDATIONS:
        block = foundations.get(foundation)
        if block is None:
            continue
        if not isinstance(block, dict):
            errors.append(f"foundations.{foundation} must be an object")
            continue
        primitives = block.get("primitives", [])
        semantic = block.get("semantic", [])
        if not isinstance(primitives, list) or not isinstance(semantic, list):
            errors.append(f"foundations.{foundation}.primitives and .semantic must be arrays")
            continue
        current: set[str] = set()
        for index, item in enumerate(primitives):
            prefix = f"foundations.{foundation}.primitives[{index}]"
            if not isinstance(item, dict):
                errors.append(f"{prefix} must be an object")
                continue
            name = item.get("name")
            if not isinstance(name, str) or not TOKEN_NAME.match(name):
                errors.append(f"{prefix}.name must be a lowercase token name such as space-4")
                continue
            if name in primitive_values:
                errors.append(f"duplicate primitive name: {name}")
                continue
            value = item.get("value")
            stated = False
            if foundation == "typography":
                if not isinstance(value, dict):
                    errors.append(f"{prefix}.value must be an object with {', '.join(TYPE_FIELDS)}")
                    continue
                for field in TYPE_FIELDS:
                    field_value = value.get(field)
                    if not non_empty_string(field_value):
                        errors.append(f"{prefix}.value.{field} must be a string or {UNKNOWN!r}")
                        continue
                    if field_value == UNKNOWN:
                        unknown_values.append(f"{name}.{field}")
                    else:
                        stated = True
                    problem = css_value_error(field_value)
                    if problem:
                        errors.append(f"{prefix}.value.{field} {problem}")
            else:
                if not non_empty_string(value):
                    errors.append(f"{prefix}.value must be a string or {UNKNOWN!r}")
                    continue
                if value == UNKNOWN:
                    unknown_values.append(name)
                else:
                    stated = True
                problem = css_value_error(value)
                if problem:
                    errors.append(f"{prefix}.value {problem}")
                if foundation == "color" and value != UNKNOWN:
                    color = parse_color(value)
                    if color is None:
                        warnings.append(
                            f"{name}: contrast and color formats are computed only for hex, "
                            "rgb(), rgba(), and oklch() values"
                        )
                    else:
                        formats[name] = color_formats(color)
                        if not color.in_gamut:
                            warnings.append(
                                f"{name}: the oklch() value is outside sRGB; hex, rgb(), and "
                                "contrast use the color mapped into sRGB"
                            )
            check_basis(item, prefix, name, stated, mode, errors, hypotheses, citations)
            current_values = item.get("current_values", [])
            if not string_list(current_values):
                errors.append(f"{prefix}.current_values must be an array of strings")
            else:
                current.update(current_values)
            primitive_values[name] = value
            primitive_foundation[name] = foundation
        counts[foundation] = {
            "current_values": len(current),
            "primitives": len(primitives),
            "semantic": len(semantic),
        }
        for index, item in enumerate(semantic):
            prefix = f"foundations.{foundation}.semantic[{index}]"
            if not isinstance(item, dict):
                errors.append(f"{prefix} must be an object")
                continue
            name = item.get("name")
            if not isinstance(name, str) or not TOKEN_NAME.match(name):
                errors.append(f"{prefix}.name must be a lowercase token name")
                continue
            if name in semantic_tokens or name in primitive_values:
                errors.append(f"duplicate token name: {name}")
                continue
            item = dict(item, _foundation=foundation, _prefix=prefix)
            semantic_tokens[name] = item
            if not non_empty_string(item.get("role")):
                errors.append(f"{prefix}.role must be a non-empty string")
            if item.get("status") not in SEMANTIC_STATUSES:
                errors.append(f"{prefix}.status must be one of {sorted(SEMANTIC_STATUSES)}")
            references = item.get("references")
            if not isinstance(references, dict) or not references:
                errors.append(f"{prefix}.references must map a context (default, a breakpoint, language, or theme) to a primitive")
            if foundation == "radius":
                relationship = item.get("relationship")
                if relationship not in RELATIONSHIPS:
                    errors.append(f"{prefix}.relationship must be one of {sorted(RELATIONSHIPS)}")
            if foundation == "layout":
                if not non_empty_string(item.get("owner")):
                    errors.append(f"{prefix}.owner must name the container that owns the value")
                if item.get("diagram") not in (None, *LAYOUT_DIAGRAMS):
                    errors.append(f"{prefix}.diagram must be one of {sorted(LAYOUT_DIAGRAMS)}")

    color_primitives = {
        name: value for name, value in primitive_values.items() if primitive_foundation[name] == "color"
    }
    color_semantic = {
        name: item for name, item in semantic_tokens.items() if item["_foundation"] == "color"
    }
    for name, item in semantic_tokens.items():
        prefix = item["_prefix"]
        references = item.get("references")
        if not isinstance(references, dict):
            continue
        for context, target in references.items():
            if target == UNKNOWN:
                unknown_values.append(f"{name}@{context}")
                continue
            if target not in primitive_values:
                errors.append(f"{prefix}.references.{context} points to unknown primitive {target!r}")
                continue
            if item["_foundation"] != "layout" and primitive_foundation[target] != item["_foundation"]:
                errors.append(f"{prefix}.references.{context} must point to a {item['_foundation']} primitive")
            if breakpoint_names and context not in breakpoint_names and context != "default":
                # Languages and themes are valid contexts; only flag likely breakpoint typos.
                if context in {"wide", "medium", "narrow", "desktop", "tablet", "mobile"}:
                    warnings.append(f"{prefix}.references.{context} is not a declared breakpoint")
        check = item.get("contrast")
        if check is None:
            continue
        if item["_foundation"] != "color" or not isinstance(check, dict):
            errors.append(f"{prefix}.contrast is only valid on color semantic tokens as an object")
            continue
        against = check.get("against")
        minimum = check.get("minimum")
        if not isinstance(minimum, (int, float)) or minimum <= 1:
            errors.append(f"{prefix}.contrast.minimum must be a number greater than 1")
            continue
        if not isinstance(against, str) or (against not in color_primitives and against not in color_semantic):
            errors.append(f"{prefix}.contrast.against must name a color token")
            continue
        # Check each context the token maps, such as light and dark, on its own.
        contexts = list(references) or ["default"]
        for context in contexts:
            single = len(contexts) == 1
            suffix = "" if single else f" ({context})"
            foreground = color_value(references.get(context), color_primitives)
            background = color_value(context_target(against, context, color_semantic), color_primitives)
            entry = {
                "token": name, "against": against, "context": context, "ratio": None,
                "minimum": minimum, "status": "unknown", "foreground": foreground, "background": background,
            }
            ratio = contrast_ratio(foreground, background) if foreground and background else None
            if ratio is None:
                if foreground and background:
                    warnings.append(f"{name} on {against}{suffix}: contrast against a translucent background is unknown")
                contrast.append(entry)
                unknown_values.append(f"{name} contrast" + ("" if single else f"@{context}"))
                continue
            passed = ratio >= minimum
            entry.update(ratio=ratio, status="pass" if passed else "fail")
            contrast.append(entry)
            if not passed:
                errors.append(f"{name} on {against}{suffix}: contrast {ratio}:1 is below the declared {minimum}:1")

    theme = choices.get("theme", {}).get("choice")
    if theme in THEME_CONTEXTS:
        required = set(THEME_CONTEXTS[theme])
        excluded = {"light", "dark"} - required
        for item in color_semantic.values():
            references = item.get("references")
            if not isinstance(references, dict):
                continue
            missing = sorted(required - set(references))
            if missing:
                errors.append(
                    f"{item['_prefix']}: the theme answer ({theme}) needs a {' and '.join(missing)} "
                    "mapping; use 'unknown' until a value is derived"
                )
            filled = sorted(excluded & set(references))
            if filled:
                errors.append(
                    f"{item['_prefix']}: the theme answer ({theme}) does not include "
                    f"{' or '.join(filled)}; remove that mapping instead of filling it"
                )

    for prefix, label, cited in citations:
        if not isinstance(cited, list) or not cited or not all(isinstance(entry, str) for entry in cited):
            errors.append(f"{prefix}.based_on must be a non-empty array of question IDs")
            continue
        for question_id in cited:
            answer = choices.get(question_id)
            if answer is None:
                errors.append(f"{prefix}.based_on names {question_id!r}, which has no recorded answer")
            elif answer["choice"] == DELEGATE:
                errors.append(
                    f"{prefix}.based_on cites {question_id!r}, but the user let the AI choose; "
                    "explain the value in its rationale instead"
                )
            else:
                answer["shaped"].append(label)

    naming = data.get("naming", {})
    if not isinstance(naming, dict):
        errors.append("naming must be an object")
        naming = {}
    for kind, spec in naming.items():
        prefix = f"naming.{kind}"
        if kind not in {"primitive", "semantic"} or not isinstance(spec, dict):
            errors.append(f"{prefix} must be a primitive or semantic naming object")
            continue
        parts = spec.get("parts")
        if not isinstance(parts, list) or not parts or not all(
            isinstance(part, dict) and non_empty_string(part.get("text")) and non_empty_string(part.get("label"))
            for part in parts
        ):
            errors.append(f"{prefix}.parts must be a non-empty array of {{text, label}} objects")
        if "separator" in spec and not isinstance(spec["separator"], str):
            errors.append(f"{prefix}.separator must be a string")

    for field in ("specimen_text",):
        if field in data and not non_empty_string(data[field]):
            errors.append(f"{field} must be a non-empty string when present")

    changes = data.get("changes")
    if not isinstance(changes, list):
        errors.append("changes must be an array")
        changes = []
    all_names = set(primitive_values) | set(semantic_tokens)
    for index, change in enumerate(changes):
        prefix = f"changes[{index}]"
        if not isinstance(change, dict):
            errors.append(f"{prefix} must be an object")
            continue
        if not non_empty_string(change.get("current")):
            errors.append(f"{prefix}.current must name the current value or alias")
        action = change.get("action")
        if action not in CHANGE_ACTIONS:
            errors.append(f"{prefix}.action must be one of {sorted(CHANGE_ACTIONS)}")
        proposed = change.get("proposed")
        if action == "delete":
            if proposed not in (None, ""):
                errors.append(f"{prefix}: a deletion must not name a proposed token")
        elif proposed not in all_names:
            errors.append(f"{prefix}.proposed must name a token defined in foundations")
        if not string_list(change.get("evidence")) or not change.get("evidence"):
            errors.append(f"{prefix}.evidence must be a non-empty array of strings")

    decisions = data.get("decisions")
    if not isinstance(decisions, dict):
        errors.append("decisions must be an object")
    else:
        for group in DECISION_GROUPS:
            if not string_list(decisions.get(group, [])):
                errors.append(f"decisions.{group} must be an array of strings")

    return {
        "valid": not errors,
        "mode": mode,
        "errors": errors,
        "warnings": warnings,
        "foundation_counts": counts,
        "unknown_values": sorted(set(unknown_values)),
        "hypothesis_values": sorted(set(hypotheses)),
        "contrast": contrast,
        "color_formats": formats,
        "approach": approach,
        "choices": choices,
    }


class _PageScan(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.lang = ""
        self.title = ""
        self.status = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "html":
            self.lang = attributes.get("lang") or ""
        elif tag == "body":
            self.status = attributes.get("data-proposal-status") or ""
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data


def validate_html(text: str) -> dict[str, Any]:
    errors: list[str] = []
    placeholders = sorted(set(PLACEHOLDER.findall(text)))
    if placeholders:
        errors.append(f"{len(placeholders)} unresolved placeholder(s): {', '.join(placeholders[:10])}")
    scan = _PageScan()
    scan.feed(text)
    if not re.match(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$", scan.lang):
        errors.append("<html lang> must be a valid language tag")
    if not scan.title.strip():
        errors.append("<title> must not be empty")
    if scan.status != "proposed":
        errors.append('<body data-proposal-status="proposed"> is required until owners adopt the tokens')
    if re.search(r"<(?:link|script|img|iframe)[^>]+(?:src|href)\s*=\s*[\"']?(?:https?:)?//", text, re.I):
        errors.append("the page must not load external resources")
    return {"valid": not errors, "errors": errors, "placeholders": placeholders}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate a design-token proposal JSON file and optionally its HTML page.",
    )
    parser.add_argument("input", type=Path, nargs="?", help="Path to token proposal JSON")
    parser.add_argument("--html", type=Path, help="Rendered or hand-filled proposal page to check")
    parser.add_argument("--output", type=Path, help="Optional JSON result path")
    args = parser.parse_args()
    if args.input is None and args.html is None:
        parser.error("provide a proposal JSON file, --html, or both")
    return args


def main() -> int:
    args = parse_args()
    result: dict[str, Any] = {}
    valid = True
    if args.input is not None:
        result["proposal"] = validate(read_json(args.input))
        valid = valid and result["proposal"]["valid"]
    if args.html is not None:
        try:
            text = args.html.read_text(encoding="utf-8")
        except FileNotFoundError:
            die(f"file not found: {args.html}")
        result["html"] = validate_html(text)
        hypotheses = result.get("proposal", {}).get("hypothesis_values", [])
        marked = len(re.findall(r'data-basis="hypothesis"', text))
        if hypotheses and marked < len(hypotheses):
            result["html"]["errors"].append(
                f"{len(hypotheses)} design hypothesis value(s) but only {marked} "
                'data-basis="hypothesis" marker(s) in the page'
            )
            result["html"]["valid"] = False
        valid = valid and result["html"]["valid"]
    result = {"valid": valid, **result}
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 0 if valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
