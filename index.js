const { Telegraf, Markup } = require("telegraf");
const { google } = require("googleapis");

// ===== CONFIG =====
const bot = new Telegraf(process.env.BOT_TOKEN);

const SHEET_ID = process.env.SHEET_ID;

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// ===== TIME (UZ) =====
function nowUz() {
  return new Date().toLocaleString("ru-RU", {
    timeZone: "Asia/Tashkent",
  });
}

// ===== GET USERS =====
async function getUsers() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Ходимлар!A2:H",
  });
  return res.data.values || [];
}

// ===== ROLE CHECK =====
async function getUser(userId) {
  const users = await getUsers();
  return users.find((u) => u[0] == userId && u[7] == "TRUE");
}

// ===== SAVE PAYMENT =====
async function savePayment(data) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Тўлов_аризалар!A:N",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        data.id,
        nowUz(),
        data.user,
        data.userId,
        data.object,
        data.payType,
        data.supplier,
        data.inn,
        data.material || "",
        data.amount,
        "Кутилмоқда",
        "", "", "",
        data.comment || "",
        data.firma
      ]],
    },
  });
}

// ===== UPDATE STATUS =====
async function updateStatus(id, status, col) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Тўлов_аризалар!A2:N",
  });

  const rows = res.data.values;

  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] == id) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Тўлов_аризалар!K${i + 2}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[status]] },
      });

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Тўлов_аризалар!${col}${i + 2}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[nowUz()]] },
      });

      return;
    }
  }
}

// ===== GET PAYMENT =====
async function getPayment(id) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Тўлов_аризалар!A2:N",
  });

  return res.data.values.find(r => r[0] == id);
}

// ===== START =====
bot.start(async (ctx) => {
  const user = await getUser(ctx.from.id);

  if (!user) {
    return ctx.reply("❌ Сизга рухсат йўқ");
  }

  ctx.reply("Асосий меню", Markup.keyboard([
    ["📤 Тўлов учун ариза"],
    ["📊 директор ҳисобот"]
  ]).resize());
});

// ===== CREATE REQUEST =====
bot.hears("📤 Тўлов учун ариза", (ctx) => {
  ctx.session = {};
  ctx.reply("Объектни киритинг:");
});

bot.on("text", async (ctx) => {
  if (!ctx.session) return;

  if (!ctx.session.object) {
    ctx.session.object = ctx.message.text;
    return ctx.reply("Тўлов тури (Қарз ёпиш / Аванс):");
  }

  if (!ctx.session.type) {
    ctx.session.type = ctx.message.text;
    return ctx.reply("Етказиб берувчи:");
  }

  if (!ctx.session.supplier) {
    ctx.session.supplier = ctx.message.text;
    return ctx.reply("ИНН:");
  }

  if (!ctx.session.inn) {
    ctx.session.inn = ctx.message.text;
    return ctx.reply("Сумма:");
  }

  if (!ctx.session.amount) {
    ctx.session.amount = ctx.message.text;
    return ctx.reply("Фирма (қайси счётдан тўланади):");
  }

  if (!ctx.session.firma) {
    ctx.session.firma = ctx.message.text;

    const id = "P-" + Date.now();

    await savePayment({
      id,
      user: ctx.from.first_name,
      userId: ctx.from.id,
      object: ctx.session.object,
      payType: ctx.session.type,
      supplier: ctx.session.supplier,
      inn: ctx.session.inn,
      amount: ctx.session.amount,
      firma: ctx.session.firma,
    });

    // SEND TO DIRECTOR & ACCOUNTANT
    const users = await getUsers();

    users.forEach(async (u) => {
      if (u[2] == "директор" || u[2] == "бухгалтер") {
        await bot.telegram.sendMessage(u[0],
          `💰 Тўлов ариза\n\n` +
          `👤 ${ctx.from.first_name}\n` +
          `🏢 Фирма: ${ctx.session.firma}\n` +
          `📍 Объект: ${ctx.session.object}\n` +
          `💵 ${ctx.session.amount}\n`,
          Markup.inlineKeyboard([
            [
              Markup.button.callback("✅ Тасдиқлаш", `ok_${id}`),
              Markup.button.callback("❌ Рад этиш", `no_${id}`)
            ]
          ])
        );
      }
    });

    ctx.reply("✅ Ариза юборилди");
    ctx.session = null;
  }
});

// ===== APPROVE =====
bot.action(/ok_(.+)/, async (ctx) => {
  const id = ctx.match[1];
  const user = await getUser(ctx.from.id);

  if (!user) return;

  const role = user[2];

  if (role == "директор") {
    await updateStatus(id, "Директор тасдиқлади", "L");
  }

  if (role == "бухгалтер") {
    await updateStatus(id, "Тўланди", "M");

    const payment = await getPayment(id);

    // 🔥 ONLY IF PAID
    if (payment && payment[10] == "Тўланди") {
      // қарз ёпиш / аванс логика шу ерда
    }
  }

  ctx.answerCbQuery("✅ Тасдиқланди");
});

// ===== REJECT =====
bot.action(/no_(.+)/, async (ctx) => {
  const id = ctx.match[1];

  ctx.reply("❌ Рад сабабини ёзинг:");
  ctx.session = { reject: id };
});

bot.on("text", async (ctx) => {
  if (ctx.session?.reject) {
    const id = ctx.session.reject;

    await updateStatus(id, "Рад этилди", "L");

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Тўлов_аризалар!O2",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[ctx.message.text]] },
    });

    ctx.reply("❌ Рад этилди");
    ctx.session = null;
  }
});

// ===== REPORT =====
bot.hears("📊 директор ҳисобот", async (ctx) => {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Дашборд!A1:F20",
  });

  const rows = res.data.values;

  let text = "📊 Ҳисобот:\n\n";

  rows.forEach(r => {
    text += r.join(" | ") + "\n";
  });

  ctx.reply(text);
});

// ===== START BOT =====
bot.launch();
