const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { google } = require("googleapis");
const NodeCache = require("node-cache");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const cache = new NodeCache({ stdTTL: 60 });
const sessions = {};
const SHEET_ID = process.env.SHEET_ID;

// GOOGLE AUTH
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });

// ================= HELPERS =================

function active(v) {
  return String(v || "").trim().toUpperCase() === "TRUE";
}

function cleanNumber(text) {
  return Number(String(text).replace(/\s/g, "").replace(/,/g, "").replace(/\./g, ""));
}

function toNumber(v) {
  if (v === undefined || v === null || v === "") return 0;
  return Number(String(v).replace(/\s/g, "").replace(/,/g, "").replace(/\./g, "")) || 0;
}

function formatSum(n) {
  return Number(n || 0).toLocaleString("ru-RU");
}

function validInn(inn) {
  return /^\d{9}$/.test(String(inn).trim());
}

function menu() {
  return Markup.keyboard([
    ["📦 Қарзга олиш"],
    ["💳 Тўлов учун ариза"],
    ["📊 директор ҳисобот"],
    ["📋 қарз ҳисобот"]
  ]).resize();
}

function backMenu() {
  return Markup.keyboard([["⬅️ Орқага"]]).resize();
}

async function getValues(range, key, useCache = true) {
  if (useCache && cache.has(key)) return cache.get(key);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  });

  const rows = res.data.values || [];
  if (useCache) cache.set(key, rows);
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

async function updateCell(range, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] }
  });
}

async function getUser(chatId) {
  const rows = await getValues("Ходимлар!A2:H", "users", false);
  const r = rows.find(x =>
    String(x[0]).trim() === String(chatId).trim() &&
    active(x[7])
  );

  if (!r) return null;

  return {
    id: String(r[0]).trim(),
    name: r[1],
    role: r[2],
    canCreate: active(r[3]),
    canDirector: active(r[4]),
    canAccountant: active(r[5]),
    canPay: active(r[6])
  };
}

async function getUsers(permission) {
  const rows = await getValues("Ходимлар!A2:H", "users", false);

  const map = {
    create: 3,
    director: 4,
    accountant: 5,
    pay: 6
  };

  return rows
    .filter(r => r[0] && active(r[7]) && active(r[map[permission]]))
    .map(r => ({ id: String(r[0]).trim(), name: r[1] }));
}

async function sendTo(permission, text, buttons) {
  const users = await getUsers(permission);

  for (const u of users) {
    try {
      if (buttons) {
        await bot.telegram.sendMessage(u.id, text, {
          reply_markup: { inline_keyboard: buttons }
        });
      } else {
        await bot.telegram.sendMessage(u.id, text);
      }
    } catch (e) {
      console.log("Send error:", u.id, e.message);
    }
  }
}

async function getObjects() {
  const rows = await getValues("Объектлар!A2:B", "objects", false);
  return rows.filter(r => r[0] && active(r[1])).map(r => r[0]);
}

async function getSuppliers() {
  const rows = await getValues("Етказиб_берувчилар!A2:E", "suppliers", false);
  return rows
    .filter(r => r[0] && active(r[4]))
    .map(r => `${r[0]} — ${r[1] || ""}`);
}

async function getMaterials() {
  const rows = await getValues("Материаллар_хизматлар!A2:C", "materials", false);
  return rows.filter(r => r[0] && active(r[2])).map(r => r[0]);
}

function supplierKeyboard(list) {
  return Markup.keyboard([
    ...list.map(x => [x]),
    ["➕ Янги етказиб берувчи"],
    ["⬅️ Орқага"]
  ]).resize();
}

function materialKeyboard(list) {
  return Markup.keyboard([
    ...list.map(x => [x]),
    ["➕ Янги материал/хизмат"],
    ["⬅️ Орқага"]
  ]).resize();
}

function parseSupplier(text) {
  const p = String(text).split(" — ");
  return {
    name: (p[0] || "").trim(),
    inn: (p[1] || "").trim()
  };
}

async function addSupplier(name, inn) {
  await append("Етказиб_берувчилар!A:E", [name, inn, "", "", "TRUE"]);
  cache.del("suppliers");
}

async function addMaterial(name) {
  await append("Материаллар_хизматлар!A:C", [name, "", "TRUE"]);
  cache.del("materials");
}

