// Lazy-loaded tab module — see ensureTabModule() in index.html.
// Moved out of index.html's inline <script> so it is fetched only when
// this tab is actually opened. Owns its own top-level const/let; reads
// shared globals from index.html, which always runs first.
'use strict';

// ── Plinko G6 ─────────────────────────────────────────────────────────────
function plinkoPayouts(rows = plinkoRows, risk = plinkoRisk) {
  return (PLINKO_PAYOUTS[rows] && PLINKO_PAYOUTS[rows][risk]) || PLINKO_PAYOUTS[12].medium;
}

function plinkoMultLabel(value) {
  const n = Number(value || 0);
  if (n >= 100 || Number.isInteger(n)) return 'x' + String(n);
  return 'x' + n.toFixed(n < 1 ? 2 : 1).replace(/\.0$/, '');
}

function plinkoRiskTone(mult) {
  const n = Number(mult || 0);
  if (n >= 10) return 'hot';
  if (n < 0.5) return 'cold';
  return '';
}

function plinkoQueueTotal() {
  return plinkoQueuedClicks + plinkoServerPending + plinkoDropQueue.length + plinkoAnims.length;
}

function syncPlinkoBusy() {
  plinkoBusy = plinkoQueueTotal() > 0;
  return plinkoBusy;
}

