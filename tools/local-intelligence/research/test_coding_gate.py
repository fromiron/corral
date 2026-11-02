"""No model calls: the coding effort gates decide from frozen arithmetic only."""
import unittest

from coding_gate import (coding_gate_report, loss_bound, screening_decision, screening_report)


def trial(group, repeat, *, candidate=True, reference=True, candidate_seconds=100.,
          reference_seconds=100.):
    return {'group': group, 'repeat': repeat,
            'candidatePassed': candidate, 'referencePassed': reference,
            'candidateWallSeconds': candidate_seconds, 'referenceWallSeconds': reference_seconds,
            'candidateTotalTokens': 1000, 'referenceTotalTokens': 1000}


def families(count, **options):
    names = [f'family-{index:04d}' for index in range(count)]
    return names, [trial(name, repeat, **options) for name in names for repeat in [0, 1]]


def run(task, effort, passed, *, model='gpt-6.1-sol', state='complete', seconds=60.):
    return {'task': task, 'model': model, 'effort': effort, 'state': state,
            'passed': passed, 'wallSeconds': seconds, 'totalTokens': 1000}


def levels(medium, high, xhigh, *, low=None, offset=0, **options):
    rows = []
    for index, outcome in enumerate(zip(low or medium, medium, high, xhigh)):
        task = f'task-{index + offset:02d}'
        rows += [run(task, effort, passed, **options)
                 for effort, passed in zip(('low', 'medium', 'high', 'xhigh'), outcome)]
    return rows


class LossBound(unittest.TestCase):
    def test_table_matches_the_frozen_report(self):
        self.assertAlmostEqual(loss_bound(200, 0), -.0183, places=4)
        self.assertAlmostEqual(loss_bound(200, 1), -.0275, places=4)

    def test_gate_size_tolerates_one_net_loss_and_not_two(self):
        self.assertGreaterEqual(loss_bound(110, 1), -.05)
        self.assertLess(loss_bound(110, 2), -.05)
        self.assertLess(loss_bound(109, 1), -.05)

    def test_offsetting_gains_relax_the_bound(self):
        self.assertGreater(loss_bound(200, 2, gains=20), loss_bound(200, 2))


class CodingGate(unittest.TestCase):
    def report(self, trials, names):
        return coding_gate_report(trials, expected_groups=names, resamples=500)

    def test_faster_with_kept_success_passes(self):
        names, trials = families(110, candidate_seconds=80.)
        report = self.report(trials, names)
        self.assertAlmostEqual(report['timeReduction']['estimate'], .2)
        self.assertTrue(report['passesGate'])

    def test_constant_medium_itself_cannot_pass(self):
        names, trials = families(110)
        self.assertFalse(self.report(trials, names)['passesGate'])

    def test_too_few_families_cannot_pass(self):
        names, trials = families(109, candidate_seconds=80.)
        report = self.report(trials, names)
        self.assertFalse(report['enoughFamilies'])
        self.assertFalse(report['passesGate'])

    def test_two_net_losses_fail_however_fast(self):
        names, trials = families(110, candidate_seconds=10.)
        for row in trials[:4]:
            row['candidatePassed'] = False
        report = self.report(trials, names)
        self.assertLess(report['successLower'], -.05)
        self.assertFalse(report['passesGate'])

    def test_giving_up_early_does_not_buy_time(self):
        # Half the time per run at half the success is the same time per success.
        names, trials = families(110, candidate_seconds=50.)
        for row in trials[::2]:
            row['candidatePassed'] = False
        report = self.report(trials, names)
        self.assertAlmostEqual(report['timeReduction']['estimate'], 0, places=6)
        self.assertFalse(report['passesGate'])

    def test_raising_effort_counts_the_failed_runs_it_avoids(self):
        # Slower per run, but medium loses a quarter of its runs: time per success falls.
        names, trials = families(110, candidate_seconds=110.)
        for row in trials[::4]:
            row['referencePassed'] = False
        report = self.report(trials, names)
        self.assertGreater(report['timeReduction']['estimate'], .1)
        self.assertGreater(report['timeReduction']['interval'][0], 0)
        self.assertTrue(report['passesGate'])

    def test_tokens_are_reported_and_do_not_gate(self):
        names, trials = families(110, candidate_seconds=80.)
        for row in trials:
            row['candidateTotalTokens'] = 1500
        report = self.report(trials, names)
        self.assertAlmostEqual(report['tokenReduction']['estimate'], -.5)
        self.assertTrue(report['passesGate'])

    def test_missing_time_is_refused(self):
        names, trials = families(110)
        del trials[3]['candidateWallSeconds']
        with self.assertRaisesRegex(ValueError, 'wall seconds'):
            self.report(trials, names)

    def test_nonpositive_time_is_refused(self):
        names, trials = families(110)
        trials[3]['referenceWallSeconds'] = 0
        with self.assertRaisesRegex(ValueError, 'wall seconds'):
            self.report(trials, names)


