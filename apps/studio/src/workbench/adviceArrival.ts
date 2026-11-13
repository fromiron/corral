import { createContext } from 'react';

// The run a person came to the conversation to read advice in (features/inbox.md `advice`): its
// row's advice, which its target never read, is open on arrival.
export const AdviceArrival = createContext<string | null>(null);