async function invokePlinko(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLINKO_REQUEST_TIMEOUT_MS);
  try {
    const { data: authData } = await sb.auth.getSession();
    const token = authData?.session?.access_token || SUPABASE_ANON_KEY;
    const response = await fetch(`${SUPABASE_URL}/functions/v1/plinko-action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!response.ok) throw new Error(data?.error || `Błąd Plinko (${response.status}).`);
    if (!data || data.ok === false) throw new Error(data?.error || 'Błąd Plinko.');
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Serwer Plinko nie odpowiedział przez 12 s. Drop został przerwany.');
    }
    throw err instanceof Error ? err : new Error('Błąd połączenia z Plinko.');
  } finally {
    clearTimeout(timer);
  }
}

async function loadPlinkoState(showToastOnError = true) {
  try {
    const data = await invokePlinko({ action: 'state' });
    applyPlinkoState(data);
  } catch (err) {
    if (showToastOnError) showToast('❌ ' + err.message);
    renderPlinko();
  }
}

function applyPlinkoState(data) {
  plinkoState = data;
  if (typeof data.coins === 'number' && me) {
    me.coins = data.coins;
    setText(headerCoins, me.coins);
  }
  renderPlinko();
}

function renderPlinko() {
  renderPlinkoControls();
  renderPlinkoBuckets();
  renderPlinkoSession();
  drawPlinkoBoard();
  if (!plinkoResizeBound) {
    plinkoResizeBound = true;
    window.addEventListener('resize', () => { if (activeTab === 'plinko') drawPlinkoBoard(); });
  }
}

function renderPlinkoControls() {
  syncPlinkoBusy();
  document.querySelectorAll('[data-bet="plinko"] .casino-chip').forEach(btn => {
    btn.disabled = plinkoBusy;
    btn.classList.toggle('active', Number(btn.dataset.stake) === plinkoBet);
  });
  setBetBarDisabled('plinko', plinkoBusy);
  syncBetBar('plinko', plinkoBet, { keepInput: true });
  document.querySelectorAll('#plinko-rows-control button').forEach(btn => {
    btn.disabled = plinkoBusy;
    btn.classList.toggle('active', Number(btn.dataset.rows) === plinkoRows);
  });
  document.querySelectorAll('#plinko-risk-control button').forEach(btn => {
    btn.disabled = plinkoBusy;
    btn.classList.toggle('active', btn.dataset.risk === plinkoRisk);
  });
  const countInput = document.getElementById('plinko-count-input');
  if (countInput) {
    countInput.disabled = plinkoBusy;
    if (Number(countInput.value) !== plinkoCount) countInput.value = plinkoCount;
  }
  const countSlider = document.getElementById('plinko-count-slider');
  if (countSlider) {
    const sliderVal = Math.min(100, plinkoCount);
    if (Number(countSlider.value) !== sliderVal) countSlider.value = sliderVal;
  }
  const countVal = document.getElementById('plinko-count-val');
  if (countVal) setText(countVal, plinkoCount);
  const total = plinkoQueueTotal();
  const full = total >= PLINKO_MAX_VISIBLE_QUEUE;
  const badge = total > 0 ? `<span class="plinko-drop-count">+${Math.min(total, 999)}</span>` : '';
  const one = document.getElementById('plinko-drop-one');
  if (one) {
    one.disabled = full;
    one.innerHTML = `+1 kula · ${plinkoBet} 🪙`;
    one.title = full ? 'Poczekaj, aż kolejka Plinko się zmniejszy.' : 'Klikaj wielokrotnie — każde kliknięcie dorzuca jedną kulę do kolejki';
  }
  const many = document.getElementById('plinko-drop-many');
  if (many) {
    many.disabled = full;
    many.innerHTML = `Seria ${plinkoCount} · ${plinkoCount * plinkoBet} 🪙${badge}`;
    many.title = full ? 'Poczekaj, aż kolejka Plinko się zmniejszy.' : `Wrzuć ${plinkoCount} kul naraz`;
  }
}

function plinkoResetDist() {
  plinkoDist = new Array((Number(plinkoRows) || 12) + 1).fill(0);
}

function plinkoResetSession() {
  plinkoSession = { drops: 0, wagered: 0, won: 0, best: 0 };
  plinkoResetDist();
  renderPlinkoSession();
  renderPlinkoBuckets();
}

function plinkoStatCell(key, value, tone = '', wide = false) {
  return el('div', { className: 'psb-cell' + (wide ? ' psb-wide' : '') },
    el('div', { className: 'psb-k' }, key),
    el('div', { className: 'psb-v' + (tone ? ' ' + tone : '') }, value)
  );
}

function renderPlinkoSession() {
  const box = document.getElementById('plinko-session');
  if (!box) return;
  const s = plinkoSession;
  const net = s.won - s.wagered;
  box.replaceChildren(
    plinkoStatCell('Kul', String(s.drops)),
    plinkoStatCell('Najlepszy', s.best ? plinkoMultLabel(s.best) : '—'),
    plinkoStatCell('Postawiono', `${s.wagered} 🪙`),
    plinkoStatCell('Wygrano', `${s.won} 🪙`),
    plinkoStatCell('Bilans sesji', `${net >= 0 ? '+' : ''}${net} 🪙`, net > 0 ? 'pos' : net < 0 ? 'neg' : '', true)
  );
}

// The bottom strip shows the live LANDING DISTRIBUTION (how many balls fell into each
// slot). The payout multipliers themselves are drawn once, on the canvas, at the slots
// where the balls actually land — so this row is not a second copy of them.
function renderPlinkoBuckets(hitBucket = null) {
  const box = document.getElementById('plinko-buckets');
  if (!box) return;
  const payouts = plinkoPayouts();
  if (!Array.isArray(plinkoDist) || plinkoDist.length !== payouts.length) plinkoResetDist();
  const totalBalls = plinkoDist.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...plinkoDist);
  box.style.gridTemplateColumns = `repeat(${payouts.length}, minmax(0, 1fr))`;
  box.replaceChildren(...payouts.map((mult, idx) => {
    const count = plinkoDist[idx] || 0;
    const share = totalBalls ? Math.round((count / totalBalls) * 100) : 0;
    const cell = el('div', { className: 'plinko-dist-cell ' + plinkoRiskTone(mult) + (idx === hitBucket ? ' hit' : '') });
    cell.title = `${plinkoMultLabel(mult)} — ${count} kul (${share}%)`;
    cell.append(
      el('div', { className: 'pd-barwrap' }, el('div', { className: 'pd-bar', style: { height: `${Math.round((count / max) * 100)}%` } })),
      el('div', { className: 'pd-count' + (count ? '' : ' empty') }, count ? String(count) : '·'),
      el('div', { className: 'pd-mult' }, plinkoMultLabel(mult))
    );
    return cell;
  }));
  const resetBtn = document.getElementById('plinko-dist-reset');
  if (resetBtn) setText(resetBtn, `${totalBalls} kul · wyzeruj ✕`);
}


function plinkoCanvasContext() {
  const canvas = document.getElementById('plinko-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(320, Math.round(rect.width || canvas.clientWidth || 760));
  const H = Math.max(300, Math.round(rect.height || canvas.clientHeight || 520));
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const pxW = Math.round(W * DPR);
  const pxH = Math.round(H * DPR);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  return { canvas, ctx, W, H };
}

function plinkoLayout(W, H, rows = plinkoRows) {
  const topPad = 58;      // room for the result pill + drop spout
  const bottomPad = 46;   // room for the payout buckets
  const sidePad = Math.max(16, W * 0.03);
  const usableW = W - sidePad * 2;
  const usableH = H - topPad - bottomPad;
  // Fill the board: horizontal pitch spreads pegs across the full width; vertical pitch
  // uses the full height but never exceeds the horizontal one (so cells stay square-ish
  // and pegs never overlap vertically). The bigger the board, the bigger the triangle.
  const pitchX = usableW / rows;
  const pitchY = usableH / (rows + 1);
  const gapX = pitchX;
  const gapY = Math.min(pitchY, pitchX);
  const fieldW = gapX * rows;
  const cx = W / 2;
  const top = topPad;
  const node = (r, k) => ({ x: cx + (k - r / 2) * gapX, y: top + r * gapY });
  const bucketY = Math.min(H - bottomPad, top + rows * gapY + Math.min(16, gapY * 0.55));
  return { topPad, bottomPad, gapX, gapY, cx, fieldW, top, bucketY, node };
}

function plinkoPathNodes(drop, W, H) {
  const rows = Number(drop?.rows || plinkoRows);
  const layout = plinkoLayout(W, H, rows);
  const nodes = [layout.node(0, 0)];
  let bucket = 0;
  (drop?.path || []).slice(0, rows).forEach((step, idx) => {
    bucket += Number(step) ? 1 : 0;
    nodes.push(layout.node(idx + 1, bucket));
  });
  nodes.push({ x: layout.node(rows, Number(drop?.bucket || bucket)).x, y: layout.bucketY - 16 });
  return { nodes, layout };
}

function drawRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function drawPlinkoBackground(ctx, W, H) {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#f8fafc');
  bg.addColorStop(0.58, '#eef6f4');
  bg.addColorStop(1, '#dbeafe');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = '#dbe4ea';
  ctx.lineWidth = 1;
  for (let x = 18; x < W; x += 28) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 24; y < H; y += 28) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.translate(W - 132, 62);
  ctx.rotate(0.12);
  ctx.strokeStyle = 'rgba(220,38,38,.18)';
  ctx.lineWidth = 5;
  ctx.strokeRect(-54, -20, 108, 40);
  ctx.fillStyle = 'rgba(220,38,38,.16)';
  ctx.font = '900 18px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('ZAKSIEGOWANO', 0, 6);
  ctx.restore();

  ctx.fillStyle = 'rgba(15,23,42,.08)';
  drawRoundRect(ctx, 22, 46, W - 44, H - 86, 18);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.72)';
  drawRoundRect(ctx, 18, 40, W - 36, H - 86, 18);
  ctx.fill();
  ctx.strokeStyle = 'rgba(15,23,42,.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawPlinkoBucketsCanvas(ctx, layout, rows, payouts, hitBucket = null) {
  // Colored landing slots (no text) — the multiplier numbers live once, aligned under
  // these slots, in the distribution strip below the board.
  const bucketW = Math.max(12, layout.gapX * 0.9);
  const h = Math.min(20, layout.gapY * 0.7);
  payouts.forEach((mult, idx) => {
    const p = layout.node(rows, idx);
    const hot = Number(mult) >= 10;
    const cold = Number(mult) < 0.5;
    const hit = idx === hitBucket;
    const x = p.x - bucketW / 2;
    const y = layout.bucketY;
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    if (hit) {
      grad.addColorStop(0, '#bbf7d0'); grad.addColorStop(1, '#22c55e');
    } else if (hot) {
      grad.addColorStop(0, '#fde68a'); grad.addColorStop(1, '#f97316');
    } else if (cold) {
      grad.addColorStop(0, '#e2e8f0'); grad.addColorStop(1, '#cbd5e1');
    } else {
      grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#cdddf5');
    }
    ctx.fillStyle = grad;
    drawRoundRect(ctx, x, y, bucketW, h, Math.min(5, bucketW / 3));
    ctx.fill();
    ctx.strokeStyle = hit ? 'rgba(22,101,52,.6)' : 'rgba(15,23,42,.12)';
    ctx.lineWidth = hit ? 2 : 1;
    ctx.stroke();
  });
}

function drawPlinkoPegs(ctx, layout, rows, activeIndex = -1) {
  const rad = Math.max(5.5, Math.min(14, Math.min(layout.gapX, layout.gapY) * 0.34));
  for (let r = 1; r <= rows; r += 1) {
    for (let k = 0; k <= r; k += 1) {
      const p = layout.node(r, k);
      const hot = activeIndex instanceof Set ? activeIndex.has(r) : r === activeIndex;
      // soft contact shadow under the peg
      ctx.beginPath();
      ctx.fillStyle = 'rgba(15,23,42,.16)';
      ctx.arc(p.x, p.y + rad * 0.34, rad, 0, Math.PI * 2);
      ctx.fill();
      // peg body with a vertical sheen so it reads as a rounded stud
      const grad = ctx.createRadialGradient(p.x - rad * 0.4, p.y - rad * 0.5, rad * 0.15, p.x, p.y, rad);
      if (hot) {
        grad.addColorStop(0, '#fff7ed'); grad.addColorStop(0.5, '#fbbf24'); grad.addColorStop(1, '#d97706');
      } else {
        grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.45, '#7dd3fc'); grad.addColorStop(1, '#0284c7');
      }
      ctx.beginPath();
      ctx.fillStyle = grad;
      ctx.shadowColor = hot ? 'rgba(245,158,11,.65)' : 'rgba(2,132,199,.4)';
      ctx.shadowBlur = hot ? 16 : 8;
      ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      // bright specular highlight
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.arc(p.x - rad * 0.34, p.y - rad * 0.38, rad * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawPlinkoBall(ctx, x, y, r = 12, glow = false) {
  ctx.save();
  ctx.shadowColor = glow ? 'rgba(245,158,11,.9)' : 'rgba(15,23,42,.28)';
  ctx.shadowBlur = glow ? 24 : 10;
  const grad = ctx.createRadialGradient(x - r * 0.36, y - r * 0.42, r * 0.12, x, y, r);
  grad.addColorStop(0, '#fff7ed');
  grad.addColorStop(0.45, '#facc15');
  grad.addColorStop(1, '#b45309');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#2b1708';
  ctx.font = `900 ${Math.max(8, r * 0.72)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('G6', x, y + r * 0.05);
  ctx.restore();
}

function plinkoEase(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function drawPlinkoParticles(ctx, dt) {
  if (!plinkoParticles.length) return;
  plinkoParticles = plinkoParticles.filter(p => p.life > 0);
  for (const p of plinkoParticles) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 220 * dt;
    const a = Math.max(0, p.life / p.maxLife);
    ctx.save();
    ctx.globalAlpha = a;
    if (p.text) {
      ctx.fillStyle = p.color || '#f59e0b';
      ctx.font = `900 ${p.size || 16}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(p.text, p.x, p.y);
    } else {
      ctx.fillStyle = p.color || '#f59e0b';
      ctx.beginPath();
      ctx.arc(p.x, p.y, (p.size || 4) * (0.6 + a * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

const PLINKO_PARTICLE_CAP = 160;
function spawnPlinkoParticles(x, y, kind = 'peg', amount = 10) {
  if (plinkoReducedMotion()) return;
  if (plinkoParticles.length >= PLINKO_PARTICLE_CAP) return; // keep frames light during big batches
  const colors = kind === 'bucket' ? ['#22c55e', '#facc15', '#38bdf8', '#f97316'] : ['#38bdf8', '#facc15', '#10b981'];
  for (let i = 0; i < amount; i += 1) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.25;
    const speed = (kind === 'bucket' ? 145 : 82) + Math.random() * 110;
    plinkoParticles.push({
      x, y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - (kind === 'bucket' ? 45 : 0),
      life: 0.45 + Math.random() * 0.42,
      maxLife: 0.45 + Math.random() * 0.42,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 3 + Math.random() * 4,
    });
  }
  // Emoji confetti only when few balls are in flight — avoids a storm on big series.
  if (kind === 'bucket' && plinkoAnims.length <= 3) {
    ['🧾', '☕', '🪙'].forEach((text, i) => {
      plinkoParticles.push({
        x: x + (i - 1) * 9, y,
        vx: (i - 1) * 44,
        vy: -120 - Math.random() * 80,
        life: 0.82,
        maxLife: 0.82,
        text,
        size: 17 + Math.random() * 5,
      });
    });
  }
}

function plinkoFrame() {
  plinkoRaf = null;
  drawPlinkoBoard();
}

function ensurePlinkoRaf() {
  if (plinkoRaf != null) return;
  plinkoRaf = requestAnimationFrame(plinkoFrame);
}

function drawPlinkoBoard() {
  const cc = plinkoCanvasContext();
  if (!cc) return;
  const { ctx, W, H } = cc;
  const refDrop = plinkoAnims[0]?.drop;
  const rows = refDrop?.rows || plinkoRows;
  const risk = refDrop?.risk || plinkoRisk;
  const payouts = plinkoPayouts(rows, risk);
  const layout = plinkoLayout(W, H, rows);
  const ballR = Math.max(7, Math.min(15, Math.min(layout.gapX, layout.gapY) * 0.5));
  const now = performance.now();
  const dt = plinkoLastFrameMs ? Math.min(0.05, (now - plinkoLastFrameMs) / 1000) : 0.016;
  plinkoLastFrameMs = now;

  drawPlinkoBackground(ctx, W, H);

  // Resolve every active ball's current position (skip ones still on stagger delay).
  const balls = [];
  const activeRows = new Set();
  const settling = [];
  for (const anim of plinkoAnims) {
    if (now < anim.startedAt) continue;
    const t = Math.min(1, (now - anim.startedAt) / anim.duration);
    const progress = t * (anim.nodes.length - 1);
    const seg = Math.min(anim.nodes.length - 2, Math.floor(progress));
    const local = progress - seg;
    const a = plinkoEase(local);
    const from = anim.nodes[seg];
    const to = anim.nodes[seg + 1];
    const x = from.x + (to.x - from.x) * a;
    const bounceH = Math.min(15, layout.gapY * 0.45);
    const y = from.y + (to.y - from.y) * a - Math.sin(local * Math.PI) * bounceH;
    const scale = 1 + Math.sin(local * Math.PI) * 0.07;
    activeRows.add(Math.min(rows, seg + 1));
    while (anim.hitIndex < seg) {
      anim.hitIndex += 1;
      const hit = anim.nodes[anim.hitIndex + 1];
      // Peg sparks only when the board isn't crowded — keeps big series smooth.
      if (hit && plinkoAnims.length <= 4) spawnPlinkoParticles(hit.x, hit.y, 'peg', 4);
    }
    anim.trail.push({ x, y });
    if (anim.trail.length > 26) anim.trail.shift();
    balls.push({ x, y, scale, active: !anim.completed });
    if (t >= 1 && !anim.completed) settling.push(anim);
  }

  let idleBall = null;
  if (!plinkoAnims.length) {
    const idle = layout.node(0, 0);
    idleBall = { x: idle.x, y: idle.y + Math.sin(Date.now() / 420) * 4, scale: 1 };
  }

  drawPlinkoBucketsCanvas(ctx, layout, rows, payouts, plinkoLastHitBucket);
  drawPlinkoPegs(ctx, layout, rows, activeRows.size ? activeRows : -1);

  for (const anim of plinkoAnims) {
    if (!anim.trail.length) continue;
    ctx.save();
    ctx.strokeStyle = 'rgba(245,158,11,.34)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    anim.trail.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    ctx.stroke();
    ctx.restore();
  }

  for (const b of balls) drawPlinkoBall(ctx, b.x, b.y, ballR * b.scale, b.active);
  if (idleBall) drawPlinkoBall(ctx, idleBall.x, idleBall.y, ballR * idleBall.scale, false);

  drawPlinkoParticles(ctx, dt);

  // Settle after drawing so the final frame paints first.
  settling.forEach(settlePlinkoAnim);

  if (plinkoAnims.length || plinkoParticles.length) ensurePlinkoRaf();
}

function stopPlinkoAnimation() {
  plinkoRunId += 1;
  if (plinkoRaf != null) { cancelAnimationFrame(plinkoRaf); plinkoRaf = null; }
  if (plinkoBatchTimer) {
    clearTimeout(plinkoBatchTimer);
    plinkoBatchTimer = null;
  }
  plinkoAnims = [];
  plinkoLastHitBucket = null;
  plinkoParticles = [];
  plinkoQueuedClicks = 0;
  plinkoServerPending = 0;
  plinkoDropQueue = [];
  document.querySelector('#tab-plinko .plinko-stage')?.classList.remove('is-dropping', 'is-win', 'is-jackpot');
  syncPlinkoBusy();
}

function setPlinkoResult(text, tone = '') {
  const result = document.getElementById('plinko-result');
  if (!result) return;
  result.className = 'plinko-result' + (tone ? ' ' + tone : '');
  result.textContent = text;
}

function settlePlinkoAnim(anim) {
  if (!anim || anim.completed) return;
  anim.completed = true;
  const drop = anim.drop;
  const net = Number(drop.totalWon || 0) - Number(drop.bet || 0);
  const jackpot = Number(drop.multiplier) >= 100;
  const end = anim.nodes[anim.nodes.length - 1];
  if (end) spawnPlinkoParticles(end.x, end.y, 'bucket', net > 0 ? 12 : 6);
  plinkoLastHitBucket = drop.bucket;
  if (!Array.isArray(plinkoDist) || plinkoDist.length !== Number(drop.rows) + 1) plinkoResetDist();
  plinkoDist[drop.bucket] = (plinkoDist[drop.bucket] || 0) + 1;
  plinkoSession.drops += 1;
  plinkoSession.wagered += Number(drop.bet || 0);
  plinkoSession.won += Number(drop.totalWon || 0);
  plinkoSession.best = Math.max(plinkoSession.best, Number(drop.multiplier || 0));
  renderPlinkoSession();
  renderPlinkoBuckets(drop.bucket);
  const stage = document.querySelector('#tab-plinko .plinko-stage');
  if (stage) {
    stage.classList.remove('is-win', 'is-jackpot');
    if (net > 0) stage.classList.add('is-win');
    if (jackpot) stage.classList.add('is-jackpot');
  }
  const tone = jackpot ? 'jackpot' : net > 0 ? 'win' : 'loss';
  const label = `${plinkoMultLabel(drop.multiplier)} → ${drop.totalWon} 🪙 (${net >= 0 ? '+' : ''}${net})`;
  setPlinkoResult(jackpot ? 'JACKPOT: ' + label : label, tone);
  // Throttle DOM win bursts so a big batch doesn't spawn dozens of emoji storms.
  if (jackpot || net >= 100) plinkoWinAnimation(net, jackpot);
  syncPlinkoBusy();
  renderPlinkoControls();
  setTimeout(() => {
    plinkoAnims = plinkoAnims.filter(a => a !== anim);
    if (!plinkoAnims.length && !plinkoDropQueue.length) {
      stage?.classList.remove('is-dropping');
    }
    syncPlinkoBusy();
    startNextPlinkoAnimation();
    renderPlinkoControls();
    ensurePlinkoRaf();
  }, plinkoReducedMotion() ? 90 : (plinkoDropQueue.length || plinkoAnims.length > 1 ? 160 : 700));
}

function plinkoWinAnimation(netWon, jackpot = false) {
  if (plinkoReducedMotion()) return;
  const container = document.createElement('div');
  container.className = 'plinko-burst-layer';
  const count = jackpot ? 72 : netWon >= 500 ? 46 : netWon >= 100 ? 30 : 16;
  const emojis = ['🪙', '🧾', '🧮', '☕', '📌', '✨'];
  for (let i = 0; i < count; i += 1) {
    const p = document.createElement('div');
    p.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    const size = 18 + Math.random() * (jackpot ? 30 : 22);
    p.style.cssText = `position:absolute;top:-52px;left:${Math.random()*100}%;font-size:${size}px;animation:casino-coinburst ${2.1+Math.random()*1.4}s linear ${Math.random()*0.45}s forwards`;
    container.appendChild(p);
  }
  document.body.appendChild(container);
  if (jackpot || netWon >= 500) document.body.style.animation = 'casino-shake .1s 6';
  setTimeout(() => { container.remove(); document.body.style.animation = ''; }, 3600);
}

function plinkoAnimationDuration(drop) {
  if (plinkoReducedMotion()) return 220;
  const rows = Number(drop?.rows || plinkoRows);
  const backlog = plinkoDropQueue.length + plinkoQueuedClicks + plinkoServerPending + plinkoAnims.length;
  // Slower base speed: 1000 + rows * 110 (approx. 2320ms for 12 rows)
  const base = 1000 + rows * 110;
  // Gentler speed-up factor under queue load
  const factor = backlog >= 24 ? 0.50 : backlog >= 12 ? 0.62 : backlog >= 4 ? 0.78 : 1;
  return Math.max(600, Math.round(base * factor));
}

function playPlinkoDrop(drop, delayMs = 0) {
  if (!drop) return;
  plinkoLastDropId = drop.id;
  const cc = plinkoCanvasContext();
  const built = cc ? plinkoPathNodes(drop, cc.W, cc.H) : { nodes: [] };
  plinkoAnims.push({
    drop,
    nodes: built.nodes,
    trail: [],
    hitIndex: -1,
    startedAt: performance.now() + delayMs,
    duration: plinkoAnimationDuration(drop),
    completed: false,
  });
  const stage = document.querySelector('#tab-plinko .plinko-stage');
  if (stage) {
    stage.classList.remove('is-win', 'is-jackpot');
    stage.classList.add('is-dropping');
  }
  syncPlinkoBusy();
  renderPlinkoControls();
  setPlinkoResult(plinkoDropQueue.length ? `Znaczniki spadają... w kolejce ${plinkoDropQueue.length}` : 'Znacznik spada przez tablicę...', '');
  ensurePlinkoRaf();
}

function startNextPlinkoAnimation() {
  let i = 0;
  while (plinkoAnims.length < PLINKO_MAX_CONCURRENT && plinkoDropQueue.length) {
    playPlinkoDrop(plinkoDropQueue.shift(), i * PLINKO_LAUNCH_STAGGER_MS);
    i += 1;
  }
  syncPlinkoBusy();
  ensurePlinkoRaf();
}

function schedulePlinkoBatch(immediate = false) {
  if (plinkoBatchTimer) {
    if (!immediate) return;
    clearTimeout(plinkoBatchTimer);
  }
  plinkoBatchTimer = setTimeout(flushPlinkoBatch, immediate ? 0 : PLINKO_BATCH_DELAY_MS);
}

async function flushPlinkoBatch() {
  plinkoBatchTimer = null;
  if (plinkoServerPending > 0) return;

  const count = Math.min(plinkoQueuedClicks, PLINKO_MAX_BATCH);
  if (count < 1) {
    syncPlinkoBusy();
    renderPlinkoControls();
    return;
  }

  const bet = plinkoBet;
  const rows = plinkoRows;
  const risk = plinkoRisk;
  const runId = plinkoRunId;
  plinkoQueuedClicks -= count;
  plinkoServerPending = count;
  syncPlinkoBusy();
  renderPlinkoControls();
  setPlinkoResult(count > 1 ? `Serwer liczy ${count} dropów...` : 'Serwer liczy tor dropu...', '');
  document.querySelector('#tab-plinko .plinko-stage')?.classList.remove('is-win', 'is-jackpot');

  try {
    const data = await invokePlinko({ action: count > 1 ? 'drop_batch' : 'drop', count, bet, rows, risk });
    plinkoServerPending = 0;
    applyPlinkoState(data);
    if (runId !== plinkoRunId || activeTab !== 'plinko') return;

    const drops = Array.isArray(data.drops) && data.drops.length
      ? data.drops
      : data.drop ? [data.drop] : [];
    if (drops.length) {
      plinkoDropQueue.push(...drops);
      startNextPlinkoAnimation();
    }
    if (data.warning) showToast('⚠️ ' + data.warning);
    if (!drops.length) setPlinkoResult(data.warning || 'Nie zwrócono żadnego dropu.', 'loss');
  } catch (err) {
    if (runId !== plinkoRunId || activeTab !== 'plinko') return;
    setPlinkoResult(err.message || 'Nie udało się wrzucić znacznika.', 'loss');
    showToast('❌ ' + err.message);
  } finally {
    if (runId !== plinkoRunId || activeTab !== 'plinko') return;
    plinkoServerPending = 0;
    if (plinkoQueuedClicks > 0) schedulePlinkoBatch(true);
    startNextPlinkoAnimation();
    syncPlinkoBusy();
    renderPlinkoControls();
    if (!plinkoBusy) loadPlinkoState(false);
  }
}

function startPlinkoDrop(n = 1) {
  const want = Math.max(1, Number(n) || 1);
  const room = PLINKO_MAX_VISIBLE_QUEUE - plinkoQueueTotal();
  if (room <= 0) {
    showToast('⏳ Poczekaj, aż kolejka Plinko się zmniejszy.');
    return;
  }
  const add = Math.min(want, room);
  plinkoQueuedClicks += add;
  syncPlinkoBusy();
  renderPlinkoControls();
  setPlinkoResult(plinkoQueueTotal() > 1 ? `Kolejka dropów: ${plinkoQueueTotal()}` : 'Serwer zaraz policzy drop...', '');
  schedulePlinkoBatch(plinkoQueuedClicks >= PLINKO_MAX_BATCH || add > 1);
}

(function wirePlinkoControls() {
  document.querySelectorAll('#plinko-rows-control button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (plinkoBusy) return;
      plinkoRows = Number(btn.dataset.rows);
      plinkoResetDist(); // bucket count changed — start a fresh distribution
      renderPlinko();
    });
  });
  document.querySelectorAll('#plinko-risk-control button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (plinkoBusy) return;
      plinkoRisk = btn.dataset.risk || 'medium';
      renderPlinko();
    });
  });
  const updatePlinkoCount = (val) => {
    plinkoCount = Math.max(1, Math.min(1000, Number(val) || 1));
    renderPlinkoControls();
  };
  document.getElementById('plinko-count-slider')?.addEventListener('input', (e) => updatePlinkoCount(e.target.value));
  document.getElementById('plinko-count-input')?.addEventListener('input', (e) => updatePlinkoCount(e.target.value));
  document.getElementById('plinko-count-input')?.addEventListener('blur', (e) => updatePlinkoCount(e.target.value));
  document.getElementById('plinko-drop-one')?.addEventListener('click', () => startPlinkoDrop(1));
  document.getElementById('plinko-drop-many')?.addEventListener('click', () => startPlinkoDrop(plinkoCount));
  document.getElementById('plinko-dist-reset')?.addEventListener('click', plinkoResetSession);
  document.getElementById('plinko-session-reset')?.addEventListener('click', plinkoResetSession);
  renderPlinkoSession();
  renderPlinkoBuckets();
})();

// ════════════════════════════════════════════════════════════════════════════
//  Koło Żubra G6 — SHARED ROUNDS: one communal wheel, everyone watches the
//  same spin. A round opens when the first player bets, runs a 15 s betting
//  window (round.spinAt from the server), then the server draws ONE segment
//  and pays every bet by its own stake × the shared segment multiplier. Coin timing follows the
//  roulette convention (charged at resolve, not at bet time); resolution is
//  lazy-on-read crash-style, so the 1 s `state` poll below is what actually
//  fires a due spin — do not remove it in favor of realtime alone.
// ════════════════════════════════════════════════════════════════════════════

function wheelNow() { return Date.now() + wheelClockOffsetMs; }

// 0.5x and 1x get their own wording per the design brief: 1x is just the
// stake coming back ("ZWROT"), 0.5x is a half-stake consolation ("×0,5").
// 10x (jackpot) carries a tiny 🦬 in its label per the Żubrówka theme.
function wheelMultLabel(value) {
  const n = Number(value || 0);
  if (n === 1) return 'ZWROT';
  if (n === 0.5) return '×0,5';
  if (n >= 100 || Number.isInteger(n)) return '×' + String(n);
  return '×' + n.toFixed(n < 1 ? 2 : 1).replace(/\.0$/, '');
}

// Żubrówka (bison-grass vodka) palette: 0x is deep bottle green (bust), 0.5x
// a dried-straw/hay tone (consolation), 1x a pale meadow green (stake back),
// 2x the vivid bison-grass chartreuse, and 10x molten gold (drawWheelBoard
// paints anything flagged `hot` with a radial glow instead of a flat fill).
function wheelColorFor(mult) {
  const n = Number(mult);
  if (n === 0)   return { fill: '#1b4d2e', text: '#dcefdc', hot: false };
  if (n === 0.5) return { fill: '#c9a24b', text: '#3d2c05', hot: false };
  if (n === 1)   return { fill: '#b7d98c', text: '#2f4a1a', hot: false };
  if (n >= 10)   return { fill: '#f5b301', text: '#3d2c05', hot: true };
  if (n >= 2)    return { fill: '#9fb832', text: '#1f2b06', hot: false };
  return { fill: '#334155', text: '#e2e8f0', hot: false };
}

function wheelHasMyBet() {
  return !!(wheelRound?.status === 'betting' && me && wheelBets.some(b => b.userId === me.id));
}

function wheelMyBet() {
  return (me && wheelBets.find(b => b.userId === me.id)) || null;
}

async function invokeWheel(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHEEL_REQUEST_TIMEOUT_MS);
  try {
    const { data: authData } = await sb.auth.getSession();
    const token = authData?.session?.access_token || SUPABASE_ANON_KEY;
    const response = await fetch(`${SUPABASE_URL}/functions/v1/wheel-action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!response.ok) throw new Error(data?.error || `Błąd Koła Żubra (${response.status}).`);
    if (!data || data.ok === false) throw new Error(data?.error || 'Błąd Koła Żubra.');
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Serwer Koła Żubra nie odpowiedział przez 12 s. Spróbuj ponownie.');
    }
    throw err instanceof Error ? err : new Error('Błąd połączenia z Kołem Żubra.');
  } finally {
    clearTimeout(timer);
  }
}

async function loadWheelState(showToastOnError = true) {
  try {
    const data = await invokeWheel({ action: 'state' });
    applyWheelState(data);
  } catch (err) {
    if (showToastOnError) showToast('❌ ' + err.message);
    renderWheel();
  }
}

function applyWheelState(data) {
  wheelLastStateMs = Date.now();
  wheelState = data;
  if (data.serverNow) wheelClockOffsetMs = Date.parse(data.serverNow) - Date.now();
  wheelRound = data.round || null;
  wheelBets = Array.isArray(data.bets) ? data.bets : [];
  wheelRecentRounds = Array.isArray(data.recentRounds) ? data.recentRounds : [];
  wheelCasinoLuck = !!data.casinoLuck;
  wheelCasinoLuckUntil = data.casinoLuckUntil || null;
  if (Array.isArray(data.history)) wheelHistory = data.history;
  if (typeof data.coins === 'number' && me) {
    me.coins = data.coins;
    setText(headerCoins, me.coins);
  }
  renderWheel();
}

// Persistent gold chip near the controls, shown only while the communal
// Keep the shared amulet card in sync with wheel-action's authoritative status.
function renderWheelLuckChip() {
  casinoLuckGlobalUntil = wheelCasinoLuck && wheelCasinoLuckUntil ? wheelCasinoLuckUntil : null;
  casinoLuckStatusLoadedAt = Date.now();
  renderCasinoLuckBanners();
}

function setWheelResult(text, tone = '') {
  const result = document.getElementById('wheel-result');
  if (!result) return;
  result.className = 'wheel-result plinko-result' + (tone ? ' ' + tone : '');
  result.textContent = text;
}

function renderWheel() {
  renderWheelControls();
  renderWheelLuckChip();
  renderWheelSession();
  renderWheelBetsList();
  renderWheelRecentRounds();
  renderWheelHistory();
  renderWheelPayoutTables();
  startWheelRaf();
  if (!wheelResizeBound) {
    wheelResizeBound = true;
    window.addEventListener('resize', () => { if (activeTab === 'wheel') drawWheelBoard(); });
  }
}

function renderWheelControls() {
  const iBet = wheelHasMyBet();
  const mine = wheelMyBet();
  const isReady = iBet && !!mine?.ready;
  const disabled = wheelBetBusy || wheelReadyBusy || iBet;
  document.querySelectorAll('[data-bet="wheel"] .casino-chip').forEach(btn => {
    btn.disabled = disabled;
    btn.classList.toggle('active', Number(btn.dataset.stake) === wheelBet);
  });
  setBetBarDisabled('wheel', disabled);
  syncBetBar('wheel', wheelBet, { keepInput: true });
  const spinBtn = document.getElementById('wheel-spin-btn');
  if (spinBtn) {
    spinBtn.disabled = wheelBetBusy || wheelReadyBusy || !me || (iBet ? isReady : Number(me.coins || 0) < wheelBet);
    if (wheelBetBusy) spinBtn.innerHTML = 'Stawiamy…';
    else if (wheelReadyBusy) spinBtn.innerHTML = 'Zgłaszam gotowość…';
    else if (isReady) spinBtn.innerHTML = '✅ GOTOWY · CZEKAMY NA INNYCH';
    else if (iBet) spinBtn.innerHTML = '⚡ JESTEM GOTOWY · KRĘĆMY';
    else spinBtn.innerHTML = `POSTAW · ${wheelBet} 🪙`;
  }
  const myBetChip = document.getElementById('wheel-my-bet');
  if (myBetChip) {
    if (mine && wheelRound?.status === 'betting') {
      myBetChip.classList.remove('hidden');
      myBetChip.textContent = `${isReady ? '⚡ Gotowy' : '✅ Zakład przyjęty'}: ${mine.bet} 🪙`;
    } else {
      myBetChip.classList.add('hidden');
    }
  }
}

function renderWheelSession() {
  const box = document.getElementById('wheel-session');
  if (!box) return;
  const s = wheelSession;
  const net = s.won - s.wagered;
  box.replaceChildren(
    plinkoStatCell('Rund', String(s.spins)),
    plinkoStatCell('Najlepszy', s.best ? wheelMultLabel(s.best) : '—'),
    plinkoStatCell('Postawiono', `${s.wagered} 🪙`),
    plinkoStatCell('Wygrano', `${s.won} 🪙`),
    plinkoStatCell('Bilans sesji', `${net >= 0 ? '+' : ''}${net} 🪙`, net > 0 ? 'pos' : net < 0 ? 'neg' : '', true)
  );
}

function wheelResetSession() {
  wheelSession = { spins: 0, wagered: 0, won: 0, best: 0 };
  renderWheelSession();
}

function wheelIsJackpot(mult) { return Number(mult || 0) >= 10; }

// Live "everyone's bets this round" panel — communal, updates as players
// join (poll/realtime) and gains a per-row result once the round resolves.
function renderWheelBetsList() {
  const box = document.getElementById('wheel-bets-list');
  if (!box) return;
  if (!wheelRound || !wheelBets.length) {
    box.replaceChildren(el('p', { style: { color: 'var(--muted)', fontSize: '12px', margin: 0 } }, 'Czekamy na pierwszy zakład…'));
    return;
  }
  const resolved = wheelRound.status === 'resolved';
  box.replaceChildren(...wheelBets.map(b => {
    const cls = ['wheel-bet-row'];
    if (me && b.userId === me.id) cls.push('is-mine');
    let resultNode = null;
    if (resolved) {
      const won = Number(b.totalWon || 0);
      const net = won - Number(b.bet || 0);
      cls.push(wheelIsJackpot(b.multiplier) ? 'is-jackpot' : net > 0 ? 'is-win' : net === 0 ? 'is-flat' : 'is-loss');
      resultNode = el('span', { className: 'wbr-result' }, `${wheelMultLabel(b.multiplier)} · ${net >= 0 ? '+' : ''}${net} 🪙`);
    } else if (b.ready) {
      resultNode = el('span', { className: 'wbr-result' }, '⚡ GOTOWY');
    }
    return el('div', { className: cls.join(' ') },
      el('span', { className: 'wbr-nick' }, b.nick),
      el('span', { className: 'wbr-stake' }, `${b.bet} 🪙`),
      ...(resultNode ? [resultNode] : [])
    );
  }));
}

// Communal "Ostatnie rundy" strip — the sector that hit + biggest winner.
function renderWheelRecentRounds() {
  const box = document.getElementById('wheel-recent-rounds');
  if (!box) return;
  if (!wheelRecentRounds.length) {
    box.replaceChildren(el('p', { style: { color: 'var(--muted)', fontSize: '12px', margin: 0 } }, 'Brak rund.'));
    return;
  }
  box.replaceChildren(...wheelRecentRounds.map(r => {
    return el('div', { className: 'wheel-round-chip' },
      el('span', { className: 'wrc-seg' }, `#${Number(r.segmentIndex) + 1}`),
      r.winnerNick
        ? el('span', { className: 'wrc-winner' }, `🏆 ${r.winnerNick} +${r.winnerWon} 🪙`)
        : el('span', { className: 'wrc-winner is-muted' }, '—')
    );
  }));
}

function renderWheelHistory() {
  const box = document.getElementById('wheel-history');
  if (!box) return;
  if (!wheelHistory.length) {
    box.replaceChildren(el('p', { style: { color: 'var(--muted)', fontSize: '12px', margin: 0 } }, 'Brak zakręceń.'));
    return;
  }
  box.replaceChildren(...wheelHistory.slice(0, 12).map(h => {
    const bet = Number(h.bet || 0);
    const won = Number(h.totalWon || 0);
    const net = won - bet;
    const jackpot = wheelIsJackpot(h.multiplier);
    const tone = jackpot ? 'jackpot' : net > 0 ? 'win' : net === 0 ? 'flat' : 'loss';
    return el('div', { className: 'plinko-hrow ' + tone },
      el('div', { className: 'ph-mult' }, wheelMultLabel(h.multiplier)),
      el('div', { className: 'ph-mid' }, `${bet} 🪙`),
      el('div', { className: 'ph-net' }, `${net >= 0 ? '+' : ''}${net} 🪙`)
    );
  }));
}

// Single shared payout table — one wheel, one segment set, no risk tiers.
function renderWheelPayoutTables() {
  const box = document.getElementById('wheel-payout-tables');
  if (!box) return;
  const counts = {};
  WHEEL_SEGMENTS.forEach(m => { counts[m] = (counts[m] || 0) + 1; });
  const rtpPct = Math.round(WHEEL_RTP * 1000) / 10;
  const chips = Object.keys(counts).map(Number).sort((a, b) => a - b).map(mult =>
    el('span', { className: 'wheel-payout-chip' + (mult === 0 ? ' is-zero' : '') + (wheelIsJackpot(mult) ? ' is-hot' : '') },
      `${wheelMultLabel(mult)} ×${counts[mult]}`)
  );
  box.replaceChildren(
    el('div', { className: 'wheel-payout-table' },
      el('div', { className: 'wheel-payout-table-head' },
        el('span', {}, 'Koło Żubra G6'),
        el('span', { className: 'wpt-rtp' }, `RTP ${rtpPct}%`)
      ),
      el('div', { className: 'wheel-payout-rows' }, ...chips)
    )
  );
}

function wheelCanvasContext() {
  const canvas = document.getElementById('wheel-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  // The buffer matches the element's actual (possibly non-square) CSS box and
  // the wheel is letterboxed inside it — a square buffer on a stretched
  // element renders the wheel as an oval.
  const w = Math.max(240, Math.round(rect.width || canvas.clientWidth || 480));
  const h = Math.max(240, Math.round(rect.height || canvas.clientHeight || 480));
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.round(w * DPR), ph = Math.round(h * DPR);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  return { canvas, ctx, w, h, size: Math.min(w, h) };
}

// One wheel, one segment set, no risk tiers — the whole visual budget goes
// into a single ring: big bezel, prize-only radial labels, and the
// LED/glow/pointer-kick treatment. `highlightIndex` (the resolved round's
// segment, or null) flashes the winning wedge and dims the rest.
function drawWheelBoard(rotation = wheelBoardRotation) {
  const cc = wheelCanvasContext();
  if (!cc) return;
  const { ctx, w, h, size } = cc;
  const cx = w / 2, cy = h / 2;
  const r = size / 2 - 10;
  const segAngle = (Math.PI * 2) / WHEEL_SEGMENT_COUNT;
  const twoPi = Math.PI * 2;
  const nowMs = performance.now();
  const phase = wheelPhaseAnim;
  const highlightIndex = (phase === 'result' && wheelRound && wheelRound.segmentIndex != null)
    ? Number(wheelRound.segmentIndex) : null;

  ctx.clearRect(0, 0, w, h);

  // The wheel is letterboxed inside a possibly non-square canvas, so the
  // DOM pointer pin must track the actual rim, not the stage top.
  const pointerEl = document.querySelector('#tab-wheel .wheel-pointer');
  if (pointerEl) {
    const topPx = Math.round(cc.canvas.offsetTop + (cy - r) - 14);
    if (wheelPointerTop !== topPx) {
      wheelPointerTop = topPx;
      pointerEl.style.top = topPx + 'px';
    }
  }

  const hubR = r * 0.20;
  const ringR0 = hubR + r * 0.02;
  const ringR1 = r * 0.94;

  // Decorative dark bezel behind the ring, so the segments read as an inset
  // wheel rather than floating flat on the stage background.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, twoPi);
  ctx.fillStyle = '#0c2416';
  ctx.fill();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);

  for (let i = 0; i < WHEEL_SEGMENTS.length; i += 1) {
    const mult = WHEEL_SEGMENTS[i];
    const start = -Math.PI / 2 + i * segAngle - segAngle / 2;
    const end = start + segAngle;
    const isHighlight = highlightIndex === i;
    const color = wheelColorFor(mult);

    ctx.beginPath();
    ctx.moveTo(Math.cos(start) * ringR0, Math.sin(start) * ringR0);
    ctx.arc(0, 0, ringR1, start, end);
    ctx.arc(0, 0, ringR0, end, start, true);
    ctx.closePath();

    if (color.hot) {
      const mid = start + segAngle / 2;
      const midR = (ringR0 + ringR1) / 2;
      const grad = ctx.createRadialGradient(
        Math.cos(mid) * midR, Math.sin(mid) * midR, 2,
        Math.cos(mid) * midR, Math.sin(mid) * midR, ringR1 - ringR0
      );
      grad.addColorStop(0, '#fff7ed');
      grad.addColorStop(0.45, color.fill);
      grad.addColorStop(1, '#a16207');
      ctx.fillStyle = grad;
    } else if (mult === 0) {
      // Alternate two bottle-green shades so adjacent zero wedges read as
      // separate segments instead of one dark blob.
      ctx.fillStyle = i % 2 ? '#16412a' : '#1b4d2e';
    } else {
      ctx.fillStyle = color.fill;
    }
    if (isHighlight) { ctx.shadowColor = '#facc15'; ctx.shadowBlur = 30; }
    else if (highlightIndex != null) { ctx.globalAlpha = 0.32; }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(212,175,55,.55)'; // brass/gold metallic separators
    ctx.stroke();

    // Prize labels only — the 12 zero segments stay quiet dark wedges, which
    // is what keeps the wheel readable. Text runs along the radius reading
    // outward, fixed to the wheel like a physical prize wheel (one uniform
    // rule for every label; no per-frame screen-space flipping, which made
    // orientations disagree and jump mid-spin).
    if (mult > 0) {
      const mid = start + segAngle / 2;
      const isJackpot = mult >= 10;
      ctx.save();
      ctx.rotate(mid);
      ctx.fillStyle = color.text;
      const label = wheelMultLabel(mult);
      const fontScale = isJackpot ? 0.06 : label.length > 3 ? 0.038 : 0.054;
      ctx.font = '800 ' + Math.max(11, Math.round(size * fontScale)) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = (highlightIndex != null && !isHighlight) ? 0.4 : 1;
      ctx.fillText(label, ringR0 + (ringR1 - ringR0) * (isJackpot ? 0.36 : 0.55), 0);
      if (isJackpot) {
        ctx.font = Math.round(size * 0.052) + 'px system-ui, sans-serif';
        ctx.fillText('🦬', ringR0 + (ringR1 - ringR0) * 0.75, 0);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }
  ctx.restore();

  // Gold bezel ring framing the segments.
  ctx.beginPath();
  ctx.arc(cx, cy, ringR1, 0, twoPi);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(250,204,21,.5)';
  ctx.stroke();

  // LED bulb ring around the rim: idle-pulses slowly, and CHASES (marquee)
  // during a blind/landing spin — driven purely by `rotation`/`nowMs`, no
  // extra timers.
  const ledCount = 40;
  const ledR = r * 0.985;
  const spinning = phase === 'blind' || phase === 'landing';
  for (let i = 0; i < ledCount; i += 1) {
    const a = (i / ledCount) * twoPi - Math.PI / 2;
    const x = cx + Math.cos(a) * ledR, y = cy + Math.sin(a) * ledR;
    let bright = spinning
      ? 0.4 + 0.6 * Math.sin(a * 3 - rotation * 4)
      : 0.32 + 0.32 * Math.sin(nowMs / 900 + i * 0.5);
    bright = Math.max(0.12, bright);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, r * 0.016), 0, twoPi);
    ctx.fillStyle = `rgba(250,204,21,${bright.toFixed(2)})`;
    ctx.shadowColor = 'rgba(250,204,21,.9)';
    ctx.shadowBlur = 7 * bright;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Center hub: dark bottle-green disc + a single tapered blade of grass
  // laid diagonally across it (the classic żubrówka-bottle motif) + gold
  // rim + a 🦬 mark.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, twoPi);
  ctx.clip();
  const hubGrad = ctx.createRadialGradient(cx, cy, 1, cx, cy, hubR);
  hubGrad.addColorStop(0, '#1b4d2e');
  hubGrad.addColorStop(1, '#0c2416');
  ctx.fillStyle = hubGrad;
  ctx.fillRect(cx - hubR, cy - hubR, hubR * 2, hubR * 2);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 5);
  const bladeLen = hubR * 1.9, bladeW = hubR * 0.16;
  const bladeGrad = ctx.createLinearGradient(-bladeLen / 2, 0, bladeLen / 2, 0);
  bladeGrad.addColorStop(0, '#3f6212');
  bladeGrad.addColorStop(0.5, '#d9f2c4');
  bladeGrad.addColorStop(1, '#8fae3a');
  ctx.fillStyle = bladeGrad;
  ctx.beginPath();
  ctx.moveTo(-bladeLen / 2, 0);
  ctx.quadraticCurveTo(0, -bladeW, bladeLen / 2, 0);
  ctx.quadraticCurveTo(0, bladeW, -bladeLen / 2, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, twoPi);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#facc15';
  ctx.stroke();

  // The bison is the hub medallion — sized to nearly fill the hub so the
  // blade of grass peeks out on both sides behind it.
  ctx.font = Math.max(18, Math.round(hubR * 1.15)) + 'px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🦬', cx, cy + hubR * 0.04);
}

