import copy
import unittest
import torch
from export import wrapped_config, wrapped_tensors
from probe import clipped


class WrapperTest(unittest.TestCase):
    def test_text_config_and_tensors_are_preserved_without_multimodal_weights(self):
        source = {'architectures': ['EmbeddingGemma2TextModel'], 'model_type': 'embedding_gemma2_text', 'hidden_size': 512, 'embedding_dim': 768, 'transformers_version': '5.22.1'}
        before = copy.deepcopy(source)
        config = wrapped_config(source)
        self.assertEqual(config['text_config'], {k: v for k, v in before.items() if k != 'architectures'})
        self.assertEqual(source, before)
        self.assertEqual(config['architectures'], ['EmbeddingGemma2Model'])
        self.assertIsNone(config['vision_config'])
        self.assertIsNone(config['audio_config'])
        self.assertEqual(config['transformers_version'], '5.22.1')
        tensor = torch.tensor([[1.0, -0.0], [3.5, -7.0]], dtype=torch.float32)
        result = wrapped_tensors({'embedding_projection.weight': tensor})
        self.assertEqual(list(result), ['language_model.embedding_projection.weight'])
        self.assertIs(result['language_model.embedding_projection.weight'], tensor)
        self.assertEqual(result['language_model.embedding_projection.weight'].view(torch.int32).tolist(), tensor.view(torch.int32).tolist())

    def test_overbudget_cut_preserves_first_128_and_tail_including_special_tokens(self):
        original = list(range(1400))
        result = clipped(original)
        self.assertEqual(result, original[:128] + original[-896:])
        self.assertEqual(len(result), 1024)
        self.assertEqual(original, list(range(1400)))
        self.assertEqual(clipped([2, 10, 1]), [2, 10, 1])

    def test_wrong_architecture_or_double_wrapping_rejected(self):
        with self.assertRaises(ValueError):
            wrapped_config({'architectures': ['OtherModel']})
        with self.assertRaises(ValueError):
            wrapped_tensors({'language_model.layers.0.weight': torch.ones(1)})


if __name__ == '__main__':
    unittest.main()
