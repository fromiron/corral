#!/usr/bin/env python3
"""Print the guided design-token questions as one plain-text message or as JSON.

The text form can be sent as a chat message in any agent client. The JSON form
maps each printed number and letter back to the question and option IDs that a
proposal records in its preferences. All wording comes from
assets/token-questions.json.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Import the sibling validator without leaving bytecode in installed skill folders.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate_token_proposal import (  # noqa: E402
    LANGUAGES,
    QUESTION_BANK,
    QUESTION_STAGES,
    die,
    load_question_bank,
)

# Keep UTF-8 output stable on Windows consoles with legacy code pages.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

LETTERS = "ABCDEFGH"
# Example reply letters, so the example does not suggest one fixed answer.
EXAMPLE_LETTERS = "ACBD"


def id_list(value: str) -> set[str]:
    return {item.strip() for item in value.split(",") if item.strip()}


def select(bank: dict[str, Any], stage: str, skip: set[str], only: set[str]) -> list[dict[str, Any]]:
    known = {question["id"] for question in bank["questions"]}
    unknown = sorted((skip | only) - known)
    if unknown:
        die("unknown question id(s): " + ", ".join(unknown))
    questions = [question for question in bank["questions"] if question["stage"] == stage]
    if only:
        outside = sorted(only - {question["id"] for question in questions})
        if outside:
            die(f"question id(s) not in stage {stage!r}: " + ", ".join(outside))
        questions = [question for question in questions if question["id"] in only]
    questions = [question for question in questions if question["id"] not in skip]
    if not questions:
        die("no questions left to ask")
    return questions


def build(bank: dict[str, Any], questions: list[dict[str, Any]], stage: str, language: str) -> dict[str, Any]:
    messages = {key: text[language] for key, text in bank["messages"].items()}
    items = []
    for number, question in enumerate(questions, start=1):
        custom = question.get("custom")
        items.append(
            {
                "number": number,
                "id": question["id"],
                "prompt": question["prompt"][language],
                "options": [
                    {"letter": LETTERS[index], "id": option["id"], "label": option["label"][language]}
                    for index, option in enumerate(question["options"])
                ],
                "custom": custom[language] if custom else None,
            }
        )
    if stage == "approach":
        intro, hint = messages["approach_intro"], messages["approach_hint"]
    elif stage == "core":
        example = " ".join(
            f"{item['number']}{EXAMPLE_LETTERS[(item['number'] - 1) % len(EXAMPLE_LETTERS)]}"
            if len(item["options"]) == 4
            else f"{item['number']}A"
            for item in items
        )
        intro = messages["core_intro"].replace("{count}", str(len(items)))
        hint = messages["answer_hint"].replace("{example}", example)
    else:
        intro, hint = messages["follow_up_intro"], None
    return {
        "language": language,
        "stage": stage,
        "intro": intro,
        "hint": hint,
        "custom_label": messages["custom_label"],
        "questions": items,
    }


def render_text(document: dict[str, Any]) -> str:
    lines = [document["intro"]]
    if document["hint"]:
        lines.append(document["hint"])
    lines.append("")
    for item in document["questions"]:
        lines.append(f"{item['number']}. {item['prompt']}")
        for option in item["options"]:
            lines.append(f"   {option['letter']}. {option['label']}")
        # A follow-up asks for a written answer in its prompt; no hint line is needed.
        if item["custom"] and item["options"]:
            lines.append(f"   {document['custom_label']} {item['custom']}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Print guided design-token questions in English, Korean, or Japanese. "
            "Ask the approach question first; ask the core questions only for a guided proposal."
        )
    )
    parser.add_argument("--language", choices=LANGUAGES, default="en", help="Language of the questions")
    parser.add_argument("--stage", choices=QUESTION_STAGES, default="core", help="Question stage to print")
    parser.add_argument("--skip", default="", help="Comma-separated question IDs already answered")
    parser.add_argument("--only", default="", help="Comma-separated question IDs to print from the stage")
    parser.add_argument("--format", choices=("text", "json"), default="text", help="Plain text or JSON")
    parser.add_argument("--questions", type=Path, default=QUESTION_BANK, help="Question bank JSON")
    args = parser.parse_args()

    bank = load_question_bank(args.questions)
    questions = select(bank, args.stage, id_list(args.skip), id_list(args.only))
    document = build(bank, questions, args.stage, args.language)
    if args.format == "json":
        sys.stdout.write(json.dumps(document, ensure_ascii=False, indent=2) + "\n")
    else:
        sys.stdout.write(render_text(document))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
