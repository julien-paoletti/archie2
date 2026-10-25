// The built-in sample with an element selected and the inspector open.
export const doc = null;
export const prefs = { inspectorOpen: true };
export const scale = 1.5;

export async function run(page, shot) {
  await page.evaluate(() => {
    archie.editor.setSelection(['orders']);
    archie.editor.zoomTo(0.8);
  });
  await page.waitForTimeout(600);
  await shot('canvas');
  await shot('inspector', { x: 890, y: 60, width: 310, height: 480 });
  return page.evaluate(() => [...document.querySelectorAll('.inspector .seg.on')].map((b) => b.textContent));
}
