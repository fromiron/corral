import unittest
from native_views import restore_recipients


class NativeRuntimeViewTests(unittest.TestCase):
    def test_same_scene_is_scored_in_original_ids_and_none_stays_none(self):
        row = {'task': 'meeting', 'runtimeView': {'modelToOriginalIds': {'p1': 'real-b', 'p2': 'real-a'}}}
        answer = {'type': 'result', 'participantIds': ['p2']}
        self.assertEqual(restore_recipients(row, answer)['participantIds'], ['real-a'])
        self.assertEqual(answer['participantIds'], ['p2'])
        self.assertEqual(restore_recipients(row, {'type': 'result', 'participantIds': []})['participantIds'], [])
        with self.assertRaises(ValueError):
            restore_recipients(row, {'type': 'result', 'participantIds': ['p3']})
        with self.assertRaises(ValueError):
            restore_recipients(row, {'type': 'result', 'participantIds': ['p1', 'p1']})


if __name__ == '__main__':
    unittest.main()