function wheelWinAnimation(netWon, jackpot = false) {
  if (plinkoReducedMotion()) return;
  const container = document.createElement('div');
  container.className = 'plinko-burst-layer';
  const count = jackpot ? 72 : netWon >= 500 ? 46 : netWon >= 100 ? 30 : 16;
  const emojis = ['🪙', '🎉', '✨', '💰', '🦬', '⭐'];
  for (let i = 0; i < count; i += 1) {
    const p = document.createElement('div');
    p.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    const size = 18 + Math.random() * (jackpot ? 30 : 22);
    p.style.cssText = `position:absolute;top:-52px;left:${Math.random() * 100}%;font-size:${size}px;animation:casino-coinburst ${2.1 + Math.random() * 1.4}s linear ${Math.random() * 0.45}s forwards`;
    container.appendChild(p);
  }
  document.body.appendChild(container);
  if (jackpot || netWon >= 500) document.body.style.animation = 'casino-shake .1s 6';
  setTimeout(() => { container.remove(); document.body.style.animation = ''; }, 3600);
}

// Cosmetic "kick" impulse on the pointer pin each time a segment separator
// passes underneath it — purely visual, computed from the rotation delta.
function wheelMaybeKickPointer(rotation) {
  const segAngle = (Math.PI * 2) / WHEEL_SEGMENT_COUNT;
  const bucket = Math.floor((((rotation % (Math.PI * 2)) + Math.PI * 4)) / segAngle);
  if (wheelLastSegBucket !== null && bucket !== wheelLastSegBucket) {
    const pointer = document.querySelector('#tab-wheel .wheel-pointer');
    if (pointer) { pointer.classList.remove('kick'); void pointer.offsetWidth; pointer.classList.add('kick'); }
  }
  wheelLastSegBucket = bucket;
}

