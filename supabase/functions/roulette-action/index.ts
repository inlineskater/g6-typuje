// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const db = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 4, idle_timeout: 20 });

const REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const VALID_TYPES = new Set(["straight","red","black","odd","even","high","low","dozen"]);

function numberColor(n) {
  if (n === 0) return "green";
  return REDS.has(n) ? "red" : "black";
}

function betWins(bet, number) {
  const color = numberColor(number);
  switch (bet.type) {
    case "straight": return bet.value === number;
    case "red": return color === "red";
    case "black": return color === "black";
    case "odd": return number > 0 && number % 2 === 1;
    case "even": return number > 0 && number % 2 === 0;
    case "low": return number >= 1 && number <= 18;
    case "high": return number >= 19 && number <= 36;
    case "dozen":
      if (number === 0) return false;
      return Math.ceil(number / 12) === bet.value;
    default: return false;
  }
}

function betMultiplier(type) {
  if (type === "straight") return 36;
  if (type === "dozen") return 3;
  return 2; // red/black/odd/even/high/low
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

function validateBets(bets) {
  if (!Array.isArray(bets) || bets.length === 0) throw Object.assign(new Error("Brak zakładów."), { isGame: true });
  if (bets.length > 50) throw Object.assign(new Error("Za dużo zakładów."), { isGame: true });
  let total = 0;
  for (const b of bets) {
    if (!VALID_TYPES.has(b.type)) throw Object.assign(new Error(`Nieprawidłowy typ: ${b.type}`), { isGame: true });
    const amount = Math.trunc(Number(b.amount));
    if (!amount || amount < 1) throw Object.assign(new Error("Kwota musi być > 0."), { isGame: true });
    b.amount = amount;
    if (b.type === "straight") {
      const v = Math.trunc(Number(b.value));
      if (v < 0 || v > 36) throw Object.assign(new Error("Numer musi być 0-36."), { isGame: true });
      b.value = v;
    } else if (b.type === "dozen") {
      const v = Math.trunc(Number(b.value));
      if (v < 1 || v > 3) throw Object.assign(new Error("Tuzin musi być 1, 2 lub 3."), { isGame: true });
      b.value = v;
    }
    total += b.amount;
  }
  return total;
}

function randomNumber() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % 37;
}

async function spin(userId, bets) {
  const totalBet = validateBets(bets);

  return await db.begin(async (tx) => {
    const [profile] = await tx`select coins from public.profiles where id = ${userId} for update`;
    if (!profile) throw Object.assign(new Error("Profil nie istnieje."), { isGame: true });
    if (profile.coins < totalBet) throw Object.assign(new Error("Za mało coinów!"), { isGame: true });

    const number = randomNumber();
    const color = numberColor(number);

    let totalWon = 0;
    for (const b of bets) {
      if (betWins(b, number)) totalWon += b.amount * betMultiplier(b.type);
    }

    const newBalance = profile.coins - totalBet + totalWon;
    await tx`update public.profiles set coins = ${newBalance} where id = ${userId}`;
    await tx`insert into public.roulette_spins (user_id, bets, result_number, result_color, total_bet, total_won)
             values (${userId}, ${JSON.stringify(bets)}, ${number}, ${color}, ${totalBet}, ${totalWon})`;

    return { number, color, totalWon, balance: newBalance };
  });
}

async function history(userId) {
  const rows = await db`
    select result_number, result_color, total_bet, total_won, created_at
    from public.roulette_spins
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
    if (action === "spin") result = await spin(user.id, body.bets);
    else if (action === "history") result = await history(user.id);
    else throw Object.assign(new Error("Nieznana akcja."), { isGame: true });

    return json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
