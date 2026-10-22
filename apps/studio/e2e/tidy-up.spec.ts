import { expect, type Page, test } from '@playwright/test';

// Roadmap 18: "Tidy up" arranges the canvas by the flow; an import without a layout comes in
// arranged.

async function boxes(page: Page, ids: string[]) {
  // Sample one frame: fitView can move the viewport between separate boundingBox calls.
  const out = await page
    .locator(ids.map((id) => `.react-flow__node[data-id="${id}"]`).join(', '))
    .evaluateAll((nodes) =>
      Object.fromEntries(
        nodes.map((node) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return [node.getAttribute('data-id'), { x, y, width, height }];
        }),
      ),
    );
  return (id: string) => {
    const box = out[id];
    if (!box) throw new Error(`no box for ${id}`);
    return box;
  };
}

const apart = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

const TOP = ['research', 'review_loop', 'approval', 'output', 'helper', 'respond'];

test('[TC-CAN-002-H] Tidy up rearranges a messy canvas, and one Undo puts it back', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page
    .getByRole('region', { name: 'Start from a template' })
    .getByRole('article')
    .filter({ hasText: 'Research team' })
    .getByRole('button', { name: 'Edit this team' })
    .click();
  await expect(page.locator('.react-flow__node')).toHaveCount(9);
  // Pile the Research node onto the Output.
  const output = await page.locator('.react-flow__node[data-id="output"]').boundingBox();
  const research = await page.locator('.react-flow__node[data-id="research"]').boundingBox();
  if (!output || !research) throw new Error('nodes not drawn');
  await page.mouse.move(research.x + 20, research.y + 10);
  await page.mouse.down();
  await page.mouse.move(output.x + 30, output.y + 15, { steps: 8 });
  await page.mouse.up();
  const messy = await boxes(page, ['research', 'output']);
  expect(apart(messy('research'), messy('output'))).toBe(false);

  await page.getByRole('button', { name: 'Arrange graph' }).click();
  // The view eases to fit the result; measure once it has settled.
  const overlaps = async () => {
    const tidy = await boxes(page, TOP);
    return TOP.flatMap((a, i) =>
      TOP.slice(i + 1).flatMap((other) => (apart(tidy(a), tidy(other)) ? [] : [`${a}/${other}`])),
    );
  };
  await expect.poll(overlaps).toEqual([]);

  await page.getByRole('button', { name: 'Undo' }).click();
  const back = await boxes(page, ['research', 'output']);
  expect(apart(back('research'), back('output'))).toBe(false);
});
