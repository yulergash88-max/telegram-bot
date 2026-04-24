const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { google } = require("googleapis");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// ===== GOOGLE AUTH (ENV орқали) =====
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const auth = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });
const SHEET_ID = process.env.SHEET_ID;

// ===== UI =====
function menu() {
  return Markup.keyboard([
    ["📦 Қарзга олиш"],
    ["💳 Тўлов учун ариза"]
  ]).resize();
}

// ===== START =====
bot.start((ctx) => {
  ctx.reply("Асосий меню", menu());
});

// ===== ТЎЛОВ =====
bot.hears("💳 Тўлов учун ариза", async (ctx) => {
  ctx.reply("Тўлов киритиш бошланди");

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Test!A:B",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [new Date().toLocaleString(), "TEST OK"]
      ]
    }
  });

  ctx.reply("✅ Google Sheets ишлади");
});

// ===== SERVER =====
app.use(bot.webhookCallback("/bot"));

app.get("/", (req, res) => {
  res.send("Bot ishlayapti");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server started");
});
