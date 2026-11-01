import unittest
from outcome_inputs import judge_input

class OutcomeInputTests(unittest.TestCase):
    def test_only_worker_visible_information_and_correct_speaker_meaning(self):
        case={'request':'repair parser','context':'observed failing trace','files':[{'path':'src/a.py','content':'return broken'}],
              'tests':[{'path':'tests/test.py','content':'HIDDEN_TEST'}],'referenceFiles':[{'path':'src/a.py','content':'SECRET_SOLUTION'}],
              'expectedDifficulty':'PRIVATE_LABEL','rationale':'PRIVATE_REASON'}
        result=judge_input(case)
        self.assertEqual(result['previousReply'],'')
        self.assertIn('observed failing trace',result['request'])
        self.assertEqual(result['tools'][0]['content'],'return broken')
        for secret in ['HIDDEN_TEST','SECRET_SOLUTION','PRIVATE_LABEL','PRIVATE_REASON']:self.assertNotIn(secret,str(result))

if __name__=='__main__':unittest.main()
