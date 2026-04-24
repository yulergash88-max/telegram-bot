const express = require("express");
const { Telegraf } = require("telegraf");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// START
bot.start((ctx) => {
  ctx.reply("Асосий меню", {
    reply_markup: {
      keyboard: [
        ["📦 Қарзга олиш"],
        ["💳 Тўлов учун ариза"]
      ],
      resize_keyboard: true
    }
  });
});

bot.hears("📦 Қарзга олиш", (ctx) => {
  ctx.reply("Қарз киритиш бошланди");
});

bot.hears("💳 Тўлов учун ариза", (ctx) => {
  ctx.reply("Тўлов аризаси бошланди");
});

// WEBHOOK
app.use(bot.webhookCallback("/bot"));

app.get("/", (req, res) => {
  res.send("Bot ishlayapti");
});

app.listen(3000, () => {
  console.log("Server started");
});
