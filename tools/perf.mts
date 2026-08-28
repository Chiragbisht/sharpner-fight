import { chromium } from 'playwright';

interface FrameStats {
  median: number;
  p95: number;
  worst: number;
}

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
await p.goto('http://localhost:5173/', { waitUntil: 'load' });
await p.waitForTimeout(900);
await p.click('#playAi');
await p.waitForTimeout(500);
// Flick, so we sample while the sim is actually running and drawing motion.
await p.mouse.move(502, 524);
await p.mouse.down();
await p.mouse.move(320, 540, { steps: 8 });
await p.mouse.up();

const stats = await p.evaluate<FrameStats>(() => new Promise<FrameStats>((resolve) => {
  const frames: number[] = [];
  let last = performance.now();
  function tick(now: number) {
    frames.push(now - last);
    last = now;
    if (frames.length < 220) requestAnimationFrame(tick);
    else {
      const s = frames.slice(20).sort((a, b) => a - b);
      resolve({
        median: s[Math.floor(s.length / 2)],
        p95: s[Math.floor(s.length * 0.95)],
        worst: s[s.length - 1],
      });
    }
  }
  requestAnimationFrame(tick);
}));

console.log(
  `frame time  median ${stats.median.toFixed(1)}ms  p95 ${stats.p95.toFixed(1)}ms  worst ${stats.worst.toFixed(1)}ms`
);
console.log(`=> ${(1000 / stats.median).toFixed(0)} fps median`);
await b.close();