// Begins the ease-out-cubic landing tween into the resolved round's exact
// segment. If we were already blind-spinning this round, only a couple of
// extra turns are needed to decelerate into place; if the result arrived
// already known (tab loaded mid-spin, or a poll caught the resolve before
// the countdown ever hit zero locally), play the full multi-turn reveal
// spin like the old solo mode. Whole-turn math is load-bearing here — the
// extraTurns*twoPi term must vanish exactly under mod twoPi, or its
// fractional part leaks into the landing angle and the wheel stops short
// of (or past) the target segment.
function wheelBeginLanding(round) {
  const reduced = plinkoReducedMotion();
  wheelLandingRoundId = round.id;
  const duration = reduced ? 300 : WHEEL_LANDING_DURATION_MS;
  const segAngle = (Math.PI * 2) / WHEEL_SEGMENT_COUNT;
  const twoPi = Math.PI * 2;
  const normalizedTarget = (((-round.segmentIndex * segAngle) % twoPi) + twoPi * 2) % twoPi;
  const from = wheelBoardRotation;
  const currentMod = ((from % twoPi) + twoPi * 2) % twoPi;
  const delta = (((normalizedTarget - currentMod) % twoPi) + twoPi * 2) % twoPi;
  const wasBlind = wheelBlindRoundId === round.id;
  const extraTurns = reduced ? 0 : (wasBlind ? (1 + Math.floor(Math.random() * 2)) : (4 + Math.floor(Math.random() * 3)));
  wheelLandingFrom = from;
  wheelLandingTo = from + extraTurns * twoPi + delta;
  wheelLandingStart = performance.now();
  wheelLandingDur = duration;
  document.querySelector('#tab-wheel .wheel-stage')?.classList.add('is-spinning');
}