async function getSupplierBalance(object, supplier, inn) {
  const debts = await getValues("Қарзлар!A2:M", "debts", false);
  const advances = await getValues("Аванслар!A2:M", "advances", false);

  let debt = 0;
  let advance = 0;

  debts.forEach(r => {
    if (r[4] === object && r[5] === supplier && String(r[6]) === String(inn)) {
      debt += toNumber(r[10]);
    }
  });

  advances.forEach(r => {
    if (r[4] === object && r[5] === supplier && String(r[6]) === String(inn)) {
      advance += toNumber(r[10]);
    }
  });

  return { debt, advance, net: debt - advance };
}

// ================= START =================

bot.start(async ctx => {
  cache.flushAll();

  const user = await getUser(ctx.chat.id);

  if (!user) {
    await ctx.reply(`❌ Сиз Ходимлар листида йўқсиз.\n\nСизнинг Telegram ID: ${ctx.chat.id}`);
    return;
  }

  sessions[ctx.chat.id] = null;
  await ctx.reply("Асосий меню", menu());
});

bot.hears("⬅️ Орқага", async ctx => {
  sessions[ctx.chat.id] = null;
  await ctx.reply("Асосий меню", menu());
});

// ================= ҚАРЗГА ОЛИШ =================

bot.hears("📦 Қарзга олиш", async ctx => {
  const user = await getUser(ctx.chat.id);

  if (!user || !user.canCreate) {
    await ctx.reply("❌ Сизда ариза киритиш ҳуқуқи йўқ.");
    return;
  }

  sessions[ctx.chat.id] = { step: "debt_object", data: {} };

  const objects = await getObjects();
  await ctx.reply(
    "Объектни танланг:",
    Markup.keyboard([...objects.map(x => [x]), ["⬅️ Орқага"]]).resize()
  );
});

// ================= ТЎЛОВ АРИЗА =================

bot.hears("💳 Тўлов учун ариза", async ctx => {
  const user = await getUser(ctx.chat.id);

  if (!user || !user.canCreate) {
    await ctx.reply("❌ Сизда ариза киритиш ҳуқуқи йўқ.");
    return;
  }

  sessions[ctx.chat.id] = { step: "pay_type", data: {} };

  await ctx.reply(
    "Тўлов турини танланг:",
    Markup.keyboard([
      ["Қарз ёпиш"],
      ["Аванс ўтказиш"],
      ["⬅️ Орқага"]
    ]).resize()
  );
});

bot.hears(["Қарз ёпиш", "Аванс ўтказиш"], async ctx => {
  sessions[ctx.chat.id] = {
    step: "pay_object",
    data: { payType: ctx.message.text }
  };

  const objects = await getObjects();

  await ctx.reply(
    "Объектни танланг:",
    Markup.keyboard([...objects.map(x => [x]), ["⬅️ Орқага"]]).resize()
  );
});

// ================= ҲИСОБОТЛАР =================

bot.hears("📋 қарз ҳисобот", async ctx => {
  const rows = await getValues("Директор_Ҳисобот!A4:F100", "total_report", false);

  let debt = 0;
  let advance = 0;
  let net = 0;

  rows.forEach(r => {
    if (!r[0] || r[0] === "Етказиб берувчи") return;
    debt += toNumber(r[2]);
    advance += toNumber(r[3]);
    net += toNumber(r[4]);
  });

  await ctx.reply(
    `📋 Умумий қарз ҳисобот\n\n` +
    `Жами қарз: ${formatSum(debt)} сўм\n` +
    `Жами аванс: ${formatSum(advance)} сўм\n` +
    `Соф ҳолат: ${formatSum(net)} сўм`,
    menu()
  );
});

