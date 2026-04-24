const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { google } = require("googleapis");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// ===== GOOGLE AUTH: ENV орқали =====
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

// private_key ичидаги \n муаммосини тўғрилайди
credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");

const auth = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });
const SHEET_ID = process.env.SHEET_ID;

// ===== МЕНЮ =====
function menu() {
  return Markup.keyboard([
    ["📦 Қарзга олиш"],
    ["💳 Тўлов учун ариза"]
  ]).resize();
}

// ===== START =====
bot.start(async (ctx) => {
  await ctx.reply("Асосий меню", menu());
});

// ===== TEST: GOOGLE SHEETS =====
bot.hears("💳 Тўлов учун ариза", async (ctx) => {
  try {
    await ctx.reply("Тўлов киритиш бошланди...");

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Test!A:B",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [new Date().toLocaleString("ru-RU"), "TEST OK"]
        ]
      }
    });

    await ctx.reply("✅ Google Sheets ишлади", menu());
  } catch (err) {
    console.error("Sheets error:", err);
    await ctx.reply("❌ Google Sheets хатоси. Render Logs ни текширинг.");
  }
});

// ===== ҚАРЗГА ОЛИШ TEST =====
bot.hears("📦 Қарзга олиш", async (ctx) => {
  await ctx.reply("Қарзга олиш қисми кейин уланади.", menu());
});

// ===== SERVER =====
app.use(bot.webhookCallback("/bot"));

app.get("/", (req, res) => {
  res.send("Bot ishlayapti");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server started on " + PORT);
});