// Advances the animation state machine one frame: idle (no round) →
// countdown (betting, spin_at in the future) → blind (spin_at passed,
// server hasn't drawn yet — constant-velocity spin) → landing (segment
// known — eased tween) → result (landed, static). Reduced motion skips the
// blind spin/LED chase entirely and jumps straight to a short 300 ms settle.
function wheelUpdateAnimState(nowP, dt) {
  const round = wheelRound;
  if (!round) { wheelPhaseAnim = 'idle'; return; }
  const reduced = plinkoReducedMotion();

  if (round.status === 'betting') {
    const spinAtMs = Date.parse(round.spinAt);
    if (wheelNow() < spinAtMs) { wheelPhaseAnim = 'countdown'; return; }
    if (reduced) { wheelPhaseAnim = 'countdown'; return; } // no blind spin/chase in reduced motion
    wheelBlindRoundId = round.id;
    wheelPhaseAnim = 'blind';
    wheelBoardRotation += WHEEL_BLIND_SPEED * dt;
    return;
  }

  // status === 'resolved'
  if (wheelLandedRoundId === round.id) { wheelPhaseAnim = 'result'; return; }
  if (wheelLandingRoundId !== round.id) wheelBeginLanding(round);
  wheelPhaseAnim = 'landing';
  const t = Math.min(1, (nowP - wheelLandingStart) / wheelLandingDur);
  const eased = 1 - Math.pow(1 - t, 3);
  wheelBoardRotation = wheelLandingFrom + (wheelLandingTo - wheelLandingFrom) * eased;
  if (t >= 1) {
    wheelLandedRoundId = round.id;
    wheelPhaseAnim = 'result';
    wheelOnLanded(round);
  }
}