bot.hears("📊 директор ҳисобот", async ctx => {
  const user = await getUser(ctx.chat.id);

  if (!user || !user.canDirector) {
    await ctx.reply("❌ Сизда директор ҳисоботини кўриш ҳуқуқи йўқ.");
    return;
  }

  const supplierRows = await getValues("Директор_Ҳисобот!A4:F100", "director_supplier_report", false);
  const objectRows = await getValues("Директор_Ҳисобот!H4:L100", "director_object_report", false);

  let supplierText = "📊 ЕТКАЗИБ БЕРУВЧИЛАР\n\n";

  supplierRows.forEach(r => {
    const name = r[0];
    if (!name || name === "Етказиб берувчи") return;

    supplierText += `🏢 ${name} — ${r[1] || ""}\n`;
    supplierText += `Қарз: ${formatSum(toNumber(r[2]))} сўм\n`;
    supplierText += `Аванс: ${formatSum(toNumber(r[3]))} сўм\n`;
    supplierText += `Соф ҳолат: ${formatSum(toNumber(r[4]))} сўм\n`;
    supplierText += `Ҳолат: ${r[5] || ""}\n\n`;
  });

  let objectText = "🏗 ОБЪЕКТЛАР\n\n";

  objectRows.forEach(r => {
    const object = r[0];
    if (!object || object === "Объект") return;

    objectText += `🏗 ${object}\n`;
    objectText += `Қарз: ${formatSum(toNumber(r[1]))} сўм\n`;
    objectText += `Тўланган: ${formatSum(toNumber(r[2]))} сўм\n`;
    objectText += `Аванс: ${formatSum(toNumber(r[3]))} сўм\n`;
    objectText += `Соф ҳолат: ${formatSum(toNumber(r[4]))} сўм\n\n`;
  });

  await ctx.reply(supplierText || "Маълумот йўқ");
  await ctx.reply(objectText || "Маълумот йўқ", menu());
});

// ================= FORM FLOW =================

