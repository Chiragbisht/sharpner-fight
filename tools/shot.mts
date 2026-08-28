// Screenshot a page with a real browser, and report any console errors.
// Usage: node tools/shot.mts <url> <out.png> [--click=sel] [--drag=x1,y1,x2,y2] [--wait=ms] [--size=WxH]
import { chromium } from 'playwright';

const [url, out, ...rest] = process.argv.slice(2);
const arg = (n: string, d: string): string =>
  (rest.find((a) => a.startsWith(`--${n}=`)) || `=${d}`).split('=')[1];

const [w, h] = arg('size', '1400x900').split('x').map(Number);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });

const errors: string[] = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(700);

const click = arg('click', '');
if (click) {
  await page.click(click);
  await page.waitForTimeout(400);
}

const drag = arg('drag', '');
if (drag) {
  const [x1, y1, x2, y2] = drag.split(',').map(Number);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 12 });
  await page.waitForTimeout(250);
}

await page.waitForTimeout(Number(arg('wait', '300')));
await page.screenshot({ path: out });
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
