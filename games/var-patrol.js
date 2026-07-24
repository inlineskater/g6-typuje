// ── VAR Patrol (offside judgement; canvas + verdict buttons) ───
// The server issues an offside-only scenario schedule and validates answer
// timing/correctness on submit. Local stats are cosmetic; the server score wins.
const VP_REACTION_FLOOR_MS = 120; // mirror VAR_REACTION_FLOOR_MS in var-patrol-action
const VP_REACTION_TOL_MS = 220;   // mirror VAR_REACTION_TOL_MS in var-patrol-action
const VP_ROUND_MS = 60000;
const VP_CLIP_MS = 850;
const VP_FEEDBACK_MS = 1500;

function newVarPatrolRuntime() {
  return {
    playing: false,
    submitting: false,
    archiveMode: false,
    roundId: null,
    schedule: [],
    idx: -1,
    durationMs: VP_ROUND_MS,
    roundStartedAt: 0,
    timeRemainingMs: VP_ROUND_MS,
    correct: 0,
    wrong: 0,
    streak: 0,
    maxStreak: 0,
    scenarioShownAt: 0,
    windowMs: 0,
    answers: [],
    timer: null,
    locked: false,
    phase: 'idle',
    phaseStartedAt: 0,
    feedback: null,
  };
}

async function invokeVarPatrol(payload) {
  const { data, error } = await sb.functions.invoke('var-patrol-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć z VAR Patrol.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Błąd VAR Patrol.');
  return data;
}

// Correct verdict index (0/1) derived from the scene — must mirror makeScenario()
// in var-patrol-action. Used only for cosmetic feedback + live stats.
function vpCorrectAnswer(scenario) {
  const s = scenario.scene || {};
  switch (scenario.type) {
    case 'offside':  return s.attackerX > s.defenderX ? 0 : 1;
    case 'foul':     return s.foul ? 0 : 1;
    case 'handball': return s.handball ? 0 : 1;
    case 'goalline': return s.goal ? 0 : 1;
    default:         return 0;
  }
}

const VP_TITLES = { offside: 'A PO PRAWEJ?', foul: 'FAUL?', handball: 'RĘKA?', goalline: 'GOL?' };
const VP_PHASE_LABELS = { clip: 'POWTÓRKA', decision: 'STOP-KLATKA', feedback: 'WERDYKT' };

