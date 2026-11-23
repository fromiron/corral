#!/usr/bin/env python3
"""Render a flow map as a self-contained HTML page or a Mermaid flowchart.

The page chrome comes from assets/flow-page-template.html and its wording from
assets/flow-page-strings.json. The map is drawn as state cards wired together:
every row is an action, forward moves run on the right and returns on the
left. Line style and a status word carry the evidence, never color alone.

Rendering shows the declared map and the recorded runs. It tests nothing.
"""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from html import escape
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from analyze_flow import analyze, judged_layer, load_checked  # noqa: E402
from validate_flow import add_run_arguments, die, parse_literal  # noqa: E402

ASSETS = Path(__file__).resolve().parent.parent / "assets"
LANGUAGES = ("en", "ko", "ja")

CARD_W = 360
PAD_X = 14
TEXT_X = 40
HEAD_H = 54
LINE_H = 17
CARD_GAP = 26
EDGE_GAP = 16
TRACK = 13
ARROW = 7
EVIDENCE_ORDER = ("measured", "observed", "inferred", "unknown")


class Strings:
    def __init__(self, language: str) -> None:
        bank = json.loads((ASSETS / "flow-page-strings.json").read_text(encoding="utf-8"))
        self.table = bank[language]

    def __call__(self, key: str, **values: Any) -> str:
        text = self.table[key]
        return text.format(**values) if values else text


# --- Text metrics -----------------------------------------------------------
# SVG cannot measure text without a browser, so widths are estimated per
# character class. The estimates run slightly wide so text never overflows.


def char_width(char: str) -> float:
    if unicodedata.east_asian_width(char) in ("W", "F"):
        return 1.0
    if char == " ":
        return 0.3
    if char in "ilI.,:;'|!·“”‘’()[]":
        return 0.34
    if char in "mwMW@":
        return 0.9
    if char.isupper() or char.isdigit():
        return 0.68
    return 0.56


def text_width(text: str, size: float) -> float:
    return sum(char_width(char) for char in text) * size


def truncate(text: str, size: float, width: float) -> str:
    if text_width(text, size) <= width:
        return text
    kept = ""
    for char in text:
        if text_width(kept + char + "…", size) > width:
            break
        kept += char
    return kept.rstrip() + "…"


def wrap_text(text: str, size: float, width: float, max_lines: int) -> list[str]:
    """Greedy wrap on spaces; a word wider than the line, such as unspaced Japanese, breaks per character."""
    pieces: list[tuple[str, str]] = []  # (glue before the piece, piece)
    for word in text.split(" "):
        if text_width(word, size) <= width:
            pieces.append((" ", word))
        else:
            pieces.extend((" " if index == 0 else "", char) for index, char in enumerate(word))
    lines: list[str] = []
    current = ""
    for glue, piece in pieces:
        candidate = current + glue + piece if current else piece
        if text_width(candidate, size) <= width:
            current = candidate
            continue
        lines.append(current)
        current = piece
    if current:
        lines.append(current)
    if len(lines) > max_lines:
        rest = " ".join(lines[max_lines - 1:])
        lines = lines[: max_lines - 1] + [truncate(rest, size, width)]
    return lines or [""]


# --- Shared view model ------------------------------------------------------


def transition_status(item: dict[str, Any], strings: Strings) -> dict[str, Any]:
    """Words and classes for one transition's evidence."""
    latest = item["latest_by_input"]
    broken = [name for name, result in latest.items() if result in ("blocked", "diverged")]
    if broken:
        word = "diverged" if any(latest[name] == "diverged" for name in broken) else "blocked"
        inputs = ", ".join(strings(f"input_{name}") for name in broken)
        # Broken for every recorded input: the wire itself is drawn as broken.
        # Broken for some: the wire stays, and the words say which input failed.
        partial = any(result == "reached" for result in latest.values())
        return {
            "key": "measured" if partial else "drift",
            "wire": "is-measured" if partial else "is-drift",
            "tone": "problem",
            "short": f"{strings('status_' + word)} · {inputs.upper()}",
            "long": f"{strings('result_' + word).capitalize()} · {inputs}",
        }
    state = item["evidence_state"]
    short = {"measured": "status_verified", "observed": "status_seen", "inferred": "status_inferred", "unknown": "status_unknown"}[state]
    tone = {"measured": "verified", "observed": "plain", "inferred": "plain", "unknown": "attention"}[state]
    long = strings(f"ev_{state}")
    if item["stale"]:
        long = f"{long} · {strings('stale')}"
        tone = "attention"
    return {"key": state, "wire": f"is-{state}", "tone": tone, "short": strings(short), "long": long}


def condition_words(literals: list[str], strings: Strings) -> str:
    words = []
    for literal in literals:
        fact, positive = parse_literal(literal)
        words.append(fact if positive else strings("row_not", fact=fact))
    return strings("and").join(words)


