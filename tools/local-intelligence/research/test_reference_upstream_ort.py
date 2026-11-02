"""Final inference requires an explicit flag and immutable local exposure evidence."""
import json
from pathlib import Path
import tempfile
import unittest

import reference_upstream_ort as reference


class ReferenceExposureTests(unittest.TestCase):
    def test_final_requires_flag_and_preserves_split(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); prepared = root / 'ids.json'; output = root / 'predictions.json'
            data = {'metadata': {'finalInputPresent': True}, 'records': [{'id': 'x', 'split': 'final'}]}
            prepared.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'unseal'):
                reference.record_final_exposure(data, prepared, output, False)
            self.assertFalse(Path(str(output) + '.exposure.json').exists())
            self.assertTrue(reference.record_final_exposure(data, prepared, output, True))
            exposure = json.loads(Path(str(output) + '.exposure.json').read_text())
            self.assertEqual(exposure['preparedSha256'], reference.digest(prepared))
            self.assertEqual(data['records'][0]['split'], 'final')
            self.assertEqual(exposure['temperature'], 1.55)
            with self.assertRaises(FileExistsError):
                reference.record_final_exposure(data, prepared, output, True)

    def test_nonfinal_preparation_does_not_create_exposure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); prepared = root / 'ids.json'; prepared.write_text('{}')
            output = root / 'predictions.json'
            self.assertFalse(reference.record_final_exposure({'metadata': {}, 'records': []}, prepared, output, False))
            self.assertFalse(Path(str(output) + '.exposure.json').exists())


if __name__ == '__main__':
    unittest.main()
