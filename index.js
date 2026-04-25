require("dotenv").config();
const { Telegraf } = require("telegraf");
const { google } = require("googleapis");
const NodeCache = require("node-cache");

const bot = new Telegraf(process.env.BOT_TOKEN);
const cache = new NodeCache({ stdTTL: 60 });

// ================= GOOGLE AUTH =================
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });

// ================= HELPERS =================
function active(v) {
  return String(v).toUpperCase() === "TRUE";
}

function formatSum(num) {
  return Number(num || 0).toLocaleString("ru-RU");
}

async function getValues(range, key, useCache = true) {
  if (useCache && cache.has(key)) return cache.get(key);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range
  });

  const data = res.data.values || [];
  cache.set(key, data);
  return data;
}

// ================= USER =================
async function getUser(chatId) {
  const rows = await getValues("Ходимлар!A2:H", "users", false);

  const r = rows.find(x =>
    String(x[0]).trim() === String(chatId).trim() &&
    active(x[7])
  );

  if (!r) return null;

  return {
    name: r[1],
    canCreate: active(r[3]),
    canDirector: active(r[4]),
    canAccountant: active(r[5]),
    canPay: active(r[6])
  };
}

// ================= MENU =================
function menu() {
  return {
    reply_markup: {
      keyboard: [
        ["📊 директор ҳисобот"],
        ["📋 қарз ҳисобот"]
      ],
      resize_keyboard: true
    }
  };
}

// ================= START =================
bot.start(async ctx => {
  cache.flushAll(); // 🔥 муҳим

  const user = await getUser(ctx.chat.id);

  if (!user) {
    return ctx.reply(
      `❌ Сиз Ходимлар листида йўқсиз\n\nTelegram ID: ${ctx.chat.id}`
    );
  }

  ctx.reply(`Асосий меню`, menu());
});

// ================= DIRECTOR REPORT =================
bot.hears("📊 директор ҳисобот", async ctx => {
  const user = await getUser(ctx.chat.id);

  if (!user || !user.canDirector) {
    return ctx.reply("❌ Рухсат йўқ");
  }

  const supplierRows = await getValues("Директор_Ҳисобот!A4:F100", "sup", false);
  const objectRows = await getValues("Директор_Ҳисобот!H4:L100", "obj", false);

  let supplierText = "📊 ЕТКАЗИБ БЕРУВЧИЛАР\n\n";

  supplierRows.forEach(r => {
    if (!r[0]) return;

    supplierText += `🏢 ${r[0]} — ${r[1]}\n`;
    supplierText += `Қарз: ${formatSum(r[2])}\n`;
    supplierText += `Аванс: ${formatSum(r[3])}\n`;
    supplierText += `Соф ҳолат: ${formatSum(r[4])}\n`;
    supplierText += `Ҳолат: ${r[5]}\n\n`;
  });

  let objectText = "🏗 ОБЪЕКТЛАР\n\n";

  objectRows.forEach(r => {
    if (!r[0]) return;

    objectText += `🏗 ${r[0]}\n`;
    objectText += `Қарз: ${formatSum(r[1])}\n`;
    objectText += `Тўланган: ${formatSum(r[2])}\n`;
    objectText += `Аванс: ${formatSum(r[3])}\n`;
    objectText += `Соф ҳолат: ${formatSum(r[4])}\n\n`;
  });

  await ctx.reply(supplierText);
  await ctx.reply(objectText);
});

// ================= TOTAL =================
bot.hears("📋 қарз ҳисобот", async ctx => {
  const rows = await getValues("Директор_Ҳисобот!A4:F100", "total", false);

  let debt = 0;
  let advance = 0;
  let net = 0;

  rows.forEach(r => {
    if (!r[0]) return;

    debt += Number(r[2] || 0);
    advance += Number(r[3] || 0);
    net += Number(r[4] || 0);
  });

  ctx.reply(
    `📋 Умумий ҳисобот\n\n` +
    `Қарз: ${formatSum(debt)}\n` +
    `Аванс: ${formatSum(advance)}\n` +
    `Соф ҳолат: ${formatSum(net)}`
  );
});

// ================= ERROR =================
bot.catch(err => {
  console.log("ERROR:", err);
});

// ================= SERVER =================
const express = require("express");
const app = express();

app.use(bot.webhookCallback("/bot"));

app.get("/", (req, res) => res.send("Bot работает"));

app.listen(process.env.PORT || 3000, async () => {
  await bot.telegram.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/bot`);
  console.log("Server started");
});
