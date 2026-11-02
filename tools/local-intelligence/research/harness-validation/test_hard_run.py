"""No model calls: what a hard trial may run, keep and count."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import hard_run
import sandbox


TASK = {'id': 'swe-x', 'kind': 'swe-bench-verified', 'request': 'Fix it.', 'image': 'swebench/x@sha256:0'}


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

    def test_a_limit_is_a_task_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(hard_run.settled_state(Path(directory), {'status': 'failed'}), 'complete')

    def test_no_result_is_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(hard_run.settled_state(Path(directory), {}), 'invalid')


class Limits(unittest.TestCase):
    def test_a_stage_run_has_no_per_call_cap(self):
        # The installation refuses a budgeted call above 4096 tokens, which xhigh alone can pass.
        self.assertNotIn('maxOutputTokensPerCall', hard_run.LIMITS)

    def test_limits_stay_within_the_installation_caps(self):
        self.assertLessEqual(hard_run.LIMITS['maxModelCalls'], 100)
        self.assertLessEqual(hard_run.LIMITS['maxOutputTokens'], 256000)
        self.assertLessEqual(hard_run.LIMITS['modelTimeoutMs'], 300000)
        self.assertLessEqual(hard_run.LIMITS['runDeadlineMs'], 3600000)


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

    def test_the_gpt_stages_keep_their_levels(self):
        for stage in 'ABC':
            self.assertEqual(hard_run.stage_levels(stage), hard_run.EFFORTS)

    def test_only_stage_d_uses_the_deepseek_connection(self):
        self.assertEqual(hard_run.stage_provider('D'), hard_run.SMOKE)
        for stage in 'ABC':
            self.assertIsNone(hard_run.stage_provider(stage))

    def test_a_response_is_not_cut_at_the_endpoint_default(self):
        [model] = hard_run.SMOKE['modelProviders'][0]['models']
        self.assertEqual(model['maxOutput'], 16384)

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

    def test_the_report_says_it_decides_nothing(self):
        report = hard_run.level_report([self.row('a', 'low', True)], ('low',))
        self.assertEqual(report['gateEvidence'], False)


if __name__ == '__main__':
    unittest.main()