let vpCtx = null;
function vpInitCanvas() {
  const canvas = document.getElementById('vp-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round((rect.width || 480) * DPR);
  const h = Math.round((rect.height || 270) * DPR);
  if (canvas.width !== w || canvas.height !== h || !vpCtx) {
    canvas.width = w;
    canvas.height = h;
    vpCtx = canvas.getContext('2d');
  }
  return vpCtx;
}

function vpClamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function vpLerp(a, b, t) {
  return a + (b - a) * vpClamp(t, 0, 1);
}

function vpRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function vpFitText(ctx, text, x, y, maxWidth, size, weight = 700) {
  let fontSize = size;
  do {
    ctx.font = `${weight} ${Math.round(fontSize)}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth || fontSize <= 10) break;
    fontSize -= 1;
  } while (fontSize > 10);
  ctx.fillText(text, x, y);
}

function vpDrawPitch(ctx, x, y, w, h) {
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, '#237a3b');
  grad.addColorStop(1, '#155f2c');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.045)' : 'rgba(0,0,0,.045)';
    ctx.fillRect(x + (w / 10) * i, y, w / 10, h);
  }

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.58)';
  ctx.lineWidth = Math.max(1.5, h * 0.008);
  ctx.strokeRect(x + w * 0.018, y + h * 0.045, w * 0.964, h * 0.91);
  ctx.beginPath();
  ctx.moveTo(x + w * 0.5, y + h * 0.045);
  ctx.lineTo(x + w * 0.5, y + h * 0.955);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + w * 0.5, y + h * 0.5, h * 0.16, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = Math.max(1, h * 0.006);
  ctx.strokeRect(x + w * 0.018, y + h * 0.22, w * 0.17, h * 0.56);
  ctx.strokeRect(x + w * 0.812, y + h * 0.22, w * 0.17, h * 0.56);
  ctx.strokeRect(x + w * 0.018, y + h * 0.36, w * 0.07, h * 0.28);
  ctx.strokeRect(x + w * 0.912, y + h * 0.36, w * 0.07, h * 0.28);

  ctx.strokeStyle = 'rgba(255,255,255,.42)';
  ctx.beginPath();
  ctx.arc(x + w * 0.188, y + h * 0.5, h * 0.105, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + w * 0.812, y + h * 0.5, h * 0.105, Math.PI / 2, Math.PI * 1.5);
  ctx.stroke();

  ctx.fillStyle = 'rgba(15,23,42,.6)';
  ctx.fillRect(x - w * 0.012, y + h * 0.42, w * 0.018, h * 0.16);
  ctx.fillRect(x + w * 0.994, y + h * 0.42, w * 0.018, h * 0.16);
  ctx.strokeStyle = 'rgba(255,255,255,.48)';
  ctx.strokeRect(x - w * 0.012, y + h * 0.42, w * 0.018, h * 0.16);
  ctx.strokeRect(x + w * 0.994, y + h * 0.42, w * 0.018, h * 0.16);
  ctx.restore();
}

function vpDrawBall(ctx, x, y, r) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = r * 0.8;
  ctx.fillStyle = '#f8fafc';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = Math.max(1, r * 0.16);
  ctx.stroke();
  ctx.fillStyle = '#111827';
  ctx.beginPath();
  ctx.arc(x, y, r * 0.28, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function vpDrawArrow(ctx, x1, y1, x2, y2, color, width) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(8, width * 4);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - Math.cos(angle - Math.PI / 6) * head, y2 - Math.sin(angle - Math.PI / 6) * head);
  ctx.lineTo(x2 - Math.cos(angle + Math.PI / 6) * head, y2 - Math.sin(angle + Math.PI / 6) * head);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function vpDrawPlayer(ctx, x, y, color, label, pose = 'run') {
  const s = Math.max(13, ctx.canvas.height * 0.045);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = Math.max(2, s * 0.12);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y - s * 1.05, s * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd2a6';
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  vpRoundRect(ctx, x - s * 0.42, y - s * 0.72, s * 0.84, s * 0.88, s * 0.14);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(3, s * 0.16);
  const armLift = pose === 'handball' ? -s * 0.78 : pose === 'appeal' ? -s * 0.5 : s * 0.08;
  ctx.beginPath();
  ctx.moveTo(x - s * 0.38, y - s * 0.48);
  ctx.lineTo(x - s * 0.9, y - s * 0.34 + armLift);
  ctx.moveTo(x + s * 0.38, y - s * 0.48);
  ctx.lineTo(x + s * 0.9, y - s * 0.34 + armLift * 0.85);
  ctx.stroke();
  ctx.strokeStyle = '#e5e7eb';
  ctx.beginPath();
  ctx.moveTo(x - s * 0.2, y + s * 0.12);
  ctx.lineTo(x - s * 0.62, y + s * 0.92);
  ctx.moveTo(x + s * 0.2, y + s * 0.12);
  ctx.lineTo(x + (pose === 'tackle' ? s * 1.08 : s * 0.62), y + s * 0.92);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(s * 0.38)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y - s * 0.28);
  ctx.restore();
}

function vpEvidenceText(scenario) {
  const s = scenario?.scene || {};
  switch (scenario?.type) {
    case 'offside':
      return s.attackerX > s.defenderX ? 'A po prawej stronie linii: spalony' : 'A po lewej stronie linii: gra';
    case 'foul':
      return s.foul ? 'kontakt z nogą, brak gry w piłkę' : 'najpierw piłka, kontakt czysty';
    case 'handball':
      return s.handball ? 'ręka poza sylwetką zatrzymuje piłkę' : 'piłka nie trafia w rękę';
    case 'goalline':
      return s.goal ? 'piłka całym obwodem za linią' : 'piłka nadal na linii';
    default:
      return 'dowód z powtórki';
  }
}

function vpDrawEvidenceTag(ctx, box, text, tone = 'neutral') {
  const color = tone === 'good' ? '#22c55e' : tone === 'bad' ? '#ef4444' : '#38bdf8';
  const x = box.x + box.w * 0.04;
  const y = box.y + box.h - Math.max(34, box.h * 0.13);
  const w = box.w * 0.92;
  const h = Math.max(25, box.h * 0.09);
  ctx.save();
  ctx.fillStyle = 'rgba(2,6,23,.72)';
  vpRoundRect(ctx, x, y, w, h, 7);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#e5e7eb';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  vpFitText(ctx, text, x + w / 2, y + h / 2, w - 16, h * 0.43, 700);
  ctx.restore();
}

function vpDrawMonitor(ctx, scenario, phase, progress) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const pad = Math.max(12, w * 0.026);
  ctx.fillStyle = '#050816';
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w * 0.5, h * 0.35, h * 0.1, w * 0.5, h * 0.35, h * 0.8);
  glow.addColorStop(0, 'rgba(14,165,233,.22)');
  glow.addColorStop(1, 'rgba(14,165,233,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  const topH = Math.max(34, h * 0.13);
  const screen = {
    x: pad,
    y: topH,
    w: w - pad * 2,
    h: h - topH - Math.max(25, h * 0.08),
  };
  ctx.fillStyle = '#020617';
  vpRoundRect(ctx, pad * 0.55, pad * 0.55, w - pad * 1.1, h - pad * 1.1, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(56,189,248,.35)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#e2e8f0';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `900 ${Math.round(topH * 0.33)}px sans-serif`;
  ctx.fillText('VAR REVIEW', pad * 1.1, topH * 0.48);
  ctx.font = `800 ${Math.round(topH * 0.28)}px sans-serif`;
  ctx.fillStyle = '#38bdf8';
  ctx.textAlign = 'right';
  ctx.fillText(VP_PHASE_LABELS[phase] || 'POWTÓRKA', w - pad * 1.1, topH * 0.48);

  ctx.fillStyle = 'rgba(15,23,42,.84)';
  vpRoundRect(ctx, screen.x, screen.y, screen.w, screen.h, 8);
  ctx.fill();
  vpDrawPitch(ctx, screen.x + 6, screen.y + 6, screen.w - 12, screen.h - 12);

  const field = { x: screen.x + 6, y: screen.y + 6, w: screen.w - 12, h: screen.h - 12 };
  ctx.save();
  ctx.beginPath();
  vpRoundRect(ctx, field.x, field.y, field.w, field.h, 7);
  ctx.clip();
  vpDrawScenarioScene(ctx, field, scenario, phase, progress);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(226,232,240,.2)';
  ctx.lineWidth = 1;
  ctx.strokeRect(screen.x + 6, screen.y + 6, screen.w - 12, screen.h - 12);
  ctx.fillStyle = 'rgba(15,23,42,.78)';
  const qh = Math.max(26, h * 0.07);
  vpRoundRect(ctx, screen.x + screen.w * 0.28, screen.y + 10, screen.w * 0.44, qh, 999);
  ctx.fill();
  ctx.fillStyle = '#f8fafc';
  ctx.font = `900 ${Math.round(qh * 0.46)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(VP_TITLES[scenario?.type] || 'VAR', screen.x + screen.w * 0.5, screen.y + 10 + qh / 2);
  ctx.restore();

  return field;
}

function vpDrawIdle() {
  const ctx = vpInitCanvas();
  if (!ctx) return;
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.fillStyle = '#050816';
  ctx.fillRect(0, 0, w, h);
  const box = { x: w * 0.09, y: h * 0.18, w: w * 0.82, h: h * 0.56 };
  ctx.fillStyle = '#020617';
  vpRoundRect(ctx, box.x, box.y, box.w, box.h, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(56,189,248,.4)';
  ctx.lineWidth = 2;
  ctx.stroke();
  vpDrawPitch(ctx, box.x + 8, box.y + 8, box.w - 16, box.h - 16);
  ctx.fillStyle = 'rgba(2,6,23,.5)';
  ctx.fillRect(box.x + 8, box.y + 8, box.w - 16, box.h - 16);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(h * 0.16)}px sans-serif`;
  ctx.fillText('📺 VAR', w / 2, h * 0.42);
  ctx.font = `${Math.round(h * 0.07)}px sans-serif`;
  ctx.fillText('Powtórka, stop-klatka, werdykt', w / 2, h * 0.62);
}

function vpDrawScenarioScene(ctx, box, scenario, phase, progress) {
  if (!scenario) return;
  const s = scenario.scene || {};
  const fx = pct => box.x + box.w * (pct / 100);
  const fy = pct => box.y + box.h * (pct / 100);
  const p = vpClamp(progress, 0, 1);
  const reveal = phase !== 'clip';
  const feedback = varPatrolRuntime?.feedback;
  const good = feedback?.isCorrect;
  const tone = feedback ? (good ? 'good' : 'bad') : 'neutral';

  if (scenario.type === 'offside') {
    const isOffside = s.attackerX > s.defenderX;
    const defenderX = fx(s.defenderX);
    const finalAttackerX = fx(s.attackerX);
    const finalAttackerY = fy(s.attackerY || 52);
    const passer = s.passer || { x: 18, y: 70 };
    const passStartX = fx(passer.x);
    const passStartY = fy(passer.y);
    const passEndX = finalAttackerX - box.w * 0.035;
    const passEndY = finalAttackerY + box.h * 0.02;
    const ballX = vpLerp(passStartX, passEndX, p);
    const ballY = vpLerp(passStartY, passEndY, p);
    const labelY = box.y + box.h * 0.23;
    const defenders = Array.isArray(s.defenders) && s.defenders.length
      ? s.defenders
      : [{ x: s.defenderX, y: s.defenderY || 56, label: 'D', main: true }];
    const attackers = Array.isArray(s.attackers) && s.attackers.length
      ? s.attackers
      : [{ x: s.attackerX, y: s.attackerY || 52, label: 'A', main: true }];

    if (phase === 'feedback') {
      const safeW = Math.max(0, defenderX - box.x);
      const offsideW = Math.max(0, box.x + box.w - defenderX);
      const drawZoneLabel = (text, cx, color, maxW) => {
        const w = Math.max(46, Math.min(maxW - 12, box.w * 0.18));
        const h = Math.max(22, box.h * 0.085);
        ctx.fillStyle = 'rgba(2,6,23,.72)';
        vpRoundRect(ctx, cx - w / 2, labelY - h / 2, w, h, 7);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        vpFitText(ctx, text, cx, labelY, w - 10, h * 0.42, 900);
      };

      ctx.save();
      ctx.fillStyle = 'rgba(22,101,52,.28)';
      ctx.fillRect(box.x, box.y, safeW, box.h);
      ctx.fillStyle = 'rgba(153,27,27,.3)';
      ctx.fillRect(defenderX, box.y, offsideW, box.h);
      drawZoneLabel('GRA', box.x + safeW / 2, '#22c55e', safeW);
      drawZoneLabel('SPALONY', defenderX + offsideW / 2, '#ef4444', offsideW);
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = 0.88;
    vpDrawArrow(ctx, fx(7), fy(88), fx(29), fy(88), '#e0f2fe', Math.max(2, box.h * 0.01));
    ctx.fillStyle = '#e0f2fe';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    vpFitText(ctx, 'ATAK W PRAWO', fx(18), fy(84), box.w * 0.24, box.h * 0.05, 900);
    ctx.restore();

    ctx.save();
    ctx.setLineDash([6, 7]);
    ctx.globalAlpha = 0.72;
    vpDrawArrow(ctx, passStartX, passStartY, passEndX, passEndY, '#f8fafc', Math.max(2, box.h * 0.008));
    ctx.restore();

    const players = [];
    defenders.forEach(player => {
      players.push({
        x: fx(player.x),
        y: fy(player.y),
        color: player.main ? '#2563eb' : '#1d4ed8',
        label: player.label || '',
        pose: player.main ? 'appeal' : 'run',
        main: !!player.main,
      });
    });
    attackers.forEach(player => {
      const px = player.main
        ? vpLerp(fx(Math.max(8, player.x - 9)), fx(player.x), p)
        : fx(player.x);
      players.push({
        x: px,
        y: fy(player.y),
        color: player.main ? '#dc2626' : '#b91c1c',
        label: player.label || '',
        pose: 'run',
        main: !!player.main,
      });
    });
    players.push({ x: passStartX, y: passStartY, color: '#b91c1c', label: '10', pose: 'run', main: false });
    players.push({ x: fx(93), y: fy(55), color: '#f59e0b', label: 'G', pose: 'appeal', main: false });
    players.sort((a, b) => a.y - b.y);
    players.forEach(player => vpDrawPlayer(ctx, player.x, player.y, player.color, player.label, player.pose));
    vpDrawBall(ctx, ballX, ballY, Math.max(7, box.h * 0.035));

    if (reveal) {
      ctx.save();
      ctx.strokeStyle = '#ffd84d';
      ctx.lineWidth = Math.max(3, box.h * 0.012);
      ctx.setLineDash([box.h * 0.045, box.h * 0.025]);
      ctx.beginPath();
      ctx.moveTo(defenderX, box.y);
      ctx.lineTo(defenderX, box.y + box.h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(2,6,23,.78)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      vpFitText(ctx, 'linia D', defenderX, box.y + box.h * 0.12, box.w * 0.16, box.h * 0.05, 900);
      ctx.strokeStyle = phase === 'feedback'
        ? (isOffside ? '#ef4444' : '#22c55e')
        : '#ffd84d';
      ctx.lineWidth = Math.max(3, box.h * 0.014);
      ctx.beginPath();
      ctx.arc(finalAttackerX, finalAttackerY - box.h * 0.03, Math.max(20, box.h * 0.12), 0, Math.PI * 2);
      ctx.stroke();
      if (phase === 'feedback') {
        ctx.strokeStyle = 'rgba(248,250,252,.72)';
        ctx.lineWidth = Math.max(1.5, box.h * 0.006);
        ctx.setLineDash([box.h * 0.02, box.h * 0.018]);
        ctx.beginPath();
        ctx.moveTo(finalAttackerX, box.y + box.h * 0.08);
        ctx.lineTo(finalAttackerX, box.y + box.h * 0.92);
        ctx.stroke();
      }
      ctx.restore();
      if (phase === 'feedback') vpDrawEvidenceTag(ctx, box, vpEvidenceText(scenario), tone);
    }
  } else if (scenario.type === 'foul') {
    const x = fx(s.x || 50);
    const y = fy(s.y || 54);
    const runnerX = vpLerp(x - box.w * 0.18, x - box.w * 0.035, p);
    const tacklerX = vpLerp(x + box.w * 0.2, x + box.w * (s.foul ? 0.025 : 0.075), p);
    const ballX = x + box.w * (s.foul ? -0.02 : 0.1);
    vpDrawBall(ctx, ballX, y + box.h * 0.11, Math.max(7, box.h * 0.034));
    vpDrawPlayer(ctx, runnerX, y, '#dc2626', '9');
    vpDrawPlayer(ctx, tacklerX, y + box.h * 0.02, '#2563eb', '5', 'tackle');
    if (reveal) {
      ctx.save();
      ctx.strokeStyle = s.foul ? '#ef4444' : '#22c55e';
      ctx.lineWidth = Math.max(3, box.h * 0.012);
      ctx.beginPath();
      ctx.arc(x + box.w * (s.foul ? 0.01 : 0.1), y + box.h * 0.12, box.h * 0.1, 0, Math.PI * 2);
      ctx.stroke();
      if (s.foul) {
        ctx.strokeStyle = '#fca5a5';
        ctx.beginPath();
        ctx.moveTo(x - box.w * 0.04, y + box.h * 0.05);
        ctx.lineTo(x + box.w * 0.08, y + box.h * 0.17);
        ctx.moveTo(x + box.w * 0.08, y + box.h * 0.05);
        ctx.lineTo(x - box.w * 0.04, y + box.h * 0.17);
        ctx.stroke();
      }
      ctx.restore();
      if (phase === 'feedback') vpDrawEvidenceTag(ctx, box, vpEvidenceText(scenario), tone);
    }
  } else if (scenario.type === 'handball') {
    const x = fx(s.x || 50);
    const y = fy(s.y || 46);
    const dir = s.side ? 1 : -1;
    const targetX = x + box.w * dir * (s.handball ? 0.12 : 0.015);
    const targetY = y + box.h * (s.handball ? -0.14 : 0.02);
    const ballX = vpLerp(x - box.w * dir * 0.34, targetX, p);
    const ballY = vpLerp(y - box.h * 0.18, targetY, p);
    vpDrawPlayer(ctx, x, y + box.h * 0.14, s.handball ? '#dc2626' : '#2563eb', '4', s.handball ? 'handball' : 'run');
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.42)';
    ctx.setLineDash([7, 7]);
    ctx.lineWidth = Math.max(1, box.h * 0.007);
    ctx.beginPath();
    ctx.moveTo(x - box.w * dir * 0.34, y - box.h * 0.18);
    ctx.lineTo(targetX, targetY);
    ctx.stroke();
    ctx.restore();
    vpDrawBall(ctx, ballX, ballY, Math.max(7, box.h * 0.034));
    if (reveal) {
      ctx.save();
      ctx.strokeStyle = s.handball ? '#ef4444' : '#22c55e';
      ctx.lineWidth = Math.max(3, box.h * 0.012);
      ctx.beginPath();
      ctx.arc(targetX, targetY, box.h * 0.09, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      if (phase === 'feedback') vpDrawEvidenceTag(ctx, box, vpEvidenceText(scenario), tone);
    }
  } else {
    const lineX = fx(76);
    const y = fy(56);
    const ballR = Math.max(8, box.h * 0.04);
    const finalX = s.goal ? lineX + ballR * 1.8 : lineX - ballR * 0.7;
    const ballX = vpLerp(fx(42), finalX, p);
    ctx.save();
    ctx.fillStyle = 'rgba(15,23,42,.55)';
    ctx.fillRect(lineX, fy(25), box.w * 0.18, box.h * 0.5);
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = Math.max(3, box.h * 0.012);
    ctx.beginPath();
    ctx.moveTo(lineX, fy(22));
    ctx.lineTo(lineX, fy(78));
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.28)';
    for (let i = 1; i < 5; i++) {
      const nx = lineX + (box.w * 0.18 / 5) * i;
      ctx.beginPath();
      ctx.moveTo(nx, fy(25));
      ctx.lineTo(nx, fy(75));
      ctx.stroke();
    }
    ctx.restore();
    vpDrawPlayer(ctx, fx(88), y + box.h * 0.06, '#f59e0b', 'G', 'appeal');
    vpDrawBall(ctx, ballX, y, ballR);
    if (reveal) {
      ctx.save();
      ctx.strokeStyle = s.goal ? '#22c55e' : '#ef4444';
      ctx.lineWidth = Math.max(3, box.h * 0.012);
      ctx.beginPath();
      ctx.arc(finalX, y, ballR * 1.35, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      if (phase === 'feedback') vpDrawEvidenceTag(ctx, box, vpEvidenceText(scenario), tone);
    }
  }
}

function vpDrawScenario(scenario, now = performance.now()) {
  const ctx = vpInitCanvas();
  if (!ctx || !scenario) return;
  const rt = varPatrolRuntime;
  const phase = rt?.phase || 'decision';
  const progress = phase === 'clip'
    ? vpClamp((now - rt.phaseStartedAt) / VP_CLIP_MS, 0, 1)
    : 1;
  vpDrawMonitor(ctx, scenario, phase, progress);
  if (phase === 'feedback' && rt?.feedback) {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    const ok = rt.feedback.isCorrect;
    const panelW = Math.min(w * 0.74, 520);
    const panelH = Math.max(70, h * 0.22);
    const x = (w - panelW) / 2;
    const y = h * 0.38;
    ctx.save();
    ctx.fillStyle = ok ? 'rgba(20,83,45,.9)' : 'rgba(127,29,29,.9)';
    vpRoundRect(ctx, x, y, panelW, panelH, 12);
    ctx.fill();
    ctx.strokeStyle = ok ? '#86efac' : '#fca5a5';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(panelH * 0.32)}px sans-serif`;
    ctx.fillText(ok ? 'DOBRA DECYZJA' : 'ZŁY WERDYKT', w / 2, y + panelH * 0.34);
    vpFitText(ctx, rt.feedback.message, w / 2, y + panelH * 0.68, panelW - 24, panelH * 0.2, 800);
    ctx.restore();
  }
}

function vpRoundElapsedMs(rt, now = performance.now()) {
  if (!rt?.roundStartedAt) return 0;
  return Math.max(0, now - rt.roundStartedAt);
}

function vpRoundRemainingMs(rt, now = performance.now()) {
  const duration = rt?.durationMs || VP_ROUND_MS;
  return Math.max(0, duration - vpRoundElapsedMs(rt, now));
}

function vpFormatTime(ms) {
  return Math.max(0, Math.ceil(ms / 1000)) + 's';
}

function vpUpdateStats() {
  const rt = varPatrolRuntime || newVarPatrolRuntime();
  const attempts = rt.correct + rt.wrong;
  const accuracy = attempts ? Math.round((rt.correct / attempts) * 100) : 0;
  const scoreEl = document.getElementById('vp-score');
  const streakEl = document.getElementById('vp-streak');
  const timeEl = document.getElementById('vp-time');
  const accEl = document.getElementById('vp-accuracy');
  if (scoreEl) scoreEl.textContent = String(rt.correct);
  if (streakEl) streakEl.textContent = String(rt.streak);
  if (timeEl) timeEl.textContent = vpFormatTime(rt.playing ? vpRoundRemainingMs(rt) : rt.timeRemainingMs);
  if (accEl) accEl.textContent = accuracy + '%';
}

function vpSetVerdictButtons(scenario, enabled) {
  for (let i = 0; i < 2; i++) {
    const btn = document.getElementById('vp-verdict-' + i);
    if (!btn) continue;
    btn.textContent = scenario
      ? (i === 1 ? '← ' + scenario.verdicts[i] : scenario.verdicts[i] + ' →')
      : '—';
    btn.disabled = !enabled;
    btn.style.background = '';
    btn.style.borderColor = '';
    btn.style.boxShadow = '';
  }
}

function vpUpdateTimerBar(ratio) {
  const bar = document.getElementById('vp-timer-bar');
  if (!bar) return;
  const clamped = Math.max(0, Math.min(1, ratio));
  bar.style.width = clamped * 100 + '%';
  bar.style.background = clamped < 0.25 ? '#ef4444' : clamped < 0.55 ? '#f59e0b' : '#22c55e';
}

async function loadVarPatrolState(showSpinner = true) {
  const weeklyWrap = document.getElementById('vp-weekly-board');
  const allTimeWrap = document.getElementById('vp-alltime-board');
  const awardsWrap = document.getElementById('vp-awards');
  if (showSpinner && weeklyWrap) {
    weeklyWrap.replaceChildren(makeSpinner());
    allTimeWrap.replaceChildren(makeSpinner());
    awardsWrap.replaceChildren(makeSpinner());
  }
  try {
    const data = await invokeVarPatrol({ action: 'state' });
    renderVarPatrolState(data);
  } catch (err) {
    const msg = err.message || 'Nie udało się wczytać gry.';
    if (weeklyWrap) weeklyWrap.replaceChildren(el('p', { className: 'wb-empty' }, msg));
    if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'wb-empty' }, 'Brak danych.'));
    if (awardsWrap) awardsWrap.replaceChildren(el('p', { className: 'wb-empty' }, 'Wdróż SQL i funkcję Edge, żeby aktywować grę.'));
    const status = document.getElementById('vp-status');
    if (status) status.textContent = 'VAR Patrol nie jest jeszcze aktywny.';
  }
}

