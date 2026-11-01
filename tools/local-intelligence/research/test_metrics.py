import unittest
from metrics import valid_dispatch,decode_meeting

class DispatchTests(unittest.TestCase):
    def test_any_one_does_not_require_a_particular_valid_speaker(self):
        t={'mode':'one','eligibleIds':['a','b'],'excludedIds':['c']}
        self.assertTrue(valid_dispatch(['b'],t));self.assertFalse(valid_dispatch(['a','b'],t));self.assertFalse(valid_dispatch(['c'],t))
    def test_none_is_distinct_from_an_uncertain_invitation(self):
        p={'ids':['a','b'],'eligible':[.4,.45],'excluded':[.1,.1],'mode':[.3,.2,.2,.3]}
        self.assertEqual(decode_meeting(p),['b'])
        p['mode']=[.05,.05,.05,.85]
        self.assertEqual(decode_meeting(p),[])
    def test_declared_exclusion_is_not_a_false_negative_recipient(self):
        self.assertFalse(valid_dispatch(['a','b'],{'mode':'all','eligibleIds':['a'],'excludedIds':['b']}))

if __name__=='__main__':unittest.main()