bot.on("text", async ctx => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;
  const s = sessions[chatId];

  if (!s) {
    await ctx.reply("Асосий меню", menu());
    return;
  }

  const d = s.data;

  if (s.step === "debt_object" || s.step === "pay_object") {
    const objects = await getObjects();

    if (!objects.includes(text)) {
      await ctx.reply("❌ Объект фақат рўйхатдан танланади.");
      return;
    }

    d.object = text;
    s.step = s.step === "debt_object" ? "debt_supplier" : "pay_supplier";

    const suppliers = await getSuppliers();
    await ctx.reply("Етказиб берувчини танланг ёки янги киритинг:", supplierKeyboard(suppliers));
    return;
  }

  if (s.step === "debt_supplier" || s.step === "pay_supplier") {
    if (text === "➕ Янги етказиб берувчи") {
      s.step = s.step === "debt_supplier" ? "debt_new_supplier_name" : "pay_new_supplier_name";
      await ctx.reply("Янги етказиб берувчи номини киритинг:", backMenu());
      return;
    }

    const sup = parseSupplier(text);

    if (!sup.name || !validInn(sup.inn)) {
      await ctx.reply("❌ Рўйхатдан танланг ёки янги етказиб берувчи киритинг.");
      return;
    }

    d.supplier = sup.name;
    d.supplierInn = sup.inn;

    const bal = await getSupplierBalance(d.object, d.supplier, d.supplierInn);

    await ctx.reply(
      `📌 Етказиб берувчи: ${d.supplier}\n` +
      `ИНН: ${d.supplierInn}\n\n` +
      `Олдинги қарз: ${formatSum(bal.debt)} сўм\n` +
      `Олдинги аванс: ${formatSum(bal.advance)} сўм\n` +
      `Соф ҳолат: ${formatSum(Math.abs(bal.net))} сўм ${bal.net > 0 ? "қарз" : bal.net < 0 ? "аванс" : "0"}`
    );

    s.step = s.step === "debt_supplier" ? "debt_material" : "pay_material";

    const materials = await getMaterials();
    await ctx.reply("Материал/хизматни танланг ёки янги киритинг:", materialKeyboard(materials));
    return;
  }

  if (s.step === "debt_new_supplier_name" || s.step === "pay_new_supplier_name") {
    d.supplier = text.trim();

    if (!d.supplier) {
      await ctx.reply("❌ Ном бўш бўлмасин.");
      return;
    }

    s.step = s.step === "debt_new_supplier_name" ? "debt_new_supplier_inn" : "pay_new_supplier_inn";
    await ctx.reply("ИНН киритинг. ИНН 9 рақам бўлиши шарт:");
    return;
  }

  if (s.step === "debt_new_supplier_inn" || s.step === "pay_new_supplier_inn") {
    if (!validInn(text)) {
      await ctx.reply("❌ ИНН нотўғри. 9 та рақам киритинг. Масалан: 123456789");
      return;
    }

    d.supplierInn = text.trim();
    await addSupplier(d.supplier, d.supplierInn);

    s.step = s.step === "debt_new_supplier_inn" ? "debt_material" : "pay_material";

    const materials = await getMaterials();
    await ctx.reply("✅ Етказиб берувчи сақланди.");
    await ctx.reply("Материал/хизматни танланг ёки янги киритинг:", materialKeyboard(materials));
    return;
  }

  if (s.step === "debt_material" || s.step === "pay_material") {
    if (text === "➕ Янги материал/хизмат") {
      s.step = s.step === "debt_material" ? "debt_new_material" : "pay_new_material";
      await ctx.reply("Янги материал/хизмат номини киритинг:", backMenu());
      return;
    }

    d.material = text;
    s.step = s.step === "debt_material" ? "debt_sum" : "pay_sum";

    await ctx.reply(s.step === "debt_sum" ? "Қарз суммасини киритинг:" : "Ўтказиладиган суммани киритинг:");
    return;
  }

  if (s.step === "debt_new_material" || s.step === "pay_new_material") {
    d.material = text.trim();

    if (!d.material) {
      await ctx.reply("❌ Материал/хизмат номи бўш бўлмасин.");
      return;
    }

    await addMaterial(d.material);

    s.step = s.step === "debt_new_material" ? "debt_sum" : "pay_sum";

    await ctx.reply("✅ Материал/хизмат сақланди.");
    await ctx.reply(s.step === "debt_sum" ? "Қарз суммасини киритинг:" : "Ўтказиладиган суммани киритинг:");
    return;
  }

  if (s.step === "debt_sum" || s.step === "pay_sum") {
    const sum = cleanNumber(text);

    if (!sum || sum <= 0) {
      await ctx.reply("❌ Суммани тўғри киритинг. Масалан: 25000000");
      return;
    }

    d.sum = sum;
    s.step = s.step === "debt_sum" ? "debt_comment" : "pay_comment";

    await ctx.reply("Изоҳ киритинг ёки '-' юборинг:");
    return;
  }

  if (s.step === "debt_comment") {
    d.comment = text;
    const id = "D-" + Date.now();

    await append("Қарзлар!A:M", [
      id,
      new Date().toLocaleString("ru-RU"),
      ctx.from.first_name || "",
      ctx.chat.id,
      d.object,
      d.supplier,
      d.supplierInn,
      d.material,
      d.sum,
      0,
      d.sum,
      "Очиқ",
      d.comment
    ]);

    cache.flushAll();

    await ctx.reply("✅ Қарз сақланди.", menu());

    await sendTo(
      "director",
      `📦 Янги қарзга олиш\n\nID: ${id}\nОбъект: ${d.object}\nЕтказиб берувчи: ${d.supplier}\nИНН: ${d.supplierInn}\nМатериал: ${d.material}\nСумма: ${formatSum(d.sum)} сўм`
    );

    sessions[chatId] = null;
    return;
  }

  if (s.step === "pay_comment") {
    d.comment = text;
    const id = "P-" + Date.now();

    await append("Тўлов_аризалар!A:O", [
      id,
      new Date().toLocaleString("ru-RU"),
      ctx.from.first_name || "",
      ctx.chat.id,
      d.object,
      d.payType,
      d.supplier,
      d.supplierInn,
      d.material,
      d.sum,
      "Директор тасдиғини кутяпти",
      "",
      "",
      "",
      d.comment
    ]);

    cache.flushAll();

    await ctx.reply("✅ Тўлов аризаси директорга юборилди.", menu());

    await sendTo(
      "director",
      `📢 Тўлов учун янги ариза\n\nID: ${id}\nОбъект: ${d.object}\nТўлов тури: ${d.payType}\nЕтказиб берувчи: ${d.supplier}\nИНН: ${d.supplierInn}\nМатериал: ${d.material}\nСумма: ${formatSum(d.sum)} сўм`,
      [[
        { text: "✅ Тасдиқлаш", callback_data: `approve|${id}` },
        { text: "❌ Рад этиш", callback_data: `reject|${id}` }
      ]]
    );

    sessions[chatId] = null;
    return;
  }
});

// ================= APPROVE/PAY =================

async function getPaymentRow(id) {
  const rows = await getValues("Тўлов_аризалар!A2:O", "payments_live", false);
  const idx = rows.findIndex(r => r[0] === id);

  if (idx === -1) return null;

  const r = rows[idx];

  return {
    rowNumber: idx + 2,
    id: r[0],
    object: r[4],
    payType: r[5],
    supplier: r[6],
    inn: r[7],
    material: r[8],
    sum: toNumber(r[9])
  };
}