function renderVarPatrolState(data) {
  if (data.profile) {
    me.coins = data.profile.coins;
    setText(headerCoins, me.coins);
  }
  const weekLabel = document.getElementById('vp-week-label');
  const weekRange = whackBossWeekRange(data.weekStart);
  if (weekLabel) weekLabel.textContent = weekRange ? weekRange.short : '';

  renderVarPatrolTable(document.getElementById('vp-weekly-board'), data.weekly || [], 'weekly');
  renderVarPatrolTable(document.getElementById('vp-alltime-board'), data.allTime || [], 'allTime');
  renderVarPatrolAwards(document.getElementById('vp-awards'), data.awards || []);

  const status = document.getElementById('vp-status');
  if (!varPatrolRuntime?.playing) {
    vpDrawIdle();
    vpSetVerdictButtons(null, false);
    const idleRt = varPatrolRuntime;
    vpUpdateTimerBar(idleRt ? idleRt.timeRemainingMs / (idleRt.durationMs || VP_ROUND_MS) : 1);
    vpUpdateStats();
    if (status) {
      status.textContent = data.myWeekly
        ? 'Twój najlepszy wynik w tym tygodniu: ' + data.myWeekly.score + '.'
        : 'Masz 60 sekund na jak najwięcej decyzji. Wyniki zapisują się automatycznie po rundzie.';
    }
  }
}

