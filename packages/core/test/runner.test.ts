import { SequentialPlanRunner } from '../src/runner.ts';
import { describeGraphRunnerContract } from '../src/testing/runner-contract.ts';

describeGraphRunnerContract('reference (core)', () => new SequentialPlanRunner());