async function setPaymentStatus(payment, status, userCol, dateCol) {
  await updateCell(`Тўлов_аризалар!K${payment.rowNumber}`, status);

  if (userCol) {
    await updateCell(`Тўлов_аризалар!${userCol}${payment.rowNumber}`, new Date().toLocaleString("ru-RU"));
  }

  if (dateCol) {
    await updateCell(`Тўлов_аризалар!${dateCol}${payment.rowNumber}`, new Date().toLocaleString("ru-RU"));
  }

  cache.flushAll();
}

async function closeDebt(payment) {
  if (payment.payType !== "Қарз ёпиш") return;

  const rows = await getValues("Қарзлар!A2:M", "debts", false);
  let left = payment.sum;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];

    if (
      r[4] === payment.object &&
      r[5] === payment.supplier &&
      String(r[6]) === String(payment.inn) &&
      r[7] === payment.material &&
      toNumber(r[10]) > 0 &&
      left > 0
    ) {
      const rowNum = i + 2;
      const debtSum = toNumber(r[8]);
      const paidOld = toNumber(r[9]);
      const balance = toNumber(r[10]);
      const payNow = Math.min(balance, left);

      const newPaid = paidOld + payNow;
      const newBalance = debtSum - newPaid;
      const status = newBalance <= 0 ? "Ёпилди" : "Қисман ёпилди";

      await updateCell(`Қарзлар!J${rowNum}`, newPaid);
      await updateCell(`Қарзлар!K${rowNum}`, newBalance);
      await updateCell(`Қарзлар!L${rowNum}`, status);

      left -= payNow;
    }
  }

  cache.flushAll();
}

async function saveAdvance(payment) {
  if (payment.payType !== "Аванс ўтказиш") return;

  const id = "A-" + Date.now();

  await append("Аванслар!A:M", [
    id,
    new Date().toLocaleString("ru-RU"),
    "",
    "",
    payment.object,
    payment.supplier,
    payment.inn,
    payment.material,
    payment.sum,
    0,
    payment.sum,
    "Очиқ",
    "Тўлов аризаси: " + payment.id
  ]);

  cache.flushAll();
}

bot.action(/approve\|(.+)/, async ctx => {
  const user = await getUser(ctx.from.id);

  if (!user || !user.canDirector) {
    await ctx.answerCbQuery("Рухсат йўқ");
    return;
  }

  const id = ctx.match[1];
  const payment = await getPaymentRow(id);

  if (!payment) {
    await ctx.reply("❌ Ариза топилмади.");
    return;
  }

  await setPaymentStatus(payment, "Бухгалтер тўловини кутяпти", "L", null);
  await ctx.reply("✅ Ариза тасдиқланди.");

  await sendTo(
    "pay",
    `💰 Тўлов топшириғи\n\nID: ${id}\nОбъект: ${payment.object}\nТўлов тури: ${payment.payType}\nЕтказиб берувчи: ${payment.supplier}\nИНН: ${payment.inn}\nМатериал: ${payment.material}\nСумма: ${formatSum(payment.sum)} сўм`,
    [[{ text: "✅ Тўланди", callback_data: `paid|${id}` }]]
  );

  await ctx.answerCbQuery();
});

bot.action(/reject\|(.+)/, async ctx => {
  const user = await getUser(ctx.from.id);

  if (!user || !user.canDirector) {
    await ctx.answerCbQuery("Рухсат йўқ");
    return;
  }

  const id = ctx.match[1];
  const payment = await getPaymentRow(id);

  if (!payment) {
    await ctx.reply("❌ Ариза топилмади.");
    return;
  }

  await setPaymentStatus(payment, "Рад этилди", "L", null);
  await ctx.reply("❌ Ариза рад этилди.");
  await ctx.answerCbQuery();
});

bot.action(/paid\|(.+)/, async ctx => {
  const user = await getUser(ctx.from.id);

  if (!user || !user.canPay) {
    await ctx.answerCbQuery("Рухсат йўқ");
    return;
  }

  const id = ctx.match[1];
  const payment = await getPaymentRow(id);

  if (!payment) {
    await ctx.reply("❌ Ариза топилмади.");
    return;
  }

  await setPaymentStatus(payment, "Тўланди", "M", "N");
  await closeDebt(payment);
  await saveAdvance(payment);

  await ctx.reply("✅ Тўлов бажарилди.");
  await ctx.answerCbQuery();
});

// ================= SERVER =================

app.use(bot.webhookCallback("/bot"));

app.get("/", (req, res) => {
  res.send("Bot ishlayapti");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server started on " + PORT);
});
