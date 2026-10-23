/** Monaco and xterm parse colors themselves, so resolve CSS functions to sRGB hex. */
export function resolvedThemeColors<K extends string>(names: readonly K[]): Record<K, string> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Theme colors require a canvas context');
  const probe = document.createElement('span');
  probe.hidden = true;
  document.body.append(probe);
  try {
    return Object.fromEntries(
      names.map((name) => {
        probe.style.color = `var(--${name})`;
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = getComputedStyle(probe).color;
        context.fillRect(0, 0, 1, 1);
        const rgba = context.getImageData(0, 0, 1, 1).data;
        const channels = rgba[3] === 255 ? rgba.slice(0, 3) : rgba;
        return [
          name,
          `#${Array.from(channels, (value) => value.toString(16).padStart(2, '0')).join('')}`,
        ];
      }),
    ) as Record<K, string>;
  } finally {
    probe.remove();
  }
}
