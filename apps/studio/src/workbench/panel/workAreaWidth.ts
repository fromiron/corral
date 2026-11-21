import { createContext, useContext } from 'react';

/**
 * The work area's width in px, when something other than the frame's own measure gives it.
 * Null (the default): the session frame measures its work area itself. Tests set a width here,
 * and change it, instead of stubbing layout for every screen the panel carries.
 */
export const WorkAreaWidthContext = createContext<number | null>(null);

/** The given work-area width, or null when the frame is to measure it. */
export function useGivenWorkAreaWidth(): number | null {
  return useContext(WorkAreaWidthContext);
}
