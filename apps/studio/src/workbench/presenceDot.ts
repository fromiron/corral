import type { PresenceTone } from '@corral/react';

// StatusDot takes a status word and colours it by that word's tone. A presence result already
// carries its tone, so each tone passes the one word that StatusDot draws in that tone.
const DOT: Record<PresenceTone, string> = {
  neutral: 'neutral',
  active: 'active',
  success: 'succeeded',
  warning: 'awaiting_user',
  danger: 'failed',
};

export function presenceDot(tone: PresenceTone) {
  return DOT[tone];
}
