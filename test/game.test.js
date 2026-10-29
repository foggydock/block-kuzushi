'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

// テスト用の写しだけに内部状態への入口を追加する。本番には公開しない。
function game() {
  const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\}\)\(\);\s*$/, `
    globalThis.api = { G, startGame, update, loop, onDown, onMove, pause, resize, loadStage,
      counts: () => ({ updates, draws }) };
  })();`).replace('  function update() {', '  var updates = 0, draws = 0;\n  function update() { updates++;')
    .replace('  function draw() {', '  function draw() { draws++;');
  const context = new Proxy({}, { get: (o, k) => o[k] || (() => {}) });
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, classList: { add() {}, remove() {} }, addEventListener() {},
      getContext: () => context, getBoundingClientRect: () => ({ left: 0 }),
    });
    return elements.get(id);
  };
  let seed = 42;
  const math = Object.create(Math);
  math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const sandbox = { Math: math, window: { innerWidth: 496, innerHeight: 736, addEventListener() {} },
    document: { getElementById: el, addEventListener() {} }, requestAnimationFrame() {}, setTimeout() {} };
  vm.runInNewContext(source, sandbox);
  return sandbox.api;
}
const event = x => ({ clientX: x, cancelable: true, preventDefault() {} });

test('30/60/120Hzで1秒あたり60回更新する', () => {
  for (const hz of [30, 60, 120]) {
    const a = game(); a.startGame('easy'); a.loop(1000);
    for (let i = 1; i <= hz; i++) a.loop(1000 + i * 1000 / hz);
    assert.equal(a.counts().updates, 60);
  }
});
test('パドルの角に届いていないボールは反射しない／中央は反射する', () => {
  const a = game(); a.startGame('easy'); const { G } = a;
  G.stuck = false;
  Object.assign(G.ball, { x: G.paddle.x + G.paddle.w / 2 + 9, y: G.paddle.y - 10, vx: 0, vy: 1 });
  a.update(); assert.equal(G.ball.vy, 1);
  Object.assign(G.ball, { x: G.paddle.x, y: G.paddle.y - 10, vx: 0, vy: 1 });
  a.update(); assert.ok(G.ball.vy < 0);
});
test('一時停止中は全状態が固定され、離れた場所のタップでも移動・早送りしない', () => {
  const a = game(); a.startGame('normal'); a.onDown(event(240)); a.loop(0); a.loop(16);
  a.pause(); const before = JSON.stringify(a.G); a.onMove(event(400)); a.update();
  assert.equal(JSON.stringify(a.G), before);
  const pos = { x: a.G.ball.x, y: a.G.ball.y, paddle: a.G.paddle.x, vx: a.G.ball.vx, vy: a.G.ball.vy };
  a.onDown(event(20)); a.loop(10000);
  assert.equal(a.G.paddle.x, pos.paddle); assert.equal(a.G.ball.x, pos.x); assert.equal(a.G.ball.y, pos.y);
  assert.equal(a.G.ball.vx, pos.vx); assert.equal(a.G.ball.vy, pos.vy); assert.equal(a.G.paused, false);
});
test('発射待ちの画面離脱でもアイテム・メッセージが止まる', () => {
  const a = game(); a.startGame('easy'); a.G.items.push({ x: 100, y: 400, t: 'life' });
  a.pause(); const before = JSON.stringify(a.G); a.update(); assert.equal(JSON.stringify(a.G), before);
  a.onDown(event(400)); assert.equal(a.G.stuck, true);
  a.onDown(event(240)); assert.equal(a.G.stuck, false);
});
test('硬さ2のブロックは1フレームで壊れず、速度0の軸でも数値を維持する', () => {
  const a = game(); a.startGame('easy'); a.G.stuck = false;
  a.G.bricks = [{ x: 210, y: 100, w: 60, h: 26, hp: 2, col: '#fff' }];
  Object.assign(a.G.ball, { x: 240, y: 137, vx: 0, vy: -4.6 }); a.update();
  assert.equal(a.G.bricks[0].hp, 1); assert.equal(a.G.score, 10); assert.ok(a.G.ball.vy > 0);
  for (const key of ['x', 'y', 'vx', 'vy']) assert.ok(Number.isFinite(a.G.ball[key]));
});
test('ステージ遷移・落下・ゲームオーバー・再開始・全クリア', () => {
  const a = game(); a.startGame('normal'); a.G.bricks = []; a.update();
  assert.equal(a.G.stage, 1); assert.equal(a.G.stuck, true);
  for (let lives = 2; lives >= 0; lives--) {
    a.G.stuck = false; Object.assign(a.G.ball, { y: 740, vx: 0, vy: 6 }); a.update();
    assert.equal(a.G.lives, lives); assert.equal(a.G.running, lives > 0);
  }
  a.startGame('easy'); assert.equal(a.G.lives, 5); assert.equal(a.G.score, 0);
  a.loadStage(4); a.G.bricks = []; a.update(); assert.equal(a.G.running, false);
});
test('アイテムで幅が増えても画面外へ出ず、ライフを加算する', () => {
  const a = game(); a.startGame('easy'); a.onMove(event(480));
  a.G.items = [{ x: a.G.paddle.x, y: 650, t: 'big' }, { x: a.G.paddle.x, y: 650, t: 'life' }];
  a.update(); assert.equal(a.G.paddle.w, 160); assert.ok(a.G.paddle.x <= 400); assert.equal(a.G.lives, 6);
});
test('タイトル・終了・一時停止画面は再描画せず、リサイズ時だけ描画する', () => {
  const a = game(); a.loop(0); a.loop(16); assert.equal(a.counts().draws, 1);
  a.resize(); a.loop(32); assert.equal(a.counts().draws, 2);
  a.startGame('easy'); a.loop(48); a.pause(); a.loop(64); const paused = a.counts().draws;
  a.loop(80); assert.equal(a.counts().draws, paused);
  a.onDown(event(240)); a.loadStage(4); a.G.bricks = []; a.loop(96); a.loop(112);
  const over = a.counts().draws; a.loop(128); assert.equal(a.counts().draws, over);
  a.resize(); a.loop(144); assert.equal(a.counts().draws, over + 1);
});

test('自動プレイ2万フレームで状態を維持し、同じブロックに1フレームで二重加点しない', () => {
  const a = game(); a.startGame('easy');
  for (let frame = 0; frame < 20000; frame++) {
    if (!a.G.running) a.startGame('easy');
    a.onMove(event(a.G.ball.x));
    if (a.G.stuck) a.onDown(event(a.G.paddle.x));
    const score = a.G.score;
    a.update();
    assert.ok(a.G.score - score <= 10);
    for (const key of ['x', 'y', 'vx', 'vy']) assert.ok(Number.isFinite(a.G.ball[key]));
    assert.ok(a.G.paddle.x >= a.G.paddle.w / 2 && a.G.paddle.x <= 480 - a.G.paddle.w / 2);
  }
});