def journey_states(flow: dict[str, Any], journey: dict[str, Any]) -> set[str]:
    """States the journey can ever enter, ignoring guards."""
    outgoing: dict[str, list[str]] = {}
    for item in flow["transitions"]:
        outgoing.setdefault(item["from"], []).append(item["to"])
    seen = {journey["entry"]}
    frontier = [journey["entry"]]
    while frontier:
        for target in outgoing.get(frontier.pop(), []):
            if target not in seen:
                seen.add(target)
                frontier.append(target)
    return seen


def order_states(flow: dict[str, Any], journey: dict[str, Any], route: list[str], reachable: set[str]) -> list[str]:
    """Reading order: follow the route first, branch depth-first, end on ways out and the goal."""
    position = {transition_id: index for index, transition_id in reversed(list(enumerate(route)))}
    outgoing: dict[str, list[dict[str, Any]]] = {}
    for index, item in enumerate(flow["transitions"]):
        outgoing.setdefault(item["from"], []).append({**item, "_index": index})
    for items in outgoing.values():
        items.sort(key=lambda item: (position.get(item["id"], len(route)), item["_index"]))

    ordered: list[str] = []
    stack = [journey["entry"]]
    while stack:
        state_id = stack.pop()
        if state_id in ordered:
            continue
        ordered.append(state_id)
        for item in reversed(outgoing.get(state_id, [])):
            if item["to"] not in ordered:
                stack.append(item["to"])
    exits = journey.get("exits") or []
    ends = [state_id for state_id in exits if state_id in reachable] + [
        state_id for state_id in journey["success"] if state_id in reachable
    ]
    return [state_id for state_id in ordered if state_id not in ends] + ends


def default_route(journey_result: dict[str, Any]) -> tuple[str | None, dict[str, Any] | None]:
    """The layer and result that the default scenario is drawn from."""
    scenario = journey_result["scenarios"][0]
    as_built, intended = scenario["as_built"], scenario["intended"]
    if as_built is not None and as_built["meets_expectation"]:
        return "as-built", as_built
    if intended is not None and intended["meets_expectation"]:
        return "intended", intended
    judged = judged_layer(scenario)
    return (judged[0], judged[1]) if judged else (None, None)


# --- Map drawing ------------------------------------------------------------


def build_cards(
    flow: dict[str, Any],
    journey: dict[str, Any],
    journey_result: dict[str, Any],
    overlay: dict[str, dict[str, Any]],
    strings: Strings,
) -> tuple[list[dict[str, Any]], list[str]]:
    states = {item["id"]: item for item in flow["states"]}
    layer, result = default_route(journey_result)
    route = result["route"] if result and result["meets_expectation"] else []
    reachable = journey_states(flow, journey)
    order = order_states(flow, journey, route, reachable)
    stuck = set(result["dead_ends"]) if result else set()
    for failure in (result["failure_states"] if result else []):
        if failure["recovery"] == "trapped":
            stuck.add(failure["state"])

    steps: dict[str, list[int]] = {}
    for number, transition_id in enumerate(route, start=1):
        steps.setdefault(transition_id, []).append(number)

    cards: list[dict[str, Any]] = []
    y = 8.0
    for state_id in order:
        state = states[state_id]
        label_lines = wrap_text(state["label"], 15, CARD_W - 2 * PAD_X, 2)
        head_h = HEAD_H + 19 * (len(label_lines) - 1)
        roles = []
        if state_id == journey["entry"]:
            roles.append(strings("role_start"))
        if state_id in journey["success"]:
            roles.append(strings("role_goal"))
        if state_id in (journey.get("exits") or []):
            roles.append(strings("role_exit"))
        if state.get("role") == "failure":
            roles.append(strings("role_failure"))
        if state_id in stuck:
            roles.append(strings("role_stuck"))
        style = (
            "card-stuck"
            if state_id in stuck
            else "card-failure"
            if state.get("role") == "failure"
            else "card-goal"
            if state_id in journey["success"]
            else ""
        )

        rows = []
        row_y = y + head_h
        for item in flow["transitions"]:
            if item["from"] != state_id:
                continue
            status = transition_status(overlay[item["id"]], strings)
            action_lines = wrap_text(item["action"], 13, CARD_W - TEXT_X - PAD_X, 2)
            parts = [strings("row_stays") if item["to"] == state_id else f"→ {states[item['to']]['label']}"]
            if item["intent"] == "none":
                parts.append(strings("row_unplanned"))
            elif item["intent"] == "proposed":
                parts.append(strings("row_proposed"))
            if item["actor"] == "system":
                parts.append(strings("row_system"))
            if item.get("visibility") in ("disclosed", "contextual"):
                parts.append(strings(f"row_{item['visibility']}"))
            status_width = text_width(status["short"], 10.5) + 6
            meta = truncate(" · ".join(parts), 11.5, CARD_W - TEXT_X - PAD_X - status_width - 10)
            condition = ""
            if item.get("requires"):
                condition = truncate(
                    strings("row_if", conditions=condition_words(item["requires"], strings)),
                    11.5,
                    CARD_W - TEXT_X - PAD_X,
                )
            height = 10 + LINE_H * len(action_lines) + LINE_H + (15 if condition else 0) + 8
            rows.append(
                {
                    "id": item["id"],
                    "to": item["to"],
                    "y": row_y,
                    "h": height,
                    "lines": action_lines,
                    "meta": meta,
                    "condition": condition,
                    "status": status,
                    "steps": steps.get(item["id"], []),
                }
            )
            row_y += height
        cards.append(
            {
                "id": state_id,
                "y": y,
                "h": row_y - y,
                "head_h": head_h,
                "kind": strings(f"kind_{state['kind']}"),
                "roles": roles,
                "label": label_lines,
                "style": style,
                "rows": rows,
            }
        )
        y = row_y + CARD_GAP
    return cards, route


