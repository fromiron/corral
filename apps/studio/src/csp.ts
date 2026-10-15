import { z } from 'zod';

// Studio runs under a CSP without 'unsafe-eval' (C-055). Zod 4 compiles fast paths with
// `new Function` unless told not to; this module is imported first so no schema runs before.
z.config({ jitless: true });
