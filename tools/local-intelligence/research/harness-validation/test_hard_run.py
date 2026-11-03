"""No model calls: what a hard trial may run, keep and count."""
import json
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import hard_run
import sandbox


TASK = {'id': 'swe-x', 'kind': 'swe-bench-verified', 'request': 'Fix it.', 'image': 'swebench/x@sha256:0'}


class HiddenFiles(unittest.TestCase):
    def fixed(self, directory, *paths):
        env = Path(directory)
        for path in paths:
            (env / 'fixed' / path).parent.mkdir(parents=True, exist_ok=True)
            (env / 'fixed' / path).write_text('kept\n')
        return env

    def test_a_fixture_the_tests_read_reaches_grading(self):
        with tempfile.TemporaryDirectory() as directory:
            env = self.fixed(directory, 'pkg/test/a.test.ts', 'pkg/test/fixtures/team.json')
            task = {'tests': ['pkg/test/a.test.ts'], 'support': ['pkg/test/fixtures/team.json']}
            self.assertEqual(hard_run.hide_tests(task, env), ['pkg/test/a.test.ts'])
            self.assertEqual((env / 'hidden/pkg/test/fixtures/team.json').read_text(), 'kept\n')

    def test_a_file_the_commit_removed_is_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            env = self.fixed(directory, 'pkg/test/a.test.ts')
            task = {'tests': ['pkg/test/a.test.ts', 'pkg/test/gone.test.ts'], 'support': ['pkg/test/gone.json']}
            self.assertEqual(hard_run.hide_tests(task, env), ['pkg/test/a.test.ts'])
            self.assertFalse((env / 'hidden/pkg/test/gone.json').exists())

    def test_a_commit_that_keeps_no_test_is_an_error(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            hard_run.hide_tests({'tests': ['pkg/test/gone.test.ts'], 'support': []}, Path(directory))


class Sandbox(unittest.TestCase):
    def test_newest_command_file_wins(self):
        with tempfile.TemporaryDirectory() as directory:
            commands = Path(directory) / sandbox.COMMANDS
            commands.mkdir(parents=True)
            for name in ['001.sh', '010.sh', '002.sh']:
                (commands / name).write_text('true\n')
            self.assertEqual(sandbox.newest(directory), '010.sh')

    def test_no_command_file_runs_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(sandbox.newest(directory))

    def test_docker_has_no_network_and_a_read_only_copy(self):
        argv = sandbox.swe_argv('image', '/copy', '001.sh')
        self.assertEqual(argv[argv.index('--network') + 1], 'none')
        self.assertIn('/copy:/work:ro', argv)
        self.assertFalse(any('/home' in value or 'docker.sock' in value for value in argv))

    def test_bwrap_shares_nothing_and_mounts_no_home(self):
        argv = sandbox.corral_argv('/deps', '/node', '/copy', '001.sh')
        self.assertIn('--unshare-all', argv)
        self.assertNotIn('--share-net', argv)
        self.assertEqual(argv[argv.index('HOME') + 1], '/tmp')
        self.assertFalse(any(value.startswith('/home') for value in argv))
        self.assertLess(argv.index('/deps'), argv.index('/copy'))


class Patches(unittest.TestCase):
    def test_host_only_files_never_enter_the_input(self):
        worker = hard_run.worker_input(
            {'id': 'corral-1', 'kind': 'corral-commit', 'request': 'Fix it.', 'commit': 'c' * 40,
             'tests': ['a.test.ts']}, Path('/repo'), ['check'], {'provider': 'p', 'model': 'm', 'limits': {}})
        text = json.dumps(worker)
        self.assertNotIn('a.test.ts', text)
        self.assertNotIn('c' * 40, text)

    def test_gold_patch_stays_out_of_the_worker_input(self):
        worker = hard_run.worker_input({**TASK, 'goldPatch': 'SOLUTION', 'testPatch': 'HIDDEN'},
                                       Path('/repo'), ['check'], {'provider': 'p', 'model': 'm', 'limits': {}})
        self.assertNotIn('SOLUTION', json.dumps(worker))
        self.assertNotIn('HIDDEN', json.dumps(worker))


class Trials(unittest.TestCase):
    def test_started_trial_never_replays(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            hard_run.save(hard_run.trial_dir(root, TASK, 'gpt-6.1-sol', 'xhigh') / 'started.json', {})
            with patch.object(hard_run.subprocess, 'Popen', side_effect=AssertionError('must not run')):
                result = hard_run.trial(root, TASK, 'gpt-6.1-sol', 'xhigh', {}, [])
            self.assertEqual(result['state'], 'unsettled')
            self.assertFalse(result['passed'])

    def test_a_provider_error_is_not_a_task_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            hard_run.save(out / 'provider-error.json', {'category': 'unclassified-provider-error'})
            self.assertEqual(hard_run.settled_state(out, {'status': 'failed'}), 'invalid')

    def reached(self, directory, kind):
        out = Path(directory)
        event = {'type': 'limit.reached', 'payload': {'limitKind': kind}}
        (out / 'events.jsonl').write_text(json.dumps(event) + '\n')
        return out

    def test_a_spending_limit_says_nothing_about_the_task(self):
        for kind in ('model_calls', 'output_tokens', 'deadline'):
            with tempfile.TemporaryDirectory() as directory:
                out = self.reached(directory, kind)
                self.assertEqual(hard_run.settled_state(out, {'status': 'failed'}), 'limited')

    def test_a_response_cut_at_the_output_cap_says_nothing_about_the_task(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            (out / 'stop-reasons.jsonl').write_text('"toolUse"\n"length"\n')
            self.assertEqual(hard_run.settled_state(out, {'status': 'failed'}), 'limited')

    def test_a_cut_the_run_went_on_from_is_not_its_end(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            (out / 'stop-reasons.jsonl').write_text('"length"\n"stop"\n')
            self.assertEqual(hard_run.settled_state(out, {'status': 'failed'}), 'complete')

    def test_a_timed_out_call_says_nothing_about_the_task(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            event = {'type': 'cancel.requested', 'payload': {'reason': 'model_request_timeout'}}
            (out / 'events.jsonl').write_text(json.dumps(event) + '\n')
            self.assertEqual(hard_run.settled_state(out, {'status': 'cancelled'}), 'limited')

    def test_a_cancel_from_outside_says_nothing_about_the_task(self):
        for reason in ('interrupted by the user', 'evaluation requires a person'):
            with tempfile.TemporaryDirectory() as directory:
                out = Path(directory)
                event = {'type': 'cancel.requested', 'payload': {'reason': reason}}
                (out / 'events.jsonl').write_text(json.dumps(event) + '\n')
                self.assertEqual(hard_run.settled_state(out, {'status': 'cancelled'}), 'limited')

    def test_a_cancelled_run_with_no_reason_recorded_is_unsettled_too(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(hard_run.settled_state(Path(directory), {'status': 'cancelled'}), 'limited')

    def test_a_stuck_worker_is_the_tasks_own_end(self):
        with tempfile.TemporaryDirectory() as directory:
            out = self.reached(directory, 'no_progress')
            self.assertEqual(hard_run.settled_state(out, {'status': 'cancelled'}), 'complete')

    def test_a_run_that_ends_by_itself_is_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(hard_run.settled_state(Path(directory), {'status': 'failed'}), 'complete')

    def test_no_result_is_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(hard_run.settled_state(Path(directory), {}), 'invalid')


class Verdicts(unittest.TestCase):
    def test_a_failing_test_is_a_verdict(self):
        self.assertTrue(hard_run.has_verdict({'passed': False, 'exitCode': 1, 'tests': 8, 'failed': 2,
                                              'failedSuites': 1}))

    def test_a_worker_that_breaks_every_suite_failed(self):
        self.assertTrue(hard_run.has_verdict({'passed': False, 'exitCode': 1, 'tests': 0, 'failed': 0,
                                              'failedSuites': 2}))

    def test_a_grader_that_timed_out_has_none(self):
        for code in (124, 137):
            self.assertFalse(hard_run.has_verdict({'passed': False, 'exitCode': code, 'tests': 30,
                                                   'failed': 0, 'failedSuites': 0}))

    def test_a_grader_that_collected_nothing_has_none(self):
        self.assertFalse(hard_run.has_verdict({'passed': False, 'exitCode': 0, 'tests': 0, 'failed': 0,
                                               'failedSuites': 0}))

    def test_an_official_infrastructure_failure_has_none(self):
        self.assertFalse(hard_run.has_verdict({'passed': False, 'exitCode': 0, 'resolved': False,
                                               'infraFailure': True}))

    def test_an_official_failure_is_a_verdict(self):
        self.assertTrue(hard_run.has_verdict({'passed': False, 'exitCode': 0, 'resolved': False,
                                              'infraFailure': False}))

    def test_a_patch_that_did_not_apply_has_none(self):
        self.assertFalse(hard_run.has_verdict({'passed': False, 'reason': 'patch did not apply'}))

    def test_no_verdict_leaves_a_complete_run_invalid(self):
        grade = {'passed': False, 'exitCode': 124, 'tests': 0, 'failed': 0, 'failedSuites': 0}
        self.assertEqual(hard_run.graded_state('complete', grade), 'invalid')

    def test_a_verdict_leaves_the_state_alone(self):
        grade = {'passed': False, 'exitCode': 1, 'tests': 4, 'failed': 1, 'failedSuites': 1}
        self.assertEqual(hard_run.graded_state('complete', grade), 'complete')
        self.assertEqual(hard_run.graded_state('limited', {'passed': False, 'exitCode': 124}), 'limited')


class Receipts(unittest.TestCase):
    def stored(self, root, **hashes):
        receipt = {'state': 'complete', 'passed': True, **hashes}
        hard_run.save(hard_run.trial_dir(root, TASK, 'm', 'low') / 'receipt.json', receipt)
        return receipt

    def current(self):
        return {'taskHash': hard_run.digest(TASK), 'driverHash': hard_run.file_hash(hard_run.HERE / 'driver.ts')}

    def test_a_receipt_of_the_same_run_is_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = self.stored(Path(directory), **self.current())
            self.assertEqual(hard_run.trial(Path(directory), TASK, 'm', 'low', {}, []), receipt)

    def test_a_receipt_of_another_task_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            self.stored(Path(directory), **{**self.current(), 'taskHash': 'old'})
            with self.assertRaisesRegex(ValueError, 'set it aside'):
                hard_run.trial(Path(directory), TASK, 'm', 'low', {}, [])

    def test_a_receipt_of_another_driver_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            self.stored(Path(directory), **{**self.current(), 'driverHash': 'old'})
            with self.assertRaisesRegex(ValueError, 'set it aside'):
                hard_run.trial(Path(directory), TASK, 'm', 'low', {}, [])

    def test_a_receipt_with_no_hashes_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            self.stored(Path(directory))
            with self.assertRaisesRegex(ValueError, 'set it aside'):
                hard_run.trial(Path(directory), TASK, 'm', 'low', {}, [])

    def test_no_receipt_is_nothing_to_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            hard_run.refuse_a_stale_receipt(Path(directory), TASK, 'm', 'low')

    def test_the_report_calls_a_stale_receipt_stale(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.stored(root, **{**self.current(), 'taskHash': 'old'})
            self.assertEqual(hard_run.receipt_state(root, TASK, 'm', 'low'), 'stale')

    def test_the_report_takes_the_state_of_a_matching_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.stored(root, **self.current())
            self.assertEqual(hard_run.receipt_state(root, TASK, 'm', 'low'), 'complete')

    def test_the_report_calls_a_missing_run_unsettled(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(hard_run.receipt_state(Path(directory), TASK, 'm', 'low'), 'unsettled')


class Preflight(unittest.TestCase):
    PASSED = {'passed': True, 'exitCode': 0, 'resolved': True, 'infraFailure': False}
    FAILED = {'passed': False, 'exitCode': 0, 'resolved': False, 'infraFailure': False}
    SWE = {**TASK, 'goldPatch': 'gold\n'}

    def run_it(self, root, *grades):
        with patch.object(hard_run, 'prepare_swe'), patch.object(hard_run, 'grade_swe', side_effect=grades) as grade:
            return hard_run.preflight(root, self.SWE), grade

    def test_a_receipt_for_this_task_is_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, _ = self.run_it(root, self.PASSED, self.FAILED)
            second, grade = self.run_it(root)
            self.assertEqual(second, first)
            grade.assert_not_called()

    def test_a_receipt_for_another_task_is_redone(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            receipt = {'valid': True, 'taskHash': 'old'}
            hard_run.save(root / 'outcomes/hard/preflight' / TASK['id'] / 'receipt.json', receipt)
            result, grade = self.run_it(root, self.FAILED, self.FAILED)
            self.assertFalse(result['valid'])
            self.assertEqual(grade.call_count, 2)

    def test_a_start_with_no_verdict_proves_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            result, _ = self.run_it(Path(directory), self.PASSED, {**self.FAILED, 'infraFailure': True})
            self.assertFalse(result['valid'])

    def test_a_gold_patch_goes_to_grading_as_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            _, grade = self.run_it(Path(directory), self.PASSED, self.FAILED)
            self.assertEqual(grade.call_args_list[0].args[2], b'gold\n')
            self.assertEqual(grade.call_args_list[1].args[2], b'')


class PatchPath(unittest.TestCase):
    def git(self, repository, *args):
        return subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
                               '-c', 'core.autocrlf=false', '-C', str(repository), *args],
                              check=True, capture_output=True, text=True).stdout.strip()

    def repository(self, directory):
        repository = Path(directory) / 'repository'
        (repository / 'src').mkdir(parents=True)
        (repository / 'test/fixtures').mkdir(parents=True)
        (repository / 'src/[id].ts').write_bytes(b'one\r\ntwo\r\n')
        (repository / 'test/a.test.ts').write_text('old test\n')
        self.git(repository, 'init', '-q')
        self.git(repository, 'add', '.')
        self.git(repository, 'commit', '-qm', 'start')
        parent = self.git(repository, 'rev-parse', 'HEAD')
        (repository / 'src/[id].ts').write_bytes(b'one\r\nthree\r\n')
        (repository / 'test/a.test.ts').write_text('new test\n')
        (repository / 'test/fixtures/team.json').write_text('{}\n')
        self.git(repository, 'add', '.')
        self.git(repository, 'commit', '-qm', 'fix')
        return repository, parent, self.git(repository, 'rev-parse', 'HEAD')

    def task(self, parent, commit):
        return {'id': 'corral-x', 'kind': 'corral-commit', 'parent': parent, 'commit': commit,
                'tests': ['test/a.test.ts'], 'support': ['test/fixtures/team.json']}

    def graded(self, directory, repository, task, patch_bytes):
        env = Path(directory) / 'outcomes/hard/env' / task['id'] / 'repo'
        self.git(Path(directory), 'clone', '-q', '-c', 'core.autocrlf=false', str(repository), str(env))
        self.git(env, 'reset', '-q', '--hard', task['parent'])
        seen = {}

        def grade(root, task, tree, out):
            seen['source'] = (tree / 'src/[id].ts').read_bytes()
            seen['test'] = (tree / 'test/a.test.ts').read_text()
            seen['fixture'] = (tree / 'test/fixtures/team.json').exists()
            seen['git'] = (tree / '.git').exists()
            return {'passed': True}

        with patch.object(hard_run, 'grade_corral', side_effect=grade):
            result = hard_run.grade_patch(Path(directory), task, patch_bytes, Path(directory) / 'tree',
                                          Path(directory) / 'grade')
        return result, seen

    def test_the_reference_holds_the_source_and_not_the_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            repository, parent, commit = self.repository(directory)
            with patch.object(hard_run, 'CHECKOUT', repository):
                reference = hard_run.reference_patch(self.task(parent, commit))
            self.assertIn(b'src/[id].ts', reference)
            self.assertNotIn(b'a.test.ts', reference)
            self.assertNotIn(b'team.json', reference)

    def test_a_reference_reaches_grading_without_the_files_held_back(self):
        with tempfile.TemporaryDirectory() as directory:
            repository, parent, commit = self.repository(directory)
            task = self.task(parent, commit)
            with patch.object(hard_run, 'CHECKOUT', repository):
                reference = hard_run.reference_patch(task)
            result, seen = self.graded(directory, repository, task, reference)
            self.assertEqual(result, {'passed': True})
            self.assertEqual(seen, {'source': b'one\r\nthree\r\n', 'test': 'old test\n', 'fixture': False,
                                    'git': False})

    def test_a_patch_that_does_not_apply_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            repository, parent, commit = self.repository(directory)
            result, _ = self.graded(directory, repository, self.task(parent, commit), b'not a patch\n')
            self.assertEqual(result, {'passed': False, 'reason': 'patch did not apply'})

    def test_a_worker_patch_keeps_its_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            (out / 'patch.diff').write_bytes(b'-one\r\n+two\r\n')
            self.assertEqual(hard_run.worker_patch(out), b'-one\r\n+two\r\n')

    def test_no_patch_is_empty_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(hard_run.worker_patch(Path(directory)), b'')


class Freezing(unittest.TestCase):
    def test_a_private_task_that_matches_the_manifest_loads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            hard_run.save(root / 'outcomes/hard/tasks' / TASK['id'] / 'task.json', TASK)
            self.assertEqual(hard_run.frozen_task(root, TASK['id'], {TASK['id']: hard_run.digest(TASK)}), TASK)

    def test_a_private_task_that_differs_from_the_manifest_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            hard_run.save(root / 'outcomes/hard/tasks' / TASK['id'] / 'task.json', {**TASK, 'request': 'Other.'})
            with self.assertRaisesRegex(ValueError, 'differs from the manifest'):
                hard_run.frozen_task(root, TASK['id'], {TASK['id']: hard_run.digest(TASK)})

    def product(self, directory):
        repository = Path(directory)
        for args in (['init', '-q'], ['config', 'user.name', 't'], ['config', 'user.email', 't@example.invalid']):
            subprocess.run(['git', '-C', directory, *args], check=True)
        (repository / 'a.ts').write_text('one\n')
        subprocess.run(['git', '-C', directory, 'add', '.'], check=True)
        subprocess.run(['git', '-C', directory, 'commit', '-qm', 'start'], check=True)
        return repository

    def test_a_run_records_the_revision_it_loads(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = self.product(directory)
            head = subprocess.run(['git', '-C', directory, 'rev-parse', 'HEAD'], check=True,
                                  capture_output=True, text=True).stdout.strip()
            self.assertEqual(hard_run.product_state(repository), {'productRevision': head, 'productDirty': False})

    def test_an_edit_to_a_tracked_file_is_dirty(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = self.product(directory)
            (repository / 'a.ts').write_text('two\n')
            self.assertTrue(hard_run.product_state(repository)['productDirty'])

    def test_an_untracked_file_is_not_product_code(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = self.product(directory)
            (repository / 'notes.md').write_text('mine\n')
            self.assertFalse(hard_run.product_state(repository)['productDirty'])

    def test_a_stage_refuses_a_dirty_checkout(self):
        with self.assertRaisesRegex(ValueError, 'commit'):
            hard_run.require_committed({'productRevision': 'a', 'productDirty': True})

    def test_a_stage_starts_on_a_committed_checkout(self):
        hard_run.require_committed({'productRevision': 'a', 'productDirty': False})


class Limits(unittest.TestCase):
    def test_a_stage_run_has_no_per_call_cap(self):
        # The installation refuses a budgeted call above 4096 tokens, which xhigh alone can pass.
        self.assertNotIn('maxOutputTokensPerCall', hard_run.LIMITS)

    def test_a_stage_run_may_take_as_long_as_the_task_needs(self):
        # High levels often pass any fixed count, and such a stop would read as a failed task.
        for field in ('maxModelCalls', 'maxOutputTokens', 'runDeadlineMs'):
            self.assertNotIn(field, hard_run.LIMITS)

    def test_a_single_call_stays_within_the_installation_cap(self):
        self.assertLessEqual(hard_run.LIMITS['modelTimeoutMs'], 300000)

    def test_a_stage_run_only_has_guards_against_a_runaway(self):
        self.assertEqual(hard_run.guards(hard_run.LIMITS), {
            'physicalRequests': hard_run.REQUEST_GUARD, 'wallMs': hard_run.WALL_GUARD_MS})
        self.assertGreaterEqual(hard_run.REQUEST_GUARD, 1000)

    def test_a_smoke_keeps_its_small_bounds(self):
        self.assertEqual(hard_run.guards(hard_run.SMOKE_LIMITS), {
            'physicalRequests': 60, 'wallMs': hard_run.SMOKE_LIMITS['runDeadlineMs']})


class Freeze(unittest.TestCase):
    def test_live_refuses_a_changed_file(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'gate.py'
            source.write_text('one')
            frozen = {'hashes': {'gate.py': hard_run.file_hash(source)}}
            hard_run.verify_frozen(frozen, Path(directory))
            source.write_text('two')
            with self.assertRaisesRegex(ValueError, 'changed since the freeze'):
                hard_run.verify_frozen(frozen, Path(directory))

    def test_unknown_models_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'stage'):
            hard_run.stage_plan({'stages': {'A': ['a']}}, 'A', 'gpt-4')

    def test_stage_c_is_luna_only(self):
        with self.assertRaisesRegex(ValueError, 'stage'):
            hard_run.stage_plan({'stages': {'C': ['a']}}, 'C', 'gpt-6.1-sol')
        self.assertEqual(hard_run.stage_plan({'stages': {'C': ['a']}}, 'C', 'gpt-6-luna'), ['a'])


class DeepSeekLevels(unittest.TestCase):
    def test_stage_d_compares_the_levels_deepseek_offers(self):
        self.assertEqual(hard_run.stage_levels('D'), ('low', 'high', 'max'))

    def test_the_gpt_stages_compare_low_through_xhigh(self):
        for stage in 'ABC':
            self.assertEqual(hard_run.stage_levels(stage), ('low', 'medium', 'high', 'xhigh'))

    def test_only_stage_d_uses_the_deepseek_connection(self):
        self.assertEqual(hard_run.stage_provider('D'), hard_run.SMOKE)
        for stage in 'ABC':
            self.assertIsNone(hard_run.stage_provider(stage))

    def test_a_response_is_not_cut_at_the_endpoint_default(self):
        [model] = hard_run.SMOKE['modelProviders'][0]['models']
        self.assertEqual(model['maxOutput'], 65536)

    def row(self, task, effort, passed, state='complete'):
        return {'task': task, 'effort': effort, 'state': state, 'passed': passed,
                'wallSeconds': 10, 'totalTokens': 100}

    def test_the_report_names_what_passed_at_one_level_only(self):
        rows = [self.row('a', 'low', False), self.row('a', 'high', False), self.row('a', 'max', True),
                self.row('b', 'low', True), self.row('b', 'high', True), self.row('b', 'max', True)]
        report = hard_run.level_report(rows, ('low', 'high', 'max'))
        self.assertEqual(report['onlyAt'], {'low': [], 'high': [], 'max': ['a']})
        self.assertEqual(report['levels']['max']['passed'], 2)
        self.assertEqual(report['levels']['low']['passed'], 1)

    def test_an_unsettled_run_leaves_the_report_incomplete(self):
        rows = [self.row('a', 'low', False, 'unsettled'), self.row('a', 'high', True)]
        self.assertFalse(hard_run.level_report(rows, ('low', 'high'))['complete'])

    def test_a_limited_run_counts_as_neither_passed_nor_settled(self):
        rows = [self.row('a', 'max', True, 'limited'), self.row('a', 'high', True)]
        report = hard_run.level_report(rows, ('high', 'max'))
        self.assertFalse(report['complete'])
        self.assertEqual(report['levels']['max']['passed'], 0)

    def test_the_report_says_it_decides_nothing(self):
        report = hard_run.level_report([self.row('a', 'low', True)], ('low',))
        self.assertEqual(report['gateEvidence'], False)


class ParallelRuns(unittest.TestCase):
    def test_one_job_keeps_the_plan_order(self):
        started = []

        def run(task, effort):
            started.append((task, effort))
            return {'state': 'complete'}

        plan = [('a', 'low'), ('a', 'high'), ('b', 'max')]
        self.assertEqual(len(hard_run.run_plan(plan, run, 1)), 3)
        self.assertEqual(started, plan)

    def test_jobs_run_at_the_same_time(self):
        together = threading.Barrier(2, timeout=5)

        def run(task, effort):
            together.wait()
            return {'state': 'complete'}

        self.assertEqual(len(hard_run.run_plan([('a', 'low'), ('a', 'max')], run, 2)), 2)

    def test_an_unsettled_run_starts_no_more_and_those_under_way_finish(self):
        started = []
        second_running = threading.Event()

        def run(task, effort):
            started.append(task)
            if task == 'a':
                second_running.wait(5)
                return {'state': 'invalid'}
            second_running.set()
            time.sleep(.05)
            return {'state': 'complete'}

        results = hard_run.run_plan([(task, 'low') for task in 'abcd'], run, 2)
        self.assertEqual(sorted(started), ['a', 'b'])
        self.assertEqual(sorted(result['state'] for result in results), ['complete', 'invalid'])

    def test_a_crash_starts_no_more(self):
        started = []

        def run(task, effort):
            started.append(task)
            raise OSError('docker is gone')

        with self.assertRaisesRegex(OSError, 'docker'):
            hard_run.run_plan([(task, 'low') for task in 'abc'], run, 1)
        self.assertEqual(started, ['a'])

    def test_a_run_under_way_elsewhere_is_left_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertTrue(hard_run.left_to_run(root, TASK, 'm', 'low'))
            out = hard_run.trial_dir(root, TASK, 'm', 'low')
            hard_run.save(out / 'started.json', {})
            self.assertFalse(hard_run.left_to_run(root, TASK, 'm', 'low'))
            hard_run.save(out / 'receipt.json', {})
            self.assertTrue(hard_run.left_to_run(root, TASK, 'm', 'low'))


if __name__ == '__main__':
    unittest.main()
