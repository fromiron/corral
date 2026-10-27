export const SESSION_MISSING = 'corral:session-missing';

/** Share authentication loss across service clients without discarding their drafts. */
export const sessionFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status === 401) window.dispatchEvent(new Event(SESSION_MISSING));
  return response;
};
