const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { google } = require("googleapis");
const NodeCache = require("node-cache");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const cache = new NodeCache({ stdTTL: 300 });

const sessions = {};

const SHEET_ID = process.env.SHEET_ID;

// ✅ SECRET FILE орқали (хатосиз)
const auth = new google.auth.GoogleAuth({
  keyFile: "/etc/secrets/google-credentials.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });

// ===== UI =====
function menu() {
  return Markup.keyboard([
    ["📦 Қарзга олиш"],
    ["💳 Тўлов учун ариза"]
  ]).resize();
}

function back() {
  return Markup.keyboard([["⬅️ Орқага"]]).resize();
}

// ===== HELPERS =====
function cleanNumber(text) {
  return Number(String(text).replace(/\s/g, "").replace(/,/g, ""));
}

function validInn(inn) {
  return /^\d{9}$/.test(String(inn));
}

// ===== GOOGLE =====
async function getValues(range, key) {
  const c = cache.get(key);
  if (c) return c;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  });

  const rows = res.data.values || [];
  cache.set(key, rows);
  return rows;
}

async function append(range, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] }
  });
}

// ===== START =====
bot.start(async (ctx) => {
  sessions[ctx.chat.id] = null;
  await ctx.reply("Асосий меню", menu());
});

// ===== ТЎЛОВ =====
bot.hears("💳 Тўлов учун ариза", async (ctx) => {
  sessions[ctx.chat.id] = { step: "type", data: {} };

  await ctx.reply(
    "Тўлов турини танланг:",
    Markup.keyboard([
      ["Қарз ёпиш"],
      ["Аванс ўтказиш"],
      ["⬅️ Орқага"]
    ]).resize()
  );
});

// ===== TYPE =====
bot.hears(["Қарз ёпиш", "Аванс ўтказиш"], async (ctx) => {
  sessions[ctx.chat.id] = {
    step: "object",
    data: { type: ctx.message.text }
  };

  const objs = await getValues("Объектлар!A2:A", "obj");

  await ctx.reply(
    "Объектни танланг:",
    Markup.keyboard([...objs.map(x => [x[0]]), ["⬅️ Орқага"]]).resize()
  );
});

// ===== MAIN FLOW =====
bot.on("text", async (ctx) => {
  const s = sessions[ctx.chat.id];
  if (!s) return;

  const text = ctx.message.text;
  const d = s.data;

  // OBJECT
  if (s.step === "object") {
    d.object = text;
    s.step = "supplier";

    const sup = await getValues("Етказиб_берувчилар!A2:B", "sup");

    await ctx.reply(
      "Етказиб берувчи:",
      Markup.keyboard([
        ...sup.map(x => [`${x[0]} — ${x[1]}`]),
        ["➕ Янги"],
        ["⬅️ Орқага"]
      ]).resize()
    );
    return;
  }

  // SUPPLIER
  if (s.step === "supplier") {
    if (text === "➕ Янги") {
      s.step = "new_sup_name";
      await ctx.reply("Номи:", back());
      return;
    }

    const [name, inn] = text.split(" — ");
    d.supplier = name;
    d.inn = inn;

    s.step = "material";

    const mat = await getValues("Материаллар_хизматлар!A2:A", "mat");

    await ctx.reply(
      "Материал:",
      Markup.keyboard([
        ...mat.map(x => [x[0]]),
        ["➕ Янги"],
        ["⬅️ Орқага"]
      ]).resize()
    );
    return;
  }

  // NEW SUP NAME
  if (s.step === "new_sup_name") {
    d.supplier = text;
    s.step = "new_sup_inn";
    await ctx.reply("ИНН (9 рақам):");
    return;
  }

  // NEW SUP INN
  if (s.step === "new_sup_inn") {
    if (!validInn(text)) {
      await ctx.reply("❌ ИНН 9 рақам бўлсин");
      return;
    }

    d.inn = text;
    await append("Етказиб_берувчилар!A:B", [d.supplier, d.inn]);

    s.step = "material";

    await ctx.reply("Сақланди");
    return;
  }

  // MATERIAL
  if (s.step === "material") {
    if (text === "➕ Янги") {
      s.step = "new_mat";
      await ctx.reply("Номи:");
      return;
    }

    d.material = text;
    s.step = "sum";
    await ctx.reply("Сумма:");
    return;
  }

  // NEW MAT
  if (s.step === "new_mat") {
    d.material = text;
    await append("Материаллар_хизматлар!A:A", [text]);

    s.step = "sum";
    await ctx.reply("Сумма:");
    return;
  }

  // SUM
  if (s.step === "sum") {
    const sum = cleanNumber(text);
    d.sum = sum;

    await append("Тўлов_аризалар!A:F", [
      new Date().toLocaleString(),
      d.object,
      d.supplier,
      d.inn,
      d.material,
      d.sum
    ]);

    await ctx.reply("✅ Сақланди", menu());
    sessions[ctx.chat.id] = null;
  }
});

// ===== SERVER =====
app.use(bot.webhookCallback("/bot"));

app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server started");
});
