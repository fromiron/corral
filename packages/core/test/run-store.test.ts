import { InMemoryRunStore } from '../src/index.ts';
import { describeRunStoreContract } from '../src/testing/index.ts';

describeRunStoreContract('in-memory', () => new InMemoryRunStore());
