import { processPort } from '../../src/worker-process.ts';

processPort().send({ type: 'ready' });
setInterval(() => {}, 1000);