// Called exactly once per round, the instant its landing tween completes:
// applies the personal result banner + session tally + coinburst, and
// refreshes the communal bets/recent-rounds panels to show every winner.
function wheelOnLanded(round) {
  document.querySelector('#tab-wheel .wheel-stage')?.classList.remove('is-spinning');
  if (wheelResultShownFor === round.id) return;
  wheelResultShownFor = round.id;

  const stage = document.querySelector('#tab-wheel .wheel-stage');
  stage?.classList.remove('is-win', 'is-jackpot');
  const mine = wheelMyBet();
  if (mine && mine.totalWon != null) {
    const bet = Number(mine.bet || 0);
    const won = Number(mine.totalWon || 0);
    const net = won - bet;
    const jackpot = wheelIsJackpot(mine.multiplier);
    wheelSession.spins += 1;
    wheelSession.wagered += bet;
    wheelSession.won += won;
    wheelSession.best = Math.max(wheelSession.best, Number(mine.multiplier || 0));
    const tone = jackpot ? 'jackpot' : net > 0 ? 'win' : net === 0 ? 'flat' : 'loss';
    const label = `${wheelMultLabel(mine.multiplier)} → ${won} 🪙 (${net >= 0 ? '+' : ''}${net})`;
    setWheelResult(jackpot ? 'JACKPOT: ' + label : label, tone);
    if (jackpot) stage?.classList.add('is-jackpot');
    else if (net > 0) stage?.classList.add('is-win');
    if (jackpot || net >= 100) wheelWinAnimation(net, jackpot);
  } else {
    setWheelResult('Runda rozstrzygnięta — dołącz do następnej!', '');
  }
  renderWheelSession();
  renderWheelBetsList();
  renderWheelRecentRounds();
  renderWheelHistory();
  renderWheelControls();
}

