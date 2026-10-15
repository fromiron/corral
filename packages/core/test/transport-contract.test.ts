import { FakeClock, SequentialIdFactory } from '@corral/testkit';
import { InMemoryCoordinator, InProcessTransport } from '../src/index.ts';
import { describeTransportContract } from '../src/testing/index.ts';

describeTransportContract(
  'in-process',
  (agents) =>
    new InProcessTransport(
      new InMemoryCoordinator({ clock: new FakeClock(), ids: new SequentialIdFactory(), agents }),
    ),
);