function renderVarPatrolTable(wrap, rows, mode) {
  if (!wrap) return;
  rows = rows.filter(r => r.nick !== 'admin');
  if (!rows.length) {
    wrap.replaceChildren(el('p', { className: 'wb-empty' }, mode === 'weekly' ? 'Jeszcze nikt nie zagrał w tym tygodniu.' : 'Brak rekordów.'));
    return;
  }
  const bodyRows = rows.slice(0, 10).map(row => el('tr', {},
    el('td', { className: 'lb-rank' + (row.rank === 1 ? ' gold' : '') }, whackBossRankLabel(row.rank)),
    el('td', { className: 'lb-nick' + (row.user_id === me?.id ? ' me' : '') }, row.nick + (row.user_id === me?.id ? ' (Ty)' : '')),
    lbScoreCell(row)
  ));
  wrap.replaceChildren(
    el('table', { className: 'lb-table-compact' },
      el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Nick'), el('th', { title: 'Najwięcej trafnych decyzji w rundzie' }, 'Wynik'))),
      el('tbody', {}, ...bodyRows)
    )
  );
}

function renderVarPatrolAwards(wrap, awards) {
  if (!wrap) return;
  if (!awards.length) {
    wrap.replaceChildren(el('p', { className: 'wb-empty' }, 'Pierwsze nagrody pojawią się po zakończeniu tygodnia.'));
    return;
  }
  const rows = awards.slice(0, 6).map(row => {
    const range = whackBossWeekRange(row.week_start);
    const label = range?.short || '';
    return el('div', { className: 'wb-award-row' },
      el('span', {}, whackBossRankLabel(row.rank) + ' ' + row.nick + (label ? ' · ' + label : '')),
      el('strong', {}, '+' + row.prize_coins + ' 🪙')
    );
  });
  wrap.replaceChildren(...rows);
}

