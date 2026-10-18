import { ManagedHook } from '@corral/contracts';

/** Generates an ordinary Pi extension; discovery never imports it. */
export function managedHookSource(raw: ManagedHook): string {
  const hook = ManagedHook.parse(raw);
  const action =
    hook.template === 'notify'
      ? `ctx.ui.notify(${JSON.stringify(hook.message || hook.title)}, 'info');`
      : `if (!(await ctx.ui.confirm(${JSON.stringify(hook.title)}, ${JSON.stringify(hook.message)}))) throw new Error('Hook declined');`;
  return `export default function (pi) {\n  pi.on('session_start', async (_event, ctx) => {\n    ${action}\n  });\n}\n`;
}