function updateWheelCountdownUI() {
  const box = document.getElementById('wheel-countdown');
  if (!box) return;
  const round = wheelRound;
  if (!round || round.status !== 'betting') { box.classList.add('hidden'); box.classList.remove('is-big'); return; }
  box.classList.remove('hidden');
  const remain = Math.max(0, Date.parse(round.spinAt) - wheelNow());
  if (remain <= 0) {
    box.classList.remove('is-big');
    box.textContent = 'LOSOWANIE…';
    return;
  }
  const totalSec = remain / 1000;
  if (totalSec < 5) {
    box.classList.add('is-big');
    box.textContent = String(Math.ceil(totalSec));
  } else {
    box.classList.remove('is-big');
    const m = Math.floor(totalSec / 60);
    const s = Math.floor(totalSec % 60);
    const d = Math.floor((totalSec - Math.floor(totalSec)) * 10);
    box.textContent = `${m}:${String(s).padStart(2, '0')}.${d}`;
  }
}

function wheelFrame(nowP) {
  if (!wheelRafActive) return;
  const dt = Math.min(0.1, (nowP - (wheelLastFrameAt || nowP)) / 1000);
  wheelLastFrameAt = nowP;
  wheelUpdateAnimState(nowP, dt);
  wheelMaybeKickPointer(wheelBoardRotation);
  drawWheelBoard(wheelBoardRotation);
  updateWheelCountdownUI();
  wheelRaf = requestAnimationFrame(wheelFrame);
}