function stopVarPatrolRound() {
  if (varPatrolRuntime?.timer) clearInterval(varPatrolRuntime.timer);
  varPatrolRuntime = newVarPatrolRuntime();
  vpSetVerdictButtons(null, false);
  vpUpdateTimerBar(1);
  vpUpdateStats();
  vpDrawIdle();
  const startBtn = document.getElementById('vp-start-btn');
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Start rundy'; }
}

// Plain-language reason for the offside verdict, derived purely from the scene
// geometry (attack goes right, so A beyond the last defender D = offside).
function vpReasonText(scenario) {
  const s = scenario?.scene || {};
  if (scenario?.type === 'offside') {
    return s.attackerX > s.defenderX
      ? 'napastnik (A) wyprzedził ostatniego obrońcę (D) w chwili podania'
      : 'napastnik (A) był równo lub za ostatnim obrońcą (D) przy podaniu';
  }
  return vpEvidenceText(scenario);
}

function vpFeedbackMessage(scenario, answer, correctIdx) {
  return scenario.verdicts[correctIdx] + ' — ' + vpReasonText(scenario);
}

function vpMarkVerdictButtons(answer, correctIdx, isCorrect) {
  for (let i = 0; i < 2; i++) {
    const btn = document.getElementById('vp-verdict-' + i);
    if (!btn) continue;
    btn.disabled = true;
    btn.style.background = '';
    btn.style.borderColor = '';
    btn.style.boxShadow = '';
    if (i === correctIdx) {
      btn.style.borderColor = '#f8fafc';
      btn.style.boxShadow = '0 0 0 2px rgba(248,250,252,.65), 0 0 18px rgba(248,250,252,.22)';
    }
    if (i === answer && !isCorrect) {
      btn.style.background = '#7f1d1d';
      btn.style.borderColor = '#fca5a5';
    }
  }
}

