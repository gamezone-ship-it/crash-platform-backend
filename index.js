import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

/* ───────────── SUPABASE ───────────── */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ───────────── GAME STATE ───────────── */

let gameState = "WAITING";
let currentMultiplier = 1.0;
let crashPoint = null;
let currentRoundId = null;

let activeBets = {}; // userId → { amount, cashedOut }

/* ───────────── PROVABLY FAIR ───────────── */

const clientSeed = "demo-client";
let serverSeed = "";
let serverSeedHash = "";

/* ───────────── HELPERS ───────────── */

function generateServerSeed() {
  return crypto.randomBytes(32).toString("hex");
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key, message) {
  return crypto.createHmac("sha256", key).update(message).digest("hex");
}

function calculateCrashPoint(serverSeed, clientSeed) {
  const hmac = hmacSha256(serverSeed, clientSeed);
  const hex = hmac.slice(0, 13);
  const intVal = parseInt(hex, 16);
  const max = Math.pow(2, 52);
  return Math.max(1, Math.floor((max / (max - intVal)) * 100) / 100);
}

/* ───────────── WEBSOCKET ───────────── */

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => c.readyState === 1 && c.send(msg));
}

wss.on("connection", ws => {
  ws.send(JSON.stringify({ type: "STATE", state: gameState }));
});

/* ───────────── GAME LOOP ───────────── */

async function startNewRound() {
  console.log(`🟢 Round started`);

  activeBets = {};
  currentMultiplier = 1;
  gameState = "WAITING";

  broadcast({ type: "STATE", state: "WAITING" });

  let waitSeconds = 3;

  broadcast({
    type: "WAITING_TICK",
    seconds: waitSeconds
  });

  const waitTimer = setInterval(() => {
    waitSeconds--;

    if (waitSeconds > 0) {
      broadcast({
        type: "WAITING_TICK",
        seconds: waitSeconds
      });
    } else {
      clearInterval(waitTimer);
    }
  }, 1000);
  
  serverSeed = generateServerSeed();
  serverSeedHash = sha256(serverSeed);
  crashPoint = calculateCrashPoint(serverSeed, clientSeed);

  console.log("🔐 Server seed hash:", serverSeedHash);
  console.log("💥 Crash point:", crashPoint);

  const { data, error } = await supabase
    .from("rounds")
    .insert({
      server_seed: serverSeed,
      server_seed_hash: serverSeedHash,
      client_seed: clientSeed,
      crash_point: crashPoint,
      started_at: new Date()
    })
    .select()
    .single();

  if (error) {
    console.error("❌ Round insert failed:", error);
    return;
  }

  console.log("✅ Round row created:", data);

  currentRoundId = data.id;

  broadcast({
    type: "ROUND_START",
    serverSeedHash,
    clientSeed
  });

  setTimeout(startCrash, 5000);
}

function startCrash() {
  gameState = "RUNNING";
  broadcast({ type: "STATE", state: "RUNNING" });

  const timer = setInterval(() => {
    currentMultiplier = +(currentMultiplier + 0.01).toFixed(2);
    broadcast({ type: "MULTIPLIER", value: currentMultiplier });

    if (currentMultiplier >= crashPoint) {
      clearInterval(timer);
      handleCrash();
    }
  }, 100);
}

async function handleCrash() {
  gameState = "CRASHED";

  broadcast({ type: "STATE", state: "CRASHED" }); // ✅ ADD THIS
  broadcast({ type: "CRASH", crashPoint, serverSeed });

  await supabase
    .from("rounds")
    .update({ ended_at: new Date() })
    .eq("id", currentRoundId);

  await supabase
    .from("bets")
    .update({ status: "lost" })
    .eq("round_id", currentRoundId)
    .eq("status", "placed");

  setTimeout(startNewRound, 3000);
}

/* ───────────── API ROUTES ───────────── */

app.get("/balance/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .from("balances")
      .select("balance")
      .eq("user_id", userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Balance not found" });
    }

    res.json({ balance: data.balance });
  } catch (err) {
    console.error("❌ /balance error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/bet", async (req, res) => {
  try {
    const { userId, amount } = req.body;

    if (gameState !== "WAITING") {
      return res.status(400).json({ error: "Betting closed" });
    }

    if (!currentRoundId) {
      return res.status(400).json({ error: "Round not ready" });
    }

    if (!userId || amount <= 0) {
      return res.status(400).json({ error: "Invalid bet" });
    }

    if (activeBets[userId]) {
      return res.status(400).json({ error: "Already bet" });
    }

    const { data: bal } = await supabase
      .from("balances")
      .select("balance")
      .eq("user_id", userId)
      .single();

    if (!bal || bal.balance < amount) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const { error: betError } = await supabase.from("bets").insert({
      round_id: currentRoundId,
      user_id: userId,
      bet_amount: amount,
      status: "placed"
    });

    if (betError) {
      console.error("❌ Bet insert failed:", betError);
      return res.status(500).json({ error: "Bet insert failed" });
    }

    await supabase
      .from("balances")
      .update({ balance: bal.balance - amount })
      .eq("user_id", userId);

    activeBets[userId] = { amount, cashedOut: false };

    res.json({ success: true });
  } catch (err) {
    console.error("❌ /bet error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/cashout", async (req, res) => {
  try {
    const { userId } = req.body;
    const bet = activeBets[userId];

    if (gameState !== "RUNNING" || !bet || bet.cashedOut) {
      return res.status(400).json({ error: "Invalid cashout" });
    }

    bet.cashedOut = true;
    const win = +(bet.amount * currentMultiplier).toFixed(2);

    const { error: cashoutError } = await supabase
      .from("bets")
      .update({
        cashout_multiplier: currentMultiplier,
        win_amount: win,
        status: "won" // ✅ valid DB value
      })
      .eq("round_id", currentRoundId)
      .eq("user_id", userId);

    if (cashoutError) {
      console.error("❌ Cashout update failed:", cashoutError);
      return res.status(500).json({ error: "Cashout failed" });
    }

    console.log(`💰 Cashed out at ${currentMultiplier}x → ${win}`);
    const { data: bal } = await supabase
      .from("balances")
      .select("balance")
      .eq("user_id", userId)
      .single();

    await supabase
      .from("balances")
      .update({ balance: bal.balance + win })
      .eq("user_id", userId);

    res.json({ success: true, multiplier: currentMultiplier, win });
  } catch (err) {
    console.error("❌ /cashout error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ───────────── START ───────────── */

server.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  startNewRound();
});