class Screening(unittest.TestCase):
    def screen(self, rows, count):
        return screening_report(rows, tasks=[f'task-{index:02d}' for index in range(count)],
                                model='gpt-6.1-sol')

    def test_counts_each_task_by_its_outcomes(self):
        rows = levels([True, False, False, False, True, True, True, False],
                      [True, True, True, False, False, True, False, False],
                      [True, True, False, True, False, False, True, False])
        report = self.screen(rows, 8)
        self.assertEqual(report['all'], 1)
        self.assertEqual(report['highRaised'], 2)
        self.assertEqual(report['xhighOnly'], 1)
        self.assertEqual(report['mediumOnly'], 1)
        self.assertEqual(report['mixed'], 2)
        self.assertEqual(report['none'], 1)

    def test_a_task_high_raises_is_not_xhigh_only(self):
        report = self.screen(levels([False], [True], [True]), 1)
        self.assertEqual(report['highRaised'], 1)
        self.assertEqual(report['xhighOnly'], 0)

    def test_one_high_raised_of_twenty_four_stays_below_the_threshold(self):
        rows = levels([False] + [True] * 23, [True] * 24, [True] * 24)
        report = self.screen(rows, 24)
        self.assertAlmostEqual(report['highRaisedRate'], 1 / 24)
        self.assertFalse(report['highReachesThreshold'])

    def test_two_high_raised_of_twenty_four_reach_it(self):
        rows = levels([False, False] + [True] * 22, [True] * 24, [True] * 24)
        report = self.screen(rows, 24)
        self.assertTrue(report['highReachesThreshold'])
        self.assertFalse(report['xhighReachesThreshold'])

    def test_one_xhigh_only_of_twenty_four_stays_below_the_threshold(self):
        rows = levels([False] + [True] * 23, [False] + [True] * 23, [True] * 24)
        report = self.screen(rows, 24)
        self.assertAlmostEqual(report['xhighOnlyRate'], 1 / 24)
        self.assertFalse(report['xhighReachesThreshold'])

    def test_two_xhigh_only_of_twenty_four_reach_it(self):
        rows = levels([False, False] + [True] * 22, [False, False] + [True] * 22, [True] * 24)
        report = self.screen(rows, 24)
        self.assertTrue(report['xhighReachesThreshold'])
        self.assertFalse(report['highReachesThreshold'])

    def test_a_failed_run_stays_in_the_denominator(self):
        rows = levels([False] * 24, [False] * 24, [False] * 24)
        report = self.screen(rows, 24)
        self.assertEqual(report['none'], 24)
        self.assertEqual(report['tasks'], 24)

    def test_an_unsettled_run_at_any_level_is_invalid_and_never_a_gain(self):
        for level in range(4):
            rows = levels([False, True], [True, True], [True, True])
            rows[level].update(state='invalid', passed=False)
            report = self.screen(rows, 2)
            self.assertEqual(report['invalid'], 1)
            self.assertEqual(report['highRaised'], 0)
            self.assertEqual(report['xhighOnly'], 0)
            self.assertEqual(report['all'], 1)

    def test_every_task_needs_every_level(self):
        rows = levels([True, True], [True, True], [True, True])
        del rows[-2]
        with self.assertRaisesRegex(ValueError, 'every level'):
            self.screen(rows, 2)

    def test_each_level_is_reported(self):
        report = self.screen(levels([True], [False], [True]), 1)
        self.assertEqual(list(report['byEffort']), ['low', 'medium', 'high', 'xhigh'])
        self.assertEqual(report['byEffort']['high']['passed'], 0)

    def test_low_is_reported_and_stays_out_of_the_rule(self):
        report = self.screen(levels([True] * 24, [True] * 24, [True] * 24, low=[False] * 24), 24)
        self.assertEqual(report['lowLost'], 24)
        self.assertEqual(report['all'], 24)
        self.assertFalse(report['highReachesThreshold'])
        self.assertFalse(report['xhighReachesThreshold'])

    def test_a_task_no_level_passes_is_not_low_lost(self):
        report = self.screen(levels([False], [False], [False]), 1)
        self.assertEqual(report['lowLost'], 0)
        self.assertEqual(report['none'], 1)

    def test_low_passing_alone_is_not_low_lost(self):
        report = self.screen(levels([False], [False], [False], low=[True]), 1)
        self.assertEqual(report['lowLost'], 0)

    def test_a_repeated_run_is_refused(self):
        rows = levels([True], [True], [True])
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            self.screen(rows + rows[:1], 1)

    def test_an_unexpected_task_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'frozen'):
            self.screen(levels([True, True], [True, True], [True, True]), 1)


class Decision(unittest.TestCase):
    screen = staticmethod(lambda high=False, xhigh=False, invalid=0: {
        'highReachesThreshold': high, 'xhighReachesThreshold': xhigh, 'invalid': invalid})

    def test_a_high_gain_tries_constant_high_before_any_judge(self):
        self.assertEqual(screening_decision(self.screen(high=True)), 'try-constant-high')
        self.assertEqual(screening_decision(self.screen(high=True, xhigh=True)), 'try-constant-high')

    def test_a_high_gain_on_luna_alone_counts(self):
        self.assertEqual(screening_decision(self.screen(), self.screen(high=True)), 'try-constant-high')

    def test_an_xhigh_gain_on_sol_goes_on_to_phase_three(self):
        self.assertEqual(screening_decision(self.screen(xhigh=True)), 'phase-3')

    def test_no_gain_on_sol_needs_luna_before_closing(self):
        self.assertEqual(screening_decision(self.screen()), 'run-stage-c')

    def test_no_gain_on_both_closes_adaptive_judging(self):
        self.assertEqual(screening_decision(self.screen(), self.screen()), 'close-adaptive')

    def test_an_xhigh_gain_on_luna_alone_goes_on(self):
        self.assertEqual(screening_decision(self.screen(), self.screen(xhigh=True)), 'phase-3')

    def test_invalid_runs_block_any_decision(self):
        self.assertEqual(screening_decision(self.screen(high=True, invalid=1)), 'incomplete')
        self.assertEqual(screening_decision(self.screen(xhigh=True, invalid=1)), 'incomplete')
        self.assertEqual(screening_decision(self.screen(), self.screen(invalid=1)), 'incomplete')
        self.assertEqual(screening_decision(self.screen(high=True), self.screen(invalid=1)), 'incomplete')


if __name__ == '__main__':
    unittest.main()