function startWheelRaf() {
  if (wheelRafActive) return;
  wheelRafActive = true;
  wheelLastFrameAt = performance.now();
  wheelRaf = requestAnimationFrame(wheelFrame);
}

function stopWheelRaf() {
  wheelRafActive = false;
  if (wheelRaf != null) { cancelAnimationFrame(wheelRaf); wheelRaf = null; }
}

// Lazy-resolve poll: while a round is open (betting, whether or not spin_at
// has already passed), pull `state` every second so the server has a chance
// to resolve it on read. This is what actually fires a due spin — realtime
// alone only tells us something changed, it never drives the resolve.
function startWheelPoll() {
  stopWheelPoll();
  wheelPollTimer = setInterval(() => {
    if (activeTab !== 'wheel') return;
    if (document.hidden) return;
    if (!wheelRound || wheelRound.status !== 'betting') return;
    loadWheelState(false);
  }, 1000);
}

function stopWheelPoll() {
  if (wheelPollTimer) clearInterval(wheelPollTimer);
  wheelPollTimer = null;
}

function setupWheelRealtime() {
  if (wheelRealtimeReady) return;
  wheelRealtimeReady = true;
  const reload = () => {
    if (activeTab !== 'wheel') return;
    if (Date.now() - wheelLastStateMs < 900) return;
    loadWheelState(false);
  };
  const ch = sb.channel('wheel-db-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'wheel_rounds' }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'wheel_round_bets' }, reload)
    .subscribe();
  realtimeChannels.push(ch);
}

function stopWheelAnimation() {
  stopWheelRaf();
  stopWheelPoll();
  document.querySelector('#tab-wheel .wheel-stage')?.classList.remove('is-spinning', 'is-win', 'is-jackpot');
}

async function placeWheelBet() {
  if (wheelBetBusy || wheelReadyBusy) return;
  if (!me) { showToast('❌ Zaloguj się.'); return; }
  if (wheelHasMyBet()) { showToast('Już postawiłeś w tej rundzie.'); return; }
  const bet = wheelBet;
  if (bet > Number(me.coins || 0)) { showToast('❌ Za mało coinów!'); return; }
  wheelBetBusy = true;
  renderWheelControls();

  let data;
  try {
    data = await invokeWheel({ action: 'bet', bet });
  } catch (err) {
    wheelBetBusy = false;
    renderWheelControls();
    showToast('❌ ' + err.message);
    return;
  }

  wheelBetBusy = false;
  applyWheelState(data);
  if (wheelRound?.status === 'betting') {
    setWheelResult(`Zakład przyjęty — losowanie za ${Math.max(0, Math.round((Date.parse(wheelRound.spinAt) - wheelNow()) / 1000))} s…`, '');
  }
}

async function markWheelReady() {
  if (wheelBetBusy || wheelReadyBusy) return;
  if (!me) { showToast('❌ Zaloguj się.'); return; }
  const mine = wheelMyBet();
  if (!wheelHasMyBet() || !mine) { showToast('Najpierw postaw zakład.'); return; }
  if (mine.ready) return;

  wheelReadyBusy = true;
  renderWheelControls();
  try {
    const data = await invokeWheel({ action: 'ready' });
    applyWheelState(data);
    const waiting = wheelBets.filter(b => !b.ready).length;
    if (waiting === 0) {
      setWheelResult('⚡ Wszyscy gotowi — przyspieszamy losowanie!', '');
    } else {
      setWheelResult(`Gotowy — czekamy jeszcze na ${waiting} ${waiting === 1 ? 'osobę' : 'osoby'}…`, '');
    }
  } catch (err) {
    showToast('❌ ' + err.message);
  } finally {
    wheelReadyBusy = false;
    renderWheelControls();
  }
}

(function wireWheelControls() {
  document.getElementById('wheel-spin-btn')?.addEventListener('click', () => {
    if (wheelHasMyBet()) markWheelReady();
    else placeWheelBet();
  });
  document.getElementById('wheel-session-reset')?.addEventListener('click', wheelResetSession);
  renderWheelSession();
})();
