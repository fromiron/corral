"""No model calls: the frozen task list follows from task content and nothing else."""
import unittest

import hard_tasks


def swe(instance, repo, difficulty='1-4 hours'):
    return {'instance_id': instance, 'repo': repo, 'difficulty': difficulty,
            'image': f'swebench/{instance}:latest'}


def commit(sha, subject='fix: keep drafts', body='x' * 200, files=None):
    return {'sha': sha, 'subject': subject, 'body': body, 'files': files or [
        'packages/core/src/a.ts', 'packages/core/src/b.ts', 'packages/core/src/c.ts',
        'packages/core/test/a.test.ts']}


class Swe(unittest.TestCase):
    rows = ([swe(f'big-{n}', 'big/big') for n in range(9)]
            + [swe(f'mid-{n}', 'mid/mid') for n in range(3)]
            + [swe(f'one-{n}', f'one/{n}') for n in range(6)])

    def test_every_repository_comes_first(self):
        chosen = hard_tasks.select_swe(self.rows, 8)
        self.assertEqual(len({row['repo'] for row in chosen}), 8)

    def test_no_repository_passes_the_cap(self):
        chosen = hard_tasks.select_swe(self.rows, 10)
        counts = [sum(row['repo'] == repo for row in chosen) for repo in {row['repo'] for row in chosen}]
        self.assertEqual(max(counts), hard_tasks.REPOSITORY_CAP)

    def test_easy_tasks_are_never_candidates(self):
        rows = self.rows + [swe('easy', 'easy/easy', '15 min - 1 hour'), swe('quick', 'q/q', '<15 min fix')]
        chosen = hard_tasks.select_swe(rows, 10)
        self.assertFalse({'easy', 'quick'} & {row['instance_id'] for row in chosen})

    def test_longest_tasks_are_candidates(self):
        chosen = hard_tasks.select_swe([swe('long', 'long/long', '>4 hours')], 1)
        self.assertEqual(chosen[0]['instance_id'], 'long')

    def test_input_order_does_not_change_the_choice(self):
        ids = [row['instance_id'] for row in hard_tasks.select_swe(self.rows, 10)]
        again = [row['instance_id'] for row in hard_tasks.select_swe(self.rows[::-1], 10)]
        self.assertEqual(ids, again)

    def test_too_few_tasks_is_an_error(self):
        with self.assertRaisesRegex(ValueError, 'too few'):
            hard_tasks.select_swe(self.rows[:1], 2)


class Commits(unittest.TestCase):
    def test_a_multifile_fix_with_tests_qualifies(self):
        self.assertTrue(hard_tasks.commit_qualifies(commit('a')))

    def test_a_feature_does_not(self):
        self.assertFalse(hard_tasks.commit_qualifies(commit('a', subject='feat: add drafts')))

    def test_a_fix_without_a_vitest_file_does_not(self):
        files = ['a/src/a.ts', 'a/src/b.ts', 'a/src/c.ts', 'e2e/flow.spec.ts']
        self.assertFalse(hard_tasks.commit_qualifies(commit('a', files=files)))

    def test_two_files_are_not_enough(self):
        files = ['a/src/a.ts', 'a/test/a.test.ts']
        self.assertFalse(hard_tasks.commit_qualifies(commit('a', files=files)))

    def test_no_source_file_is_not_enough(self):
        files = ['a/test/a.test.ts', 'a/test/b.test.ts', 'a/test/c.test.ts']
        self.assertFalse(hard_tasks.commit_qualifies(commit('a', files=files)))

    def test_a_single_source_file_only_ever_follows_the_rest(self):
        one = ['a/src/a.ts', 'a/test/a.test.ts', 'a/test/b.test.ts']
        commits = [commit(f'{n:040x}', files=one) for n in range(5)] + [commit(f'{n:040x}') for n in range(5, 10)]
        tiers = [hard_tasks.commit_tier(row) for row in hard_tasks.commit_order(commits)]
        self.assertEqual(tiers, [1] * 5 + [2] * 5)

    def test_two_source_files_and_a_test_qualify(self):
        files = ['a/src/a.ts', 'a/src/b.ts', 'a/test/a.test.ts']
        self.assertTrue(hard_tasks.commit_qualifies(commit('a', files=files)))

    def test_a_subject_alone_states_no_task(self):
        self.assertFalse(hard_tasks.commit_qualifies(commit('a', body='')))

    def test_a_dependency_change_does_not(self):
        files = commit('a')['files'] + ['pnpm-lock.yaml']
        self.assertFalse(hard_tasks.commit_qualifies(commit('a', files=files)))

    def test_order_is_seeded_by_commit_only(self):
        commits = [commit(f'{n:040x}') for n in range(20)]
        chosen = hard_tasks.select_commits(commits, 12)
        self.assertEqual(chosen, hard_tasks.select_commits(commits[::-1], 12))
        self.assertEqual(len(chosen), 12)


class Stages(unittest.TestCase):
    def manifest(self):
        return hard_tasks.stages([f'swe-{n}' for n in range(12)], [f'corral-{n}' for n in range(12)])

    def test_stage_sizes(self):
        stages = self.manifest()
        self.assertEqual({key: len(value) for key, value in stages.items()}, {'A': 6, 'B': 24, 'C': 12})

    def test_each_stage_holds_both_kinds_evenly(self):
        for tasks in self.manifest().values():
            self.assertEqual(sum(task.startswith('swe') for task in tasks), len(tasks) // 2)

    def test_stages_nest_so_runs_can_be_reused(self):
        stages = self.manifest()
        self.assertLessEqual(set(stages['A']), set(stages['C']))
        self.assertLessEqual(set(stages['C']), set(stages['B']))


if __name__ == '__main__':
    unittest.main()
