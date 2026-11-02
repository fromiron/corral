import unittest
from ami import visible_history,session_group

class AmiTests(unittest.TestCase):
    def test_future_and_overlapping_replies_are_not_input(self):
        acts=[{'id':'before','start':1,'end':2},{'id':'overlap','start':2,'end':5},{'id':'current','start':3,'end':4},{'id':'reply','start':4,'end':6}]
        self.assertEqual([x['id'] for x in visible_history(acts,acts[2])],['before'])
    def test_same_team_across_day_sessions_is_one_group(self):
        self.assertEqual(session_group('ES2002a'),session_group('ES2002d'))
        self.assertNotEqual(session_group('ES2002a'),session_group('ES2003a'))

if __name__=='__main__':unittest.main()