def route_wires(cards: list[dict[str, Any]]) -> dict[str, Any]:
    """Give every wire a side, an entry slot on its target, and a track."""
    index = {card["id"]: position for position, card in enumerate(cards)}
    by_id = {card["id"]: card for card in cards}
    wires = []
    for card in cards:
        for row in card["rows"]:
            if row["to"] == card["id"] or row["to"] not in by_id:
                continue
            target = by_id[row["to"]]
            wires.append(
                {
                    "row": row,
                    "side": "right" if index[row["to"]] > index[card["id"]] else "left",
                    "sy": row["y"] + 19,
                    "target": target,
                    "ty": target["y"] + target["head_h"] / 2,
                }
            )

    # Entry slots: nearer sources take the slot closest to them, so wires never cross on arrival.
    for card in cards:
        for side in ("right", "left"):
            arriving = sorted(
                (wire for wire in wires if wire["target"] is card and wire["side"] == side),
                key=lambda wire: abs(wire["ty"] - wire["sy"]),
            )
            slots = max(1, int((card["head_h"] - 22) // 8) + 1)
            for position, wire in enumerate(arriving):
                slot = min(position, slots - 1)
                offset = 12 + slot * 8
                wire["ty"] = card["y"] + offset if side == "right" else card["y"] + card["head_h"] - offset

    tracks = {"right": 0, "left": 0}
    for side in ("right", "left"):
        placed: list[list[tuple[float, float]]] = []
        for wire in sorted((item for item in wires if item["side"] == side), key=lambda item: abs(item["ty"] - item["sy"])):
            low, high = sorted((wire["sy"], wire["ty"]))
            for track, spans in enumerate(placed):
                if all(high + 6 < start or low - 6 > end for start, end in spans):
                    spans.append((low, high))
                    wire["track"] = track
                    break
            else:
                placed.append([(low, high)])
                wire["track"] = len(placed) - 1
        tracks[side] = len(placed)
    return {"wires": wires, "tracks": tracks}


def draw_map(
    cards: list[dict[str, Any]], routed: dict[str, Any], route: list[str], label: str, prefix: str
) -> str:
    wires, tracks = routed["wires"], routed["tracks"]
    extent = {side: (EDGE_GAP + (count - 1) * TRACK + 12 if count else 8) for side, count in tracks.items()}
    left = extent["left"]
    width = left + CARD_W + extent["right"]
    height = cards[-1]["y"] + cards[-1]["h"] + 8
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" height="{height:.0f}" '
        f'viewBox="0 0 {width:.0f} {height:.0f}" role="img" aria-label="{escape(label, quote=True)}">'
    ]

    for wire in sorted(wires, key=lambda item: -abs(item["ty"] - item["sy"])):
        outward = 1 if wire["side"] == "right" else -1
        edge = left + CARD_W if outward == 1 else left
        track_x = edge + outward * (EDGE_GAP + wire["track"] * TRACK)
        sy, ty = wire["sy"], wire["ty"]
        direction = 1 if ty > sy else -1
        radius = min(7.0, abs(ty - sy) / 2)
        status = wire["row"]["status"]
        drift = status["key"] == "drift"
        end = edge + outward * (ARROW if not drift else 15)
        path = (
            f"M{edge:.1f} {sy:.1f} H{track_x - outward * radius:.1f} "
            f"Q{track_x:.1f} {sy:.1f} {track_x:.1f} {sy + direction * radius:.1f} "
            f"V{ty - direction * radius:.1f} "
            f"Q{track_x:.1f} {ty:.1f} {track_x - outward * radius:.1f} {ty:.1f} H{end:.1f}"
        )
        classes = [status["wire"]]
        if wire["row"]["id"] in route and not drift:
            classes.append("is-route")
        joined = " ".join(classes)
        out.append(f'<path class="wire-halo" d="{path}"/>')
        out.append(f'<path class="wire {joined}" d="{path}"/>')
        if drift:
            center = edge + outward * 8
            out.append(
                f'<path class="stop" d="M{center - 3.5:.1f} {ty - 3.5:.1f} L{center + 3.5:.1f} {ty + 3.5:.1f} '
                f'M{center - 3.5:.1f} {ty + 3.5:.1f} L{center + 3.5:.1f} {ty - 3.5:.1f}"/>'
            )
        else:
            base = edge + outward * ARROW
            out.append(
                f'<path class="head {joined}" d="M{edge:.1f} {ty:.1f} L{base:.1f} {ty - 3.6:.1f} L{base:.1f} {ty + 3.6:.1f} Z"/>'
            )

    for number, card in enumerate(cards):
        x, y = left, card["y"]
        group = f' class="{card["style"]}"' if card["style"] else ""
        out.append(f"<g{group}>")
        clip = f"{prefix}-clip-{number}"
        out.append(
            f'<clipPath id="{clip}"><rect x="{x}" y="{y:.1f}" width="{CARD_W}" height="{card["h"]:.1f}" rx="6"/></clipPath>'
        )
        if card["rows"]:
            out.append(
                f'<rect class="card-head" x="{x}" y="{y:.1f}" width="{CARD_W}" height="{card["head_h"]:.1f}" clip-path="url(#{clip})"/>'
            )
        caption = escape(card["kind"])
        out.append(f'<text class="card-kind" x="{x + PAD_X}" y="{y + 21:.1f}">{caption}</text>')
        if card["roles"]:
            out.append(
                f'<text class="card-role" x="{x + CARD_W - PAD_X}" y="{y + 21:.1f}" text-anchor="end">'
                f'{escape(" · ".join(card["roles"]))}</text>'
            )
        for number, line in enumerate(card["label"]):
            out.append(f'<text class="card-label" x="{x + PAD_X}" y="{y + 41 + 19 * number:.1f}">{escape(line)}</text>')
        for row in card["rows"]:
            out.append(f'<line class="card-rule" x1="{x}" y1="{row["y"]:.1f}" x2="{x + CARD_W}" y2="{row["y"]:.1f}"/>')
            center_x, center_y = x + PAD_X + 9, row["y"] + 19
            if row["steps"]:
                step = ",".join(str(number) for number in row["steps"])
                out.append(f'<circle class="row-step" cx="{center_x}" cy="{center_y:.1f}" r="9"/>')
                out.append(f'<text class="row-step-num" x="{center_x}" y="{center_y + 3.7:.1f}">{step}</text>')
            else:
                out.append(f'<circle class="row-dot" cx="{center_x}" cy="{center_y:.1f}" r="2.5"/>')
            for number, line in enumerate(row["lines"]):
                out.append(
                    f'<text class="row-action" x="{x + TEXT_X}" y="{row["y"] + 23 + LINE_H * number:.1f}">{escape(line)}</text>'
                )
            meta_y = row["y"] + 23 + LINE_H * len(row["lines"])
            out.append(f'<text class="row-meta" x="{x + TEXT_X}" y="{meta_y:.1f}">{escape(row["meta"])}</text>')
            if row["condition"]:
                out.append(
                    f'<text class="row-meta" x="{x + TEXT_X}" y="{meta_y + 15:.1f}">{escape(row["condition"])}</text>'
                )
            tone = {"verified": " is-verified", "attention": " is-attention", "problem": " is-problem"}.get(
                row["status"]["tone"], ""
            )
            out.append(
                f'<text class="row-status{tone}" x="{x + CARD_W - PAD_X}" y="{meta_y:.1f}">{escape(row["status"]["short"])}</text>'
            )
        out.append(f'<rect class="card-box" x="{x}" y="{y:.1f}" width="{CARD_W}" height="{card["h"]:.1f}" rx="6" style="fill:none"/>')
        out.append("</g>")
    out.append("</svg>")
    return "".join(out)


def legend(strings: Strings) -> str:
    samples = (
        ("is-measured", "legend_measured"),
        ("is-observed", "legend_observed"),
        ("is-inferred", "legend_inferred"),
        ("is-unknown", "legend_unknown"),
        ("is-measured is-route", "legend_route"),
        ("is-drift", "legend_drift"),
    )
    items = []
    for classes, key in samples:
        mark = (
            '<path class="stop" d="M30 2 L37 9 M30 9 L37 2"/>'
            if classes == "is-drift"
            else f'<path class="head {classes}" d="M38 5.5 L31 1.9 L31 9.1 Z"/>'
        )
        items.append(
            f'<li><svg width="40" height="11" viewBox="0 0 40 11" aria-hidden="true">'
            f'<path class="wire {classes}" d="M1 5.5 H{26 if classes == "is-drift" else 31}"/>{mark}</svg>{escape(strings(key))}</li>'
        )
    return f'<ul class="legend">{"".join(items)}</ul>'


# --- Page -------------------------------------------------------------------


def tag(text: str, tone: str = "") -> str:
    tone_class = f" tag-{tone}" if tone in ("verified", "attention", "problem", "accent") else ""
    return f'<span class="tag{tone_class}">{escape(text)}</span>'


def ident(text: str) -> str:
    return f'<span class="id">{escape(text)}</span>'


def layer_cell(result: dict[str, Any] | None, expect: str, empty_key: str, strings: Strings) -> str:
    if result is None:
        return f'<span class="small">{escape(strings(empty_key))}</span>'
    if expect == "success":
        return tag(strings("reach_yes")) if result["meets_expectation"] else tag(strings("reach_no"), "problem")
    return tag(strings("exit_yes")) if result["meets_expectation"] else tag(strings("exit_no"), "problem")


def scenario_table(journey_result: dict[str, Any], states: dict[str, Any], strings: Strings) -> str:
    rows = []
    for scenario in journey_result["scenarios"]:
        if scenario["id"] == "default":
            name = f'<span>{escape(strings("scenario_default"))}</span>'
        else:
            name = f'<span>{escape(scenario["description"])}</span>{ident(scenario["id"])}'
        judged = judged_layer(scenario)
        effort = "—"
        recovery = "—"
        if judged is not None:
            layer, result = judged
            source = result
            if not result["meets_expectation"] and scenario["intended"] and scenario["intended"]["meets_expectation"]:
                layer, source = "intended", scenario["intended"]
            if source["meets_expectation"]:
                effort = (
                    escape(strings("effort", actions=source["user_actions"], inputs=source["inputs"], screens=source["screens"]))
                    + f'<span class="small">{escape(strings("effort_basis", layer=strings("layer_" + layer)))}</span>'
                )
            failures = result["failure_states"]
            if failures:
                recovery = '<div class="cell-stack">' + "".join(
                    f'<span>{escape(states[item["state"]]["label"])} '
                    + tag(strings("recovery_" + item["recovery"]), "" if item["recovery"] == "recoverable" else "problem")
                    + "</span>"
                    for item in failures
                ) + "</div>"
            else:
                recovery = f'<span class="small">{escape(strings("recovery_none"))}</span>'
        rows.append(
            f'<tr><th scope="row"><div class="cell-stack">{name}</div></th>'
            f'<td>{layer_cell(scenario["intended"], scenario["expect"], "layer_none_design", strings)}</td>'
            f'<td>{layer_cell(scenario["as_built"], scenario["expect"], "layer_none_product", strings)}</td>'
            f'<td class="num">{effort}</td><td>{recovery}</td></tr>'
        )
    head = "".join(
        f'<th scope="col">{escape(strings(key))}</th>'
        for key in ("col_scenario", "col_design", "col_product", "col_effort", "col_recovery")
    )
    return (
        f'<p>{escape(strings("scenarios_caption"))}</p>'
        f'<div class="scroll scenario-table"><table>'
        f'<thead><tr>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table></div>'
    )


def route_list(
    flow: dict[str, Any], journey_result: dict[str, Any], overlay: dict[str, dict[str, Any]], strings: Strings
) -> str:
    states = {item["id"]: item for item in flow["states"]}
    transitions = {item["id"]: item for item in flow["transitions"]}
    layer, result = default_route(journey_result)
    if result is None or not result["meets_expectation"]:
        return f'<p>{escape(strings("route_none"))}</p>'
    items = []
    for transition_id in result["route"]:
        item = transitions[transition_id]
        status = transition_status(overlay[transition_id], strings)
        detail = [strings("route_to", state=states[item["to"]]["label"])]
        if item["actor"] == "system":
            detail.append(strings("row_system"))
        if item.get("visibility") in ("disclosed", "contextual"):
            detail.append(strings(f"row_{item['visibility']}"))
        if item["intent"] == "none":
            detail.append(strings("row_unplanned"))
        items.append(
            f'<li><span>{escape(item["action"])}</span><span class="small">{escape(" · ".join(detail))}</span>'
            f'{tag(status["long"], status["tone"])}</li>'
        )
    return f'<p>{escape(strings("route_caption_" + layer))}</p><ol class="route">{"".join(items)}</ol>'


def signal_section(flow: dict[str, Any], analysis: dict[str, Any], strings: Strings) -> str:
    states = {item["id"]: item["label"] for item in flow["states"]}
    actions = {item["id"]: item["action"] for item in flow["transitions"]}
    journeys = {item["id"]: item["goal"] for item in flow["journeys"]}
    items = []
    for signal in analysis["signals"]:
        kind = signal["signal"]
        if kind == "goal-unreachable":
            text = strings("sig_goal-unreachable_built" if signal.get("designed") else "sig_goal-unreachable_text")
        elif kind == "failure-without-recovery":
            text = strings(f"sig_failure-without-recovery_{signal['recovery']}")
        elif kind == "run-drift":
            broken = ", ".join(strings(f"input_{name}") for name in signal["broken"])
            working = ", ".join(strings(f"input_{name}") for name in signal["working"])
            text = (
                strings("sig_run-drift_partial", working=working, broken=broken)
                if working
                else strings("sig_run-drift_text", broken=broken)
            )
        elif kind == "guard-not-enforced":
            text = strings("sig_guard-not-enforced_text", run=signal["run"], unmet=", ".join(signal["unmet"]))
        elif kind == "unmapped-step":
            text = strings("sig_unmapped-step_text", run=signal["run"], action=signal["action"])
        elif kind == "stale-evidence":
            text = strings("sig_stale-evidence_text", revision=signal["revision"])
        else:
            text = strings(f"sig_{kind}_text")
        where = ""
        if "journey" in signal:
            scenario = strings("scenario_default") if signal["scenario"] == "default" else signal["scenario"]
            where = (
                f'<span class="small">{escape(journeys[signal["journey"]])} · {escape(scenario)} · '
                f'{escape(strings("layer_" + signal["layer"]))}</span>'
            )
        subjects = "".join(
            f"<li>{escape(states[subject])}</li>"
            if subject in states
            else f"<li>{escape(actions.get(subject, subject))} {ident(subject)}</li>"
            for subject in signal["subjects"]
        )
        handoff = (
            f'<div class="chips">{tag(strings("handoff", skill=signal["route_to"]), "accent")}</div>'
            if signal["route_to"]
            else ""
        )
        problem = kind in ("goal-unreachable", "exit-missing", "dead-end", "failure-without-recovery", "run-drift", "guard-not-enforced")
        items.append(
            f'<li class="signal"><div class="signal-title">{tag(strings("sig_" + kind), "problem" if problem else "attention")}{where}</div>'
            f'<div class="signal-body"><p>{escape(text)}</p><ul class="subjects">{subjects}</ul>{handoff}</div></li>'
        )
    body = f'<ul class="signals">{"".join(items)}</ul>' if items else f'<p class="well">{escape(strings("attention_none"))}</p>'
    return (
        f'<section class="section" id="attention" aria-labelledby="attention-title"><div class="section-head">'
        f'<h2 id="attention-title">{escape(strings("attention_title"))}</h2>'
        f'<p class="lede">{escape(strings("attention_lede"))}</p></div>{body}</section>'
    )


def transitions_table(flow: dict[str, Any], overlay: dict[str, dict[str, Any]], strings: Strings) -> str:
    states = {item["id"]: item["label"] for item in flow["states"]}
    rows = []
    for item in flow["transitions"]:
        info = overlay[item["id"]]
        status = transition_status(info, strings)
        notes = [strings("row_system")] if item["actor"] == "system" else []
        if item.get("visibility") in ("disclosed", "contextual"):
            notes.append(strings(f"row_{item['visibility']}"))
        note = f'<span class="small">{escape(" · ".join(notes))}</span>' if notes else ""
        conditions = []
        if item.get("requires"):
            conditions.append(f'{escape(strings("needs"))} {escape(condition_words(item["requires"], strings))}')
        if item.get("effects"):
            conditions.append(f'{escape(strings("sets"))} {escape(condition_words(item["effects"], strings))}')
        design = tag(strings("intent_" + item["intent"]), "attention" if item["intent"] != "approved" else "")
        if info["parity"] != "not-evaluated":
            tone = {"aligned": "verified", "drift": "problem"}.get(info["parity"], "")
            design += tag(strings("parity_" + info["parity"]), tone)
        evidence = [tag(status["long"], status["tone"])]
        reference = item["evidence"].get("ref") or item["evidence"].get("note")
        if reference:
            evidence.append(f'<span class="small">{escape(reference)}</span>')
        for name, result in info["latest_by_input"].items():
            evidence.append(
                f'<span class="small">{escape(strings("input_" + name))}: {escape(strings("result_" + result))}</span>'
            )
        rows.append(
            f'<tr><th scope="row"><div class="cell-stack"><span>{escape(item["action"])}</span>{ident(item["id"])}{note}</div></th>'
            f'<td>{escape(states[item["from"]])} → {escape(states[item["to"]])}</td>'
            f'<td>{"<br>".join(conditions) or "—"}</td>'
            f'<td><div class="cell-stack">{design}</div></td>'
            f'<td><div class="cell-stack">{"".join(evidence)}</div></td></tr>'
        )
    head = "".join(
        f'<th scope="col">{escape(strings(key))}</th>'
        for key in ("col_action", "col_from_to", "col_conditions", "col_design", "col_evidence")
    )
    return (
        f'<section class="section" id="transitions" aria-labelledby="transitions-title"><div class="section-head">'
        f'<h2 id="transitions-title">{escape(strings("transitions_title"))}</h2>'
        f'<p class="lede">{escape(strings("transitions_lede"))}</p></div>'
        f'<div class="scroll wide-table"><table><thead><tr>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table></div></section>'
    )


def runs_table(flow: dict[str, Any], analysis: dict[str, Any], strings: Strings) -> str:
    goals = {item["id"]: item["goal"] for item in flow["journeys"]}
    rows = []
    for journey in analysis["journeys"]:
        for run in journey["runs"]:
            scenario = strings("scenario_default") if run["scenario"] == "default" else run["scenario"]
            outcome = tag(strings("outcome_" + run["outcome"]), "verified" if run["outcome"] == "success" else "problem")
            baseline = tag(strings("baseline"), "accent") if run["baseline"] else ""
            stale = f'<span class="small">{escape(strings("stale"))}</span>' if run["stale"] else ""
            rows.append(
                f'<tr><th scope="row"><div class="cell-stack">{ident(run["run"])}{baseline}</div></th>'
                f'<td>{escape(goals[journey["id"]])}<span class="small">{escape(scenario)}</span></td>'
                f'<td>{outcome}</td>'
                f'<td>{escape(strings("input_" + run["input"]))}<span class="small">{escape(run["viewport"])}</span></td>'
                f'<td>{ident(run["revision"])}{stale}</td><td class="num">{escape(run["recorded_at"])}</td></tr>'
            )
    if rows:
        head = "".join(
            f'<th scope="col">{escape(strings(key))}</th>'
            for key in ("col_run", "col_journey", "col_outcome", "col_conditions_run", "col_revision", "col_recorded")
        )
        body = f'<div class="scroll wide-table"><table><thead><tr>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table></div>'
    else:
        body = f'<p class="well">{escape(strings("runs_none"))}</p>'
    return (
        f'<section class="section" id="runs" aria-labelledby="runs-title"><div class="section-head">'
        f'<h2 id="runs-title">{escape(strings("runs_title"))}</h2>'
        f'<p class="lede">{escape(strings("runs_lede"))}</p></div>{body}</section>'
    )


def render_page(flow: dict[str, Any], analysis: dict[str, Any], language: str, source: str) -> str:
    strings = Strings(language)
    states = {item["id"]: item for item in flow["states"]}
    overlay = {item["id"]: item for item in analysis["transitions"]}
    journeys = {item["id"]: item for item in flow["journeys"]}
    evidence = analysis["evidence"]
    total = sum(evidence.values())

    if analysis["counts"]["runs"]:
        status = tag(strings("status_runs", n=analysis["counts"]["runs"]), "verified")
    elif evidence["observed"] or evidence["inferred"]:
        status = tag(strings("status_static"))
    else:
        status = tag(strings("status_design_only"), "attention")

    segments = "".join(
        f'<span class="seg-{name}" style="flex-grow:{evidence[name]}"></span>' for name in EVIDENCE_ORDER if evidence[name]
    )
    key = "".join(
        f'<li><span class="swatch seg-{name}"></span><span><strong>{evidence[name]}</strong> {escape(strings("ev_" + name))}</span>'
        f'<span class="small">{escape(strings("ev_" + name + "_note"))}</span></li>'
        for name in EVIDENCE_ORDER
    )
    meta = "".join(
        f"<div><dt>{escape(strings(label))}</dt><dd>{escape(value)}</dd></div>"
        for label, value in (
            ("meta_product", flow["product"]),
            ("meta_journeys", str(len(analysis["journeys"]))),
            ("meta_verified", strings("meta_verified_value", n=evidence["measured"], total=total)),
            ("meta_revision", analysis["revision"] or strings("meta_revision_none")),
        )
    )
    scope = f'<p class="lede">{escape(flow["scope"])}</p>' if flow.get("scope") else ""
    intro = (
        f'<header class="intro" id="overview"><p class="eyebrow">{escape(strings("eyebrow"))}</p>'
        f'<h1>{escape(flow["title"])}</h1>{scope}<div class="intro-status">{status}</div>'
        f'<dl class="meta">{meta}</dl>'
        f'<div class="evidence" role="group" aria-label="{escape(strings("evidence_title"), quote=True)}">'
        f'<div class="evidence-bar" aria-hidden="true">{segments}</div><ul class="evidence-key">{key}</ul></div>'
        f'<div class="well"><strong>{escape(strings("boundary_title"))}</strong>'
        f'<p>{escape(strings("boundary_text"))}</p></div></header>'
    )

    sections = [intro, signal_section(flow, analysis, strings)]
    nav = [("overview", strings("nav_overview")), ("attention", strings("nav_attention"))]
    for journey_result in analysis["journeys"]:
        journey = journeys[journey_result["id"]]
        anchor = f"journey-{journey['id']}"
        nav.append((anchor, journey["goal"]))
        cards, route = build_cards(flow, journey, journey_result, overlay, strings)
        actions = sum(len(card["rows"]) for card in cards)
        drawing = draw_map(
            cards, route_wires(cards), route, strings("map_label", states=len(cards), actions=actions), anchor
        )
        critical = tag(strings("critical"), "accent") if journey["critical"] else ""
        facts = "".join(
            f"<div><dt>{escape(strings(label))}</dt><dd>{escape(value)}</dd></div>"
            for label, value in (
                ("journey_user", journey["user"]),
                ("journey_success", journey["success_condition"]),
                ("journey_entry", states[journey["entry"]]["label"]),
            )
        )
        sections.append(
            f'<section class="section" id="{anchor}" aria-labelledby="{anchor}-title"><div class="section-head">'
            f'<h2 id="{anchor}-title">{escape(journey["goal"])}</h2>'
            f'<div class="chips">{ident(journey["id"])}{critical}</div></div>'
            f'<dl class="journey-facts">{facts}</dl>'
            f'<div class="sub"><h3>{escape(strings("scenarios_title"))}</h3>{scenario_table(journey_result, states, strings)}</div>'
            f'<div class="sub"><h3>{escape(strings("map_title"))}</h3><p>{escape(strings("map_caption"))}</p>'
            f'<figure class="map"><div class="map-scroll">{drawing}</div>{legend(strings)}</figure></div>'
            f'<div class="sub"><h3>{escape(strings("route_title"))}</h3>{route_list(flow, journey_result, overlay, strings)}</div>'
            f"</section>"
        )
    sections.append(transitions_table(flow, overlay, strings))
    sections.append(runs_table(flow, analysis, strings))
    unknowns = flow["unknowns"]
    open_body = (
        '<ul class="plain-list">' + "".join(f"<li>{escape(item)}</li>" for item in unknowns) + "</ul>"
        if unknowns
        else f'<p class="well">{escape(strings("open_none"))}</p>'
    )
    sections.append(
        f'<section class="section" id="open" aria-labelledby="open-title"><div class="section-head">'
        f'<h2 id="open-title">{escape(strings("open_title"))}</h2><p class="lede">{escape(strings("open_lede"))}</p></div>'
        f'{open_body}<p class="small doc-footer">{escape(strings("footer", file=source))}</p></section>'
    )
    nav += [("transitions", strings("nav_transitions")), ("runs", strings("nav_runs")), ("open", strings("nav_open"))]

    template = (ASSETS / "flow-page-template.html").read_text(encoding="utf-8")
    slots = {
        "LANG": language,
        "TITLE": escape(f"{flow['title']} · {strings('kind')}"),
        "SKIP": escape(strings("skip")),
        "PRODUCT": escape(flow["product"]),
        "KIND": escape(strings("kind")),
        "NAV_LABEL": escape(strings("nav_label")),
        "NAV": "<ul>" + "".join(f'<li><a href="#{anchor}">{escape(text)}</a></li>' for anchor, text in nav) + "</ul>",
        "CONTENT": "\n".join(sections),
    }
    for name, value in slots.items():
        template = template.replace("{{" + name + "}}", value)
    return template


# --- Mermaid ----------------------------------------------------------------


def render_mermaid(flow: dict[str, Any], analysis: dict[str, Any], language: str) -> str:
    """A flowchart for places that render Mermaid, such as a pull request description."""
    strings = Strings(language)
    overlay = {item["id"]: item for item in analysis["transitions"]}
    shapes = {"screen": ('["', '"]'), "overlay": ('[["', '"]]'), "inline": ('("', '")'), "external": ('[/"', '"/]')}

    def quote(text: str) -> str:
        return text.replace('"', "#quot;")

    goals = {state_id for journey in flow["journeys"] for state_id in journey["success"]}
    entries = {journey["entry"] for journey in flow["journeys"]}
    lines = ["flowchart TD"]
    for state in flow["states"]:
        opening, closing = shapes[state["kind"]]
        roles = [
            strings(key).lower()
            for key, applies in (
                ("role_start", state["id"] in entries),
                ("role_goal", state["id"] in goals),
                ("role_failure", state.get("role") == "failure"),
            )
            if applies
        ]
        label = state["label"] + (f" ({', '.join(roles)})" if roles else "")
        lines.append(f'  {state["id"].replace("-", "_")}{opening}{quote(label)}{closing}')
    arrows = {"measured": "==>", "observed": "-->", "inferred": "-.->", "unknown": "-.->", "drift": "--x"}
    for item in flow["transitions"]:
        status = transition_status(overlay[item["id"]], strings)
        label = quote(f"{truncate(item['action'], 10, 300)} [{status['long']}]")
        lines.append(
            f'  {item["from"].replace("-", "_")} {arrows[status["key"]]}|"{label}"| {item["to"].replace("-", "_")}'
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Render a flow map as a self-contained HTML page or a Mermaid flowchart."
    )
    parser.add_argument("map", type=Path, help="Path to the flow map (*.flow.json).")
    add_run_arguments(parser)
    parser.add_argument("--format", choices=("html", "mermaid"), default="html", help="Output format. Defaults to html.")
    parser.add_argument("--language", choices=LANGUAGES, default="en", help="Language of the page chrome. Defaults to en.")
    parser.add_argument("--journey", help="Render only this journey id.")
    parser.add_argument("--revision", help="Product revision being reviewed; other evidence is marked as stale.")
    parser.add_argument("--output", type=Path, help="Write to this file instead of standard output.")
    args = parser.parse_args()

    flow, runs = load_checked(args.map, args.runs_dir, args.no_runs, args.run)
    if args.journey is not None and args.journey not in {item["id"] for item in flow["journeys"]}:
        die(f"journey {args.journey!r} is not in the map")
    try:
        analysis = analyze(flow, runs, args.revision, args.journey)
    except ValueError as exc:
        die(str(exc))
    if args.format == "mermaid":
        rendered = render_mermaid(flow, analysis, args.language)
    else:
        rendered = render_page(flow, analysis, args.language, args.map.name)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
