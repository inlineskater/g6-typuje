import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("all inline scripts parse and Coin Pusher uses the defined HTML escaper", () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, "expected at least one inline script");
  scripts.forEach((match) => new Function(match[1]));
  assert.doesNotMatch(html, /\bescapeHtml\s*\(/);
  assert.match(html, /escapeHtmlText\(active\.nick/);
});

test("throw control is above the cabinet and desktop layout is viewport bounded", () => {
  const controls = html.indexOf('<aside class="cp-controls"');
  const dropButton = html.indexOf('id="coin-pusher-drop"', controls);
  const machine = html.indexOf('<section class="cp-machine"', controls);
  assert.ok(controls >= 0 && dropButton > controls && machine > dropButton);
  assert.match(html, /#tab-coin-pusher:not\(\.hidden\)[\s\S]*?height:\s*calc\(100dvh - 102px\)/);
  assert.match(html, /grid-template-areas:\s*'controls side' 'machine side'/);
  assert.match(html, /grid-template-rows:\s*34px minmax\(0, 1fr\) auto/);
  assert.match(html, /\.cp-stage \{ min-height:\s*0; height:\s*100%; aspect-ratio:\s*auto; \}/);
});

test("dense coin groups receive deterministic visual stack layers", () => {
  assert.match(html, /function coinPusherLayeredCoins\(coins\)/);
  assert.match(html, /visualLayer = 2/);
  assert.match(html, /coinPusherLayeredCoins\(frame\.coins\)\.forEach/);
});