function vpApplyVerdict(scenario, answer, isCorrect) {
  const rt = varPatrolRuntime;
  if (!rt?.playing) return;
  const correctIdx = vpCorrectAnswer(scenario);
  rt.locked = true;
  if (isCorrect) {
    rt.correct += 1;
    rt.streak += 1;
    rt.maxStreak = Math.max(rt.maxStreak, rt.streak);
  } else {
    rt.wrong += 1;
    rt.streak = 0;
  }
  rt.timeRemainingMs = vpRoundRemainingMs(rt);
  rt.phase = 'feedback';
  rt.phaseStartedAt = performance.now();
  rt.feedback = {
    answer,
    correctIdx,
    isCorrect,
    message: vpFeedbackMessage(scenario, answer, correctIdx),
  };
  vpMarkVerdictButtons(answer, correctIdx, isCorrect);
  vpUpdateTimerBar(rt.timeRemainingMs / (rt.durationMs || VP_ROUND_MS));
  vpUpdateStats();
  const status = document.getElementById('vp-status');
  if (status) {
    status.textContent = (isCorrect ? 'Dobra decyzja! Werdykt: ' : 'Błąd. Prawidłowo: ')
      + scenario.verdicts[correctIdx] + ' — bo ' + vpReasonText(scenario) + '.';
  }
  vpDrawScenario(scenario);
}

