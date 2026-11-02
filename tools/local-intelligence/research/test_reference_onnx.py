import unittest
from reference_onnx import reference_request, rp_text


class ReferenceInputTests(unittest.TestCase):
    def test_rp_reference_receives_the_same_goal_and_request_as_legacy_corral(self):
        source = {'goal': 'Repair Unicode filename collision handling.', 'request': 'Continue with the next step.'}
        request = reference_request(source)
        self.assertIn(source['goal'], rp_text(request, 'observed a collision'))
        self.assertIn(source['request'], rp_text(request, 'observed a collision'))
        self.assertEqual(reference_request({'request': 'Fix typo'}), 'Fix typo')


if __name__ == '__main__':
    unittest.main()
