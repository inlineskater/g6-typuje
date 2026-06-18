// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://inlineskater.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const db = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 4, idle_timeout: 20 });

const SYMBOLS = ["coffee", "calculator", "clipboard", "chart", "briefcase", "office", "g6"];
const WEIGHTS = [30, 25, 18, 12, 8, 5, 2]; // sum=100
// Multipliers tuned for ~89% RTP across the 5 paylines (with the g6x2 partial below).
// RTP = 5 * (Σ p_s^3 · mult_s + 3·p_g6^2·(1−p_g6)·6). With these weights ≈ 89.1%.
const MULTIPLIERS = { g6: 100, office: 42, briefcase: 20, chart: 11, clipboard: 6, calculator: 3, coffee: 2 };
const G6X2_MULTIPLIER = 6;
const STAKES = [5, 10, 25, 50, 100];
const DEFAULT_BET = 10;

const PAYLINES = [
  [[0,0],[0,1],[0,2]],
  [[1,0],[1,1],[1,2]],
  [[2,0],[2,1],[2,2]],
  [[0,0],[1,1],[2,2]],
  [[2,0],[1,1],[0,2]],
];

function randomSymbol(weights = WEIGHTS) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const total = weights.reduce((sum, w) => sum + w, 0);
  let r = buf[0] % total;
  for (let i = 0; i < SYMBOLS.length; i++) {
    r -= weights[i];
    if (r < 0) return SYMBOLS[i];
  }
  return SYMBOLS[0];
}

function generateGrid(weights = WEIGHTS) {
  return [[randomSymbol(weights), randomSymbol(weights), randomSymbol(weights)],
          [randomSymbol(weights), randomSymbol(weights), randomSymbol(weights)],
          [randomSymbol(weights), randomSymbol(weights), randomSymbol(weights)]];
}

function checkPaylines(grid) {
  const winningLines = [];
  for (let i = 0; i < PAYLINES.length; i++) {
    const line = PAYLINES[i];
    const syms = line.map(([r, c]) => grid[r][c]);
    if (syms[0] === syms[1] && syms[1] === syms[2]) {
      winningLines.push({ line: i, symbol: syms[0], multiplier: MULTIPLIERS[syms[0]] });
    } else {
      const g6Count = syms.filter(s => s === "g6").length;
      if (g6Count === 2) {
        winningLines.push({ line: i, symbol: "g6x2", multiplier: G6X2_MULTIPLIER });
      }
    }
  }
  return winningLines;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function requireUser(req) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) throw Object.assign(new Error("Musisz być zalogowany."), { isGame: true });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authClient = createClient(supabaseUrl!, anonKey!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) throw Object.assign(new Error("Sesja wygasła."), { isGame: true });
  return data.user;
}

async function getStrongestHeroEffect(tx, userId, game) {
  try {
    const rows = await tx`
      select d.slug, d.name, d.emoji, d.effect_game, d.effect_type, d.effect_value
      from public.hero_equipment e
      join public.hero_item_instances i on i.id = e.item_instance_id
      join public.hero_item_defs d on d.id = i.item_def_id
      where e.user_id = ${userId}
        and i.owner_id = ${userId}
        and d.is_active = true
        and d.effect_game = ${game}
      order by d.effect_value desc, d.price desc, d.slug
      limit 1
    `;
    return rows[0] ?? null;
  } catch (err) {
    console.warn("Hero item effects unavailable:", err?.message ?? err);
    return null;
  }
}

function weightsForEffect(effect) {
  if (effect?.effect_type !== "rare_symbol_bonus") return { weights: WEIGHTS, itemEffect: null };
  const bonus = Math.max(0, Math.trunc(Number(effect.effect_value)));
  if (bonus <= 0) return { weights: WEIGHTS, itemEffect: null };
  const weights = [...WEIGHTS];
  const coffeeIdx = SYMBOLS.indexOf("coffee");
  const g6Idx = SYMBOLS.indexOf("g6");
  const applied = Math.min(bonus, Math.max(0, weights[coffeeIdx] - 1));
  if (applied <= 0) return { weights: WEIGHTS, itemEffect: null };
  weights[coffeeIdx] -= applied;
  weights[g6Idx] += applied;
  return {
    weights,
    itemEffect: {
      slug: effect.slug,
      name: effect.name,
      type: effect.effect_type,
      value: Number(effect.effect_value),
    },
  };
}

function validateBet(raw) {
  const bet = Math.trunc(Number(raw));
  if (!STAKES.includes(bet)) throw Object.assign(new Error("Nieprawidłowa stawka."), { isGame: true });
  return bet;
}

async function spin(userId, rawBet) {
  const bet = validateBet(rawBet ?? DEFAULT_BET);
  const effect = await getStrongestHeroEffect(db, userId, "slots");

  return await db.begin(async (tx) => {
    const [profile] = await tx`select coins from public.profiles where id = ${userId} for update`;
    if (!profile) throw Object.assign(new Error("Profil nie istnieje."), { isGame: true });
    if (profile.coins < bet) throw Object.assign(new Error("Za mało coinów!"), { isGame: true });

    const { weights, itemEffect } = weightsForEffect(effect);
    const grid = generateGrid(weights);
    const winningLines = checkPaylines(grid);
    const totalWon = winningLines.reduce((s, w) => s + bet * w.multiplier, 0);
    const newBalance = profile.coins - bet + totalWon;

    await tx`update public.profiles set coins = ${newBalance} where id = ${userId}`;
    await tx`insert into public.slots_spins (user_id, grid, winning_lines, total_won)
             values (${userId}, ${JSON.stringify(grid)}, ${JSON.stringify(winningLines)}, ${totalWon})`;

    return { grid, winningLines, totalWon, balance: newBalance, bet, itemEffect };
  });
}

async function history(userId) {
  const rows = await db`
    select grid, winning_lines, total_won, created_at
    from public.slots_spins
    where user_id = ${userId}
    order by created_at desc
    limit 20
  `;
  return { spins: rows };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "history");

    let result;
    if (action === "spin") result = await spin(user.id, body.bet);
    else if (action === "history") result = await history(user.id);
    else throw Object.assign(new Error("Nieznana akcja."), { isGame: true });

    return json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