function vpBeginDecision() {
  const rt = varPatrolRuntime;
  if (!rt?.playing) return;
  const scenario = rt.schedule[rt.idx];
  if (!scenario) { finishVarPatrolRound(); return; }
  const now = performance.now();
  rt.phase = 'decision';
  rt.phaseStartedAt = now;
  rt.locked = false;
  rt.feedback = null;
  rt.scenarioShownAt = now;
  vpSetVerdictButtons(scenario, true);
  rt.timeRemainingMs = vpRoundRemainingMs(rt, now);
  vpUpdateTimerBar(rt.timeRemainingMs / (rt.durationMs || VP_ROUND_MS));
  const status = document.getElementById('vp-status');
  if (status) status.textContent = '← GRA · → SPALONY. A po prawej stronie żółtej linii = SPALONY.';
  vpDrawScenario(scenario, now);
}

function vpShowScenario(i) {
  const rt = varPatrolRuntime;
  if (!rt?.playing) return;
  const scenario = rt.schedule[i];
  if (!scenario) { finishVarPatrolRound(); return; }
  const now = performance.now();
  rt.idx = i;
  rt.locked = true;
  rt.windowMs = scenario.windowMs;
  rt.scenarioShownAt = 0;
  rt.phase = 'clip';
  rt.phaseStartedAt = now;
  rt.feedback = null;
  vpSetVerdictButtons(scenario, false);
  rt.timeRemainingMs = vpRoundRemainingMs(rt, now);
  vpUpdateTimerBar(rt.timeRemainingMs / (rt.durationMs || VP_ROUND_MS));
  const status = document.getElementById('vp-status');
  if (status) status.textContent = 'Analiza linii spalonego...';
  vpDrawScenario(scenario, now);
}

function vpAdvance() {
  const rt = varPatrolRuntime;
  if (!rt?.playing) return;
  if (vpRoundRemainingMs(rt) <= 0 || rt.idx + 1 >= rt.schedule.length) {
    finishVarPatrolRound();
    return;
  }
  vpShowScenario(rt.idx + 1);
}

function vpAnswer(answer) {
  const rt = varPatrolRuntime;
  if (!rt?.playing || rt.locked || rt.phase !== 'decision' || rt.idx < 0) return;
  const scenario = rt.schedule[rt.idx];
  if (!scenario) return;
  const now = performance.now();
  if (vpRoundRemainingMs(rt, now) <= 0) { finishVarPatrolRound(); return; }
  rt.locked = true;
  const reactionMs = now - rt.scenarioShownAt;
  const elapsedMs = vpRoundElapsedMs(rt, now);
  rt.answers.push({
    index: scenario.index,
    answer,
    reactionMs: Math.round(reactionMs),
    elapsedMs: Math.round(elapsedMs),
  });
  const correctIdx = vpCorrectAnswer(scenario);
  const isCorrect = answer === correctIdx && reactionMs >= VP_REACTION_FLOOR_MS;
  vpApplyVerdict(scenario, answer, isCorrect);
}

function vpTick() {
  const rt = varPatrolRuntime;
  if (!rt?.playing || rt.idx < 0) return;
  const now = performance.now();
  const scenario = rt.schedule[rt.idx];
  if (!scenario) { finishVarPatrolRound(); return; }
  rt.timeRemainingMs = vpRoundRemainingMs(rt, now);
  vpUpdateTimerBar(rt.timeRemainingMs / (rt.durationMs || VP_ROUND_MS));
  vpUpdateStats();
  if (rt.timeRemainingMs <= 0) {
    finishVarPatrolRound();
    return;
  }

  if (rt.phase === 'clip') {
    vpDrawScenario(scenario, now);
    if (now - rt.phaseStartedAt >= VP_CLIP_MS) vpBeginDecision();
    return;
  }

  if (rt.phase === 'feedback') {
    vpDrawScenario(scenario, now);
    if (now - rt.phaseStartedAt >= VP_FEEDBACK_MS) vpAdvance();
    return;
  }

  if (rt.phase !== 'decision' || rt.locked) return;
  vpDrawScenario(scenario, now);
}

