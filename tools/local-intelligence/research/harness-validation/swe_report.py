#!/usr/bin/env python3
"""The official SWE-bench verdict of one evaluation log. Runs under swebench-requirements.txt."""
import json
import sys

from swebench.harness.grading import get_eval_report
from swebench.types import TestSpec


def main():
    task = json.load(open(sys.argv[1]))
    instance = task['instanceId']
    spec = TestSpec(instance_id=instance, image=task['image'], eval_script_list=[task['evalScript']],
                    repo=task['repository'], version=task['version'],
                    FAIL_TO_PASS=task['failToPass'], PASS_TO_PASS=task['passToPass'],
                    log_parser=task['logParser'], eval_type=task['evalType'])
    prediction = {'instance_id': instance, 'model_name_or_path': 'corral', 'model_patch': 'graded'}
    report = get_eval_report(spec, prediction, sys.argv[2], False)[instance]
    print(json.dumps({'resolved': report['resolved'], 'infraFailure': report['infra_failure']}))


if __name__ == '__main__':
    main()
