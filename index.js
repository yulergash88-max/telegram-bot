const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { google } = require("googleapis");
const NodeCache = require("node-cache");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const cache = new NodeCache({ stdTTL: 300 });
const sessions = {};
const SHEET_ID = process.env.SHEET_ID;

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });

function menu() {
  return Markup.keyboard([
    ["📦 Қарзга олиш"],
    ["💳 Тўлов учун ариза"],
    ["📊 Директор ҳисобот"],
    ["📋 Қарз ҳисобот"]
  ]).resize();
}

function backMenu() {
  return Markup.keyboard([["⬅️ Орқага"]]).resize();
}

function cleanNumber(text) {
  return Number(String(text).replace(/\s/g, "").replace(/,/g, "").replace(/\./g, ""));
}

function formatSum(n) {
  return Number(n || 0).toLocaleString("ru-RU");
}

function validInn(inn) {
  return /^\d{9}$/.test(String(inn).trim());
}

function active(v) {
  return v === true || String(v || "").toUpperCase() === "TRUE" || v === "" || v === undefined;
}

async function getValues(range, key, useCache = true) {
  if (useCache) {
    const cached = cache.get(key);
    if (cached) return cached;
  }

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

async function getObjects() {
  const rows = await getValues("Объектлар!A2:B", "objects");
  return rows.filter(r => r[0] && active(r[1])).map(r => r[0]);
}

async function getSuppliers() {
  const rows = await getValues("Етказиб_берувчилар!A2:E", "suppliers");
  return rows.filter(r => r[0] && active(r[4])).map(r => `${r[0]} — ${r[1] || ""}`);
}

async function getMaterials() {
  const rows = await getValues("Материаллар_хизматлар!A2:C", "materials");
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

async function getUsers(permission) {
  const rows = await getValues("Ходимлар!A2:H", "users");
  const map = {
    create: 3,
    director: 4,
    accountant: 5,
    pay: 6
  };

  return rows
    .filter(r => r[0] && active(r[7]) && active(r[map[permission]]))
    .map(r => ({ id: r[0], name: r[1] }));
}

async function getUser(chatId) {
  const rows = await getValues("Ходимлар!A2:H", "users");
  const r = rows.find(x => String(x[0]) === String(chatId) && active(x[7]));

  if (!r) return null;

  return {
    id: r[0],
    name: r[1],
    canCreate: active(r[3]),
    canDirector: active(r[4]),
    canAccountant: active(r[5]),
    canPay: active(r[6])
  };
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

async function getSupplierBalance(object, supplier, inn) {
  const debts = await getValues("Қарзлар!A2:M", "debts", false);
  const advances = await getValues("Аванслар!A2:M", "advances", false);

  let debt = 0;
  let advance = 0;

  debts.forEach(r => {
    if (r[4] === object && r[5] === supplier && String(r[6]) === String(inn)) {
      debt += Number(r[10] || 0);
    }
  });

  advances.forEach(r => {
    if (r[4] === object && r[5] === supplier && String(r[6]) === String(inn)) {
      advance += Number(r[10] || 0);
    }
  });

  return { debt, advance, net: debt - advance };
}

bot.start(async ctx => {
  const user = await getUser(ctx.chat.id);

  if (!user) {
    await ctx.reply("❌ Сиз Ходимлар листида йўқсиз.\n\nСизнинг Telegram ID: " + ctx.chat.id);
    return;
  }

  sessions[ctx.chat.id] = null;
  await ctx.reply("Асосий меню", menu());
});

bot.hears("⬅️ Орқага", async ctx => {
  sessions[ctx.chat.id] = null;
  await ctx.reply("Асосий меню", menu());
});

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

bot.hears("📋 Қарз ҳисобот", async ctx => {
  const debts = await getValues("Қарзлар!A2:M", "debts", false);
  const advances = await getValues("Аванслар!A2:M", "advances", false);

  let debtTotal = 0;
  let advanceTotal = 0;

  debts.forEach(r => debtTotal += Number(r[10] || 0));
  advances.forEach(r => advanceTotal += Number(r[10] || 0));

  const net = debtTotal - advanceTotal;

  await ctx.reply(
    `📋 Умумий қарз ҳисобот\n\n` +
    `Жами қарз: ${formatSum(debtTotal)} сўм\n` +
    `Жами аванс: ${formatSum(advanceTotal)} сўм\n` +
    `Соф ҳолат: ${formatSum(Math.abs(net))} сўм ${net > 0 ? "қарз" : net < 0 ? "аванс" : "0"}`,
    menu()
  );
});

bot.hears("📊 Директор ҳисобот", async ctx => {
  const user = await getUser(ctx.chat.id);

  if (!user || !user.canDirector) {
    await ctx.reply("❌ Сизда директор ҳисоботини кўриш ҳуқуқи йўқ.");
    return;
  }

  const debts = await getValues("Қарзлар!A2:M", "debts", false);
  const advances = await getValues("Аванслар!A2:M", "advances", false);

  const supplierMap = {};
  const objectMap = {};

  debts.forEach(r => {
    const object = r[4] || "Номаълум объект";
    const supplier = r[5] || "Номаълум";
    const inn = r[6] || "";
    const debtBalance = Number(r[10] || 0);
    const paid = Number(r[9] || 0);

    const supplierKey = supplier + " — " + inn;

    if (!supplierMap[supplierKey]) {
      supplierMap[supplierKey] = { debt: 0, advance: 0 };
    }

    supplierMap[supplierKey].debt += debtBalance;

    if (!objectMap[object]) {
      objectMap[object] = { debt: 0, paid: 0, advance: 0 };
    }

    objectMap[object].debt += debtBalance;
    objectMap[object].paid += paid;
  });

  advances.forEach(r => {
    const object = r[4] || "Номаълум объект";
    const supplier = r[5] || "Номаълум";
    const inn = r[6] || "";
    const advanceBalance = Number(r[10] || 0);

    const supplierKey = supplier + " — " + inn;

    if (!supplierMap[supplierKey]) {
      supplierMap[supplierKey] = { debt: 0, advance: 0 };
    }

    supplierMap[supplierKey].advance += advanceBalance;

    if (!objectMap[object]) {
      objectMap[object] = { debt: 0, paid: 0, advance: 0 };
    }

    objectMap[object].advance += advanceBalance;
  });

  let supplierText = "📊 ЕТКАЗИБ БЕРУВЧИЛАР\n\n";

  Object.keys(supplierMap).forEach(name => {
    const x = supplierMap[name];
    const net = x.debt - x.advance;

    supplierText += `🏢 ${name}\n`;
    supplierText += `Қарз: ${formatSum(x.debt)} сўм\n`;
    supplierText += `Аванс: ${formatSum(x.advance)} сўм\n`;
    supplierText += `Соф: ${formatSum(Math.abs(net))} сўм ${net > 0 ? "қарз" : net < 0 ? "аванс" : "0"}\n\n`;
  });

  let objectText = "🏗 ОБЪЕКТЛАР\n\n";

  Object.keys(objectMap).forEach(name => {
    const x = objectMap[name];
    const net = x.debt - x.advance;

    objectText += `🏗 ${name}\n`;
    objectText += `Қарз: ${formatSum(x.debt)} сўм\n`;
    objectText += `Тўланган: ${formatSum(x.paid)} сўм\n`;
    objectText += `Аванс: ${formatSum(x.advance)} сўм\n`;
    objectText += `Соф ҳолат: ${formatSum(Math.abs(net))} сўм ${net > 0 ? "қарз" : net < 0 ? "аванс" : "0"}\n\n`;
  });

  if (supplierText.length > 3500) {
    await ctx.reply(supplierText.slice(0, 3500) + "\n\nДавоми Google Sheets ҳисоботда.");
  } else {
    await ctx.reply(supplierText);
  }

  if (objectText.length > 3500) {
    await ctx.reply(objectText.slice(0, 3500) + "\n\nДавоми Google Sheets ҳисоботда.", menu());
  } else {
    await ctx.reply(objectText, menu());
  }
});

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

    cache.del("debts");

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
    sum: Number(r[9] || 0)
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

  cache.del("payments_live");
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
      Number(r[10] || 0) > 0 &&
      left > 0
    ) {
      const rowNum = i + 2;
      const debtSum = Number(r[8] || 0);
      const paidOld = Number(r[9] || 0);
      const balance = Number(r[10] || 0);
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

  cache.del("debts");
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

  cache.del("advances");
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

app.use(bot.webhookCallback("/bot"));

app.get("/", (req, res) => {
  res.send("Bot ishlayapti");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server started on " + PORT);
});