function beginVarPatrolRound(round) {
  stopVarPatrolRound();
  varPatrolRuntime = newVarPatrolRuntime();
  const rt = varPatrolRuntime;
  rt.playing = true;
  rt.roundId = round.id;
  rt.durationMs = round.roundMs || VP_ROUND_MS;
  rt.timeRemainingMs = rt.durationMs;
  rt.roundStartedAt = performance.now();
  rt.schedule = Array.isArray(round.schedule) ? round.schedule : [];
  vpUpdateStats();
  const status = document.getElementById('vp-status');
  if (status) status.textContent = '60 sekund: ← GRA, → SPALONY.';
  const startBtn = document.getElementById('vp-start-btn');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Runda trwa'; }
  rt.timer = setInterval(vpTick, 33);
  vpShowScenario(0);
}

async function startVarPatrolRound() {
  if (varPatrolRuntime?.playing || varPatrolRuntime?.submitting) return;
  if (allGamesMode) {
    try { await payArcadeEntry(allGamesSelectedGame); } catch (e) { showToast('❌ Nie udało się wejść do gry.'); return; }
  }
  const startBtn = document.getElementById('vp-start-btn');
  const status = document.getElementById('vp-status');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Ładuję...'; }
  if (status) status.textContent = 'Przygotowuję rundę.';
  try {
    const data = await invokeVarPatrol({ action: 'start' });
    renderVarPatrolState(data);
    beginVarPatrolRound(data.round);
    if (allGamesMode) varPatrolRuntime.archiveMode = true;
  } catch (err) {
    showToast('❌ ' + err.message);
    if (status) status.textContent = 'Nie udało się wystartować rundy.';
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Start rundy'; }
  }
}

async function finishVarPatrolRound() {
  const rt = varPatrolRuntime;
  if (!rt || rt.submitting) return;
  const roundDurationMs = Math.round(Math.min(rt.durationMs || VP_ROUND_MS, vpRoundElapsedMs(rt)));
  rt.timeRemainingMs = Math.max(0, (rt.durationMs || VP_ROUND_MS) - roundDurationMs);
  rt.playing = false;
  rt.submitting = true;
  if (rt.timer) clearInterval(rt.timer);
  vpSetVerdictButtons(null, false);
  vpUpdateTimerBar(rt.timeRemainingMs / (rt.durationMs || VP_ROUND_MS));
  vpUpdateStats();
  vpDrawIdle();
  const status = document.getElementById('vp-status');
  const startBtn = document.getElementById('vp-start-btn');
  if (status) status.textContent = 'Zapisuję wynik...';
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Zapisuję...'; }

  if (rt.archiveMode) {
    rt.submitting = false;
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Zagraj ponownie'; }
    if (allGamesMode) {
      try {
        await recordArcadeScore('var_patrol', rt.correct);
        if (status) status.textContent = 'Wynik: ' + rt.correct + ' · błędy: ' + rt.wrong + ' · zapisano w rankingu arcade!';
        loadArcadeScores('var_patrol');
      } catch (e) { if (status) status.textContent = 'Wynik: ' + rt.correct + ' · błędy: ' + rt.wrong + ' (błąd zapisu).'; }
    } else {
      if (status) status.textContent = 'Tryb archiwum — wynik: ' + rt.correct + ' · błędy: ' + rt.wrong + ' (nie zapisano).';
    }
    return;
  }

  try {
    const data = await invokeVarPatrol({
      action: 'submit',
      roundId: rt.roundId,
      answers: rt.answers,
      roundDurationMs,
    });
    renderVarPatrolState(data);
    showToast('✅ Wynik zapisany: ' + data.score.score);
    if (status) status.textContent = 'Ostatni wynik: ' + data.score.score + ' trafnych decyzji · błędy: ' + data.score.misses + '.';
  } catch (err) {
    showToast('❌ ' + err.message);
    if (status) status.textContent = 'Nie udało się zapisać wyniku.';
  } finally {
    rt.submitting = false;
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Zagraj ponownie'; }
  }
}

function vpIsTypingTarget(target) {
  const tag = target?.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
}

(function wireVarPatrol() {
  const startBtn = document.getElementById('vp-start-btn');
  if (startBtn) startBtn.addEventListener('click', startVarPatrolRound);
  for (let i = 0; i < 2; i++) {
    const btn = document.getElementById('vp-verdict-' + i);
    if (btn) btn.addEventListener('click', () => vpAnswer(i));
  }
  document.addEventListener('keydown', evt => {
    if (vpIsTypingTarget(evt.target) || evt.repeat) return;
    if (!varPatrolRuntime?.playing || varPatrolRuntime.phase !== 'decision') return;
    const key = evt.key.toLowerCase();
    if (evt.key === 'ArrowLeft' || key === 'a') {
      evt.preventDefault();
      vpAnswer(1); // left side of the line = GRA
    } else if (evt.key === 'ArrowRight' || key === 'd') {
      evt.preventDefault();
      vpAnswer(0); // right side of the line = SPALONY
    }
  });
})();

