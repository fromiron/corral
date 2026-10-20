export function studioMicrophoneRequest(
  permission: string,
  requestingUrl: string | undefined,
  origin: string | null,
  mainFrame: boolean,
  media: readonly string[] | undefined,
) {
  if (
    permission !== 'media' ||
    !mainFrame ||
    !origin ||
    media?.length !== 1 ||
    media[0] !== 'audio'
  )
    return false;
  try {
    return !!requestingUrl && new URL(requestingUrl).origin === origin;
  } catch {
    return false;
  }
}
