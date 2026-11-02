/** A mixed replay file is sealed if even one row belongs to the final partition. */
export function requiresExposure(rows: { split: string }[], unsealFinal: boolean): boolean {
  const final = rows.some((row) => row.split === 'final');
  if (final && !unsealFinal) throw new Error('final evaluation requires explicit unsealing');
  return final;
}
