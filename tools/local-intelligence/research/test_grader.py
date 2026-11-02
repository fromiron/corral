import tempfile
import unittest
from pathlib import Path
from grader import write_files,grade

class GraderTests(unittest.TestCase):
    def test_generated_paths_cannot_leave_the_trial(self):
        with tempfile.TemporaryDirectory() as d:
            for path in ['../escaped.py','/tmp/escaped.py','src/../../escaped.py']:
                with self.assertRaises(ValueError):write_files(Path(d),[{'path':path,'content':'x'}],prefix='src/')
    def test_reference_pass_and_bug_failure_are_separate_observations(self):
        case={'id':'fixture','language':'python',
              'files':[{'path':'src/value.py','content':'def value(): return 1\n'}],
              'referenceFiles':[{'path':'src/value.py','content':'def value(): return 2\n'}],
              'tests':[{'path':'tests/test_value.py','content':'import unittest\nfrom src.value import value\nclass Check(unittest.TestCase):\n def test_value(self): self.assertEqual(value(),2)\n'}]}
        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(grade(case,case['files'],Path(d)/'bug')['passed'])
            self.assertTrue(grade(case,case['referenceFiles'],Path(d)/'reference')['passed'])

if __name__=='__main__':unittest.main()
