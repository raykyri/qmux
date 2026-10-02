/** Let React commit and the browser paint before starting slow work. */
export function waitForPaintedFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
