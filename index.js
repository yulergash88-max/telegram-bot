const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { google } = require("googleapis");
const NodeCache = require("node-cache");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const cache = new NodeCache({ stdTTL: 60 });
const sessions = {};
const botMessages = {};
const SHEET_ID = process.env.SHEET_ID;

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

async function sendClean(ctx, text, keyboard = null) {
  const chatId = ctx.chat.id;

  if (botMessages[chatId]) {
    for (const msgId of botMessages[chatId]) {
      try { await ctx.deleteMessage(msgId); } catch (e) {}
    }
  }

  botMessages[chatId] = [];

  const msg = keyboard ? await ctx.reply(text, keyboard) : await ctx.reply(text);
  botMessages[chatId].push(msg.message_id);
  return msg;
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
  const map = { create: 3, director: 4, accountant: 5, pay: 6 };

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

// ================= DIRECTORIES =================

async function getObjects() {
  const rows = await getValues("Объектлар!A2:B", "objects", false);
  return rows.filter(r => r[0] && active(r[1])).map(r => r[0]);
}

async function getSuppliersRaw() {
  return await getValues("Етказиб_берувчилар!A2:E", "suppliers", false);
}

async function getSuppliers() {
  const rows = await getSuppliersRaw();
  return rows
    .filter(r => r[0] && active(r[4]))
    .map(r => `${r[0]} — ${r[1] || ""}`);
}

async function findSupplierByInn(inn) {
  const rows = await getSuppliersRaw();
  const found = rows.find(r => String(r[1] || "").trim() === String(inn).trim() && active(r[4]));
  if (!found) return null;
  return { name: found[0], inn: found[1] };
}

async function getMaterialsRaw() {
  return await getValues("Материаллар_хизматлар!A2:C", "materials", false);
}

async function getMaterials() {
  const rows = await getMaterialsRaw();
  return rows.filter(r => r[0] && active(r[2])).map(r => r[0]);
}

function supplierKeyboard(list) {
  return Markup.keyboard([
    ...list.map(x => [x]),
    ["🔎 ИНН бўйича қидириш"],
    ["➕ Янги етказиб берувчи"],
    ["⬅️ Орқага"]
  ]).resize();
}

function materialKeyboard(list) {
  return Markup.keyboard([
    ...list.map(x => [x]),
    ["🔎 Материал қидириш"],
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
  const rows = await getSuppliersRaw();

  const exists = rows.find(r =>
    String(r[1] || "").trim() === String(inn).trim()
  );

  if (exists) {
    return { ok: false, name: exists[0], inn: exists[1] };
  }

  await append("Етказиб_берувчилар!A:E", [name, inn, "", "", "TRUE"]);
  cache.flushAll();

  return { ok: true, name, inn };
}

async function addMaterial(name) {
  const rows = await getMaterialsRaw();

  const exists = rows.find(r =>
    String(r[0] || "").trim().toLowerCase() === String(name).trim().toLowerCase()
  );

  if (!exists) {
    await append("Материаллар_хизматлар!A:C", [name, "", "TRUE"]);
  }

  cache.flushAll();
}

async function getSupplierBalance(object, supplier, inn) {
  const debts = await getValues("Қарзлар!A2:N", "debts", false);
  const advances = await getValues("Аванслар!A2:M", "advances", false);

  let debt = 0;
  let advance = 0;

  debts.forEach(r => {
    if (r[4] === object && r[5] === supplier && String(r[6]) === String(inn)) {
      debt += toNumber(r[11]);
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
    await sendClean(ctx, `❌ Сиз Ходимлар листида йўқсиз.\n\nСизнинг Telegram ID: ${ctx.chat.id}`);
    return;
  }

  sessions[ctx.chat.id] = null;
  await sendClean(ctx, "Асосий меню", menu());
});

bot.hears("⬅️ Орқага", async ctx => {
  sessions[ctx.chat.id] = null;
  await sendClean(ctx, "Асосий меню", menu());
});

// ================= MAIN BUTTONS =================

bot.hears("📦 Қарзга олиш", async ctx => {
  const user = await getUser(ctx.chat.id);

  if (!user || !user.canCreate) {
    await sendClean(ctx, "❌ Сизда ариза киритиш ҳуқуқи йўқ.");
    return;
  }

  sessions[ctx.chat.id] = { step: "debt_object", data: {} };

  const objects = await getObjects();
  await sendClean(
    ctx,
    "Объектни танланг:",
    Markup.keyboard([...objects.map(x => [x]), ["⬅️ Орқага"]]).resize()
  );
});

bot.hears("💳 Тўлов учун ариза", async ctx => {
  const user = await getUser(ctx.chat.id);

  if (!user || !user.canCreate) {
    await sendClean(ctx, "❌ Сизда ариза киритиш ҳуқуқи йўқ.");
    return;
  }

  sessions[ctx.chat.id] = { step: "pay_type", data: {} };

  await sendClean(
    ctx,
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

  await sendClean(
    ctx,
    "Объектни танланг:",
    Markup.keyboard([...objects.map(x => [x]), ["⬅️ Орқага"]]).resize()
  );
});

// ================= REPORTS =================

bot.hears("📋 қарз ҳисобот", async ctx => {
  const rows = await getValues("Директор_Ҳисобот!A4:F100", "total_report", false);

  let debt = 0;
  let advance = 0;
  let net = 0;

  rows.forEach(r => {
    if (!r[0] || r[0] === "Етказиб берувчи" || r[0] === "#N/A") return;
    debt += toNumber(r[2]);
    advance += toNumber(r[3]);
    net += toNumber(r[4]);
  });

  await sendClean(
    ctx,
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
    await sendClean(ctx, "❌ Сизда директор ҳисоботини кўриш ҳуқуқи йўқ.");
    return;
  }

  const supplierRows = await getValues("Директор_Ҳисобот!A4:F100", "director_supplier_report", false);
  const objectRows = await getValues("Директор_Ҳисобот!H4:L100", "director_object_report", false);

  let supplierText = "📊 ЕТКАЗИБ БЕРУВЧИЛАР\n\n";

  supplierRows.forEach(r => {
    const name = r[0];
    if (!name || name === "Етказиб берувчи" || name === "#N/A") return;

    supplierText += `🏢 ${name} — ${r[1] || ""}\n`;
    supplierText += `Қарз: ${formatSum(toNumber(r[2]))} сўм\n`;
    supplierText += `Аванс: ${formatSum(toNumber(r[3]))} сўм\n`;
    supplierText += `Соф ҳолат: ${formatSum(toNumber(r[4]))} сўм\n`;
    supplierText += `Ҳолат: ${r[5] || ""}\n\n`;
  });

  let objectText = "🏗 ОБЪЕКТЛАР\n\n";

  objectRows.forEach(r => {
    const object = r[0];
    if (!object || object === "Объект" || object === "#N/A") return;

    objectText += `🏗 ${object}\n`;
    objectText += `Қарз: ${formatSum(toNumber(r[1]))} сўм\n`;
    objectText += `Тўланган: ${formatSum(toNumber(r[2]))} сўм\n`;
    objectText += `Аванс: ${formatSum(toNumber(r[3]))} сўм\n`;
    objectText += `Соф ҳолат: ${formatSum(toNumber(r[4]))} сўм\n\n`;
  });

  await sendClean(ctx, supplierText || "Маълумот йўқ");
  await ctx.reply(objectText || "Маълумот йўқ", menu());
});

// ================= FORM FLOW =================

bot.on("text", async ctx => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;
  const s = sessions[chatId];

  if (!s) {
    await sendClean(ctx, "Асосий меню", menu());
    return;
  }

  const d = s.data;

  if (s.step === "debt_object" || s.step === "pay_object") {
    const objects = await getObjects();

    if (!objects.includes(text)) {
      await sendClean(ctx, "❌ Объект фақат рўйхатдан танланади.");
      return;
    }

    d.object = text;
    s.step = s.step === "debt_object" ? "debt_supplier" : "pay_supplier";

    const suppliers = await getSuppliers();
    await sendClean(ctx, "Етказиб берувчини танланг ёки янги киритинг:", supplierKeyboard(suppliers));
    return;
  }

  if (s.step === "debt_supplier" || s.step === "pay_supplier") {
    if (text === "🔎 ИНН бўйича қидириш") {
      s.step = s.step === "debt_supplier" ? "debt_supplier_search_inn" : "pay_supplier_search_inn";
      await sendClean(ctx, "Қидириш учун ИНН киритинг:");
      return;
    }

    if (text === "➕ Янги етказиб берувчи") {
      s.step = s.step === "debt_supplier" ? "debt_new_supplier_name" : "pay_new_supplier_name";
      await sendClean(ctx, "Янги етказиб берувчи номини киритинг:", backMenu());
      return;
    }

    const sup = parseSupplier(text);

    if (!sup.name || !validInn(sup.inn)) {
      await sendClean(ctx, "❌ Рўйхатдан танланг ёки янги етказиб берувчи киритинг.");
      return;
    }

    d.supplier = sup.name;
    d.supplierInn = sup.inn;

    const bal = await getSupplierBalance(d.object, d.supplier, d.supplierInn);

    await sendClean(
      ctx,
      `📌 Етказиб берувчи: ${d.supplier}\n` +
      `ИНН: ${d.supplierInn}\n\n` +
      `Олдинги қарз: ${formatSum(bal.debt)} сўм\n` +
      `Олдинги аванс: ${formatSum(bal.advance)} сўм\n` +
      `Соф ҳолат: ${formatSum(Math.abs(bal.net))} сўм ${bal.net > 0 ? "қарз" : bal.net < 0 ? "аванс" : "0"}`
    );

    s.step = s.step === "debt_supplier" ? "debt_material" : "pay_material";

    const materials = await getMaterials();
    await sendClean(ctx, "Материал/хизматни танланг ёки янги киритинг:", materialKeyboard(materials));
    return;
  }

  if (s.step === "debt_supplier_search_inn" || s.step === "pay_supplier_search_inn") {
    if (!validInn(text)) {
      await sendClean(ctx, "❌ ИНН 9 та рақам бўлиши керак.");
      return;
    }

    const supplier = await findSupplierByInn(text.trim());

    if (!supplier) {
      s.step = s.step === "debt_supplier_search_inn" ? "debt_new_supplier_name" : "pay_new_supplier_name";
      d.supplierInn = text.trim();
      await sendClean(ctx, "❌ Бу ИНН топилмади. Янги етказиб берувчи номини киритинг:");
      return;
    }

    d.supplier = supplier.name;
    d.supplierInn = supplier.inn;

    const bal = await getSupplierBalance(d.object, d.supplier, d.supplierInn);

    await sendClean(
      ctx,
      `✅ Топилди:\n${d.supplier} — ${d.supplierInn}\n\n` +
      `Олдинги қарз: ${formatSum(bal.debt)} сўм\n` +
      `Олдинги аванс: ${formatSum(bal.advance)} сўм`
    );

    s.step = s.step === "debt_supplier_search_inn" ? "debt_material" : "pay_material";

    const materials = await getMaterials();
    await sendClean(ctx, "Материал/хизматни танланг ёки янги киритинг:", materialKeyboard(materials));
    return;
  }

  if (s.step === "debt_new_supplier_name" || s.step === "pay_new_supplier_name") {
    d.supplier = text.trim();

    if (!d.supplier) {
      await sendClean(ctx, "❌ Ном бўш бўлмасин.");
      return;
    }

    if (d.supplierInn && validInn(d.supplierInn)) {
      const result = await addSupplier(d.supplier, d.supplierInn);
      if (!result.ok) {
        d.supplier = result.name;
        d.supplierInn = result.inn;
      }

      s.step = s.step === "debt_new_supplier_name" ? "debt_material" : "pay_material";
      const materials = await getMaterials();
      await sendClean(ctx, "Материал/хизматни танланг ёки янги киритинг:", materialKeyboard(materials));
      return;
    }

    s.step = s.step === "debt_new_supplier_name" ? "debt_new_supplier_inn" : "pay_new_supplier_inn";
    await sendClean(ctx, "ИНН киритинг. ИНН 9 рақам бўлиши шарт:");
    return;
  }

  if (s.step === "debt_new_supplier_inn" || s.step === "pay_new_supplier_inn") {
    if (!validInn(text)) {
      await sendClean(ctx, "❌ ИНН нотўғри. 9 та рақам киритинг. Масалан: 123456789");
      return;
    }

    d.supplierInn = text.trim();

    const result = await addSupplier(d.supplier, d.supplierInn);

    if (!result.ok) {
      d.supplier = result.name;
      d.supplierInn = result.inn;

      await sendClean(
        ctx,
        `⚠️ Бу ИНН олдин киритилган.\n\n` +
        `Етказиб берувчи: ${result.name}\n` +
        `ИНН: ${result.inn}\n\n` +
        `Шу етказиб берувчи танланди.`
      );
    } else {
      await sendClean(ctx, "✅ Етказиб берувчи сақланди.");
    }

    s.step = s.step === "debt_new_supplier_inn" ? "debt_material" : "pay_material";

    const materials = await getMaterials();
    await sendClean(ctx, "Материал/хизматни танланг ёки янги киритинг:", materialKeyboard(materials));
    return;
  }

  if (s.step === "debt_material" || s.step === "pay_material") {
    if (text === "🔎 Материал қидириш") {
      s.step = s.step === "debt_material" ? "debt_material_search" : "pay_material_search";
      await sendClean(ctx, "Қидириш учун материал/хизмат номини ёзинг:");
      return;
    }

    if (text === "➕ Янги материал/хизмат") {
      s.step = s.step === "debt_material" ? "debt_new_material" : "pay_new_material";
      await sendClean(ctx, "Янги материал/хизмат номини киритинг:", backMenu());
      return;
    }

    d.material = text;
    s.step = s.step === "debt_material" ? "debt_qty" : "pay_sum";

    await sendClean(ctx, s.step === "debt_qty" ? "Миқдорини киритинг:" : "Ўтказиладиган суммани киритинг:");
    return;
  }

  if (s.step === "debt_material_search" || s.step === "pay_material_search") {
    const q = text.trim().toLowerCase();
    const materials = await getMaterials();
    const found = materials.filter(m => String(m).toLowerCase().includes(q));

    if (found.length === 0) {
      await sendClean(ctx, "❌ Материал топилмади. Янги киритиш ёки қайта қидириш мумкин:", materialKeyboard(materials));
      s.step = s.step === "debt_material_search" ? "debt_material" : "pay_material";
      return;
    }

    s.step = s.step === "debt_material_search" ? "debt_material" : "pay_material";
    await sendClean(ctx, "Топилган материаллар:", materialKeyboard(found));
    return;
  }

  if (s.step === "debt_new_material" || s.step === "pay_new_material") {
    d.material = text.trim();

    if (!d.material) {
      await sendClean(ctx, "❌ Материал/хизмат номи бўш бўлмасин.");
      return;
    }

    await addMaterial(d.material);

    s.step = s.step === "debt_new_material" ? "debt_qty" : "pay_sum";

    await sendClean(ctx, "✅ Материал/хизмат сақланди.");
    await sendClean(ctx, s.step === "debt_qty" ? "Миқдорини киритинг:" : "Ўтказиладиган суммани киритинг:");
    return;
  }

  if (s.step === "debt_qty") {
    const qty = cleanNumber(text);

    if (!qty || qty <= 0) {
      await sendClean(ctx, "❌ Миқдорни тўғри киритинг. Масалан: 10");
      return;
    }

    d.qty = qty;
    s.step = "debt_sum";

    await sendClean(ctx, "Қарз суммасини киритинг:");
    return;
  }

  if (s.step === "debt_sum" || s.step === "pay_sum") {
    const sum = cleanNumber(text);

    if (!sum || sum <= 0) {
      await sendClean(ctx, "❌ Суммани тўғри киритинг. Масалан: 25000000");
      return;
    }

    d.sum = sum;
    s.step = s.step === "debt_sum" ? "debt_comment" : "pay_comment";

    await sendClean(ctx, "Изоҳ киритинг ёки '-' юборинг:");
    return;
  }

  if (s.step === "debt_comment") {
    d.comment = text;
    const id = "D-" + Date.now();

    await append("Қарзлар!A:N", [
      id,
      new Date().toLocaleString("ru-RU"),
      ctx.from.first_name || "",
      ctx.chat.id,
      d.object,
      d.supplier,
      d.supplierInn,
      d.material,
      d.qty,
      d.sum,
      0,
      d.sum,
      "Очиқ",
      d.comment
    ]);

    cache.flushAll();

    await sendClean(ctx, "✅ Қарз сақланди.", menu());

    await sendTo(
      "director",
      `📦 Янги қарзга олиш\n\nID: ${id}\nОбъект: ${d.object}\nЕтказиб берувчи: ${d.supplier}\nИНН: ${d.supplierInn}\nМатериал: ${d.material}\nМиқдор: ${d.qty}\nСумма: ${formatSum(d.sum)} сўм`
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

    await sendClean(ctx, "✅ Тўлов аризаси директорга юборилди.", menu());

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

  const rows = await getValues("Қарзлар!A2:N", "debts", false);
  let left = payment.sum;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];

    if (
      r[4] === payment.object &&
      r[5] === payment.supplier &&
      String(r[6]) === String(payment.inn) &&
      r[7] === payment.material &&
      toNumber(r[11]) > 0 &&
      left > 0
    ) {
      const rowNum = i + 2;
      const debtSum = toNumber(r[9]);
      const paidOld = toNumber(r[10]);
      const balance = toNumber(r[11]);
      const payNow = Math.min(balance, left);

      const newPaid = paidOld + payNow;
      const newBalance = debtSum - newPaid;
      const status = newBalance <= 0 ? "Ёпилди" : "Қисман ёпилди";

      await updateCell(`Қарзлар!K${rowNum}`, newPaid);
      await updateCell(`Қарзлар!L${rowNum}`, newBalance);
      await updateCell(`Қарзлар!M${rowNum}`, status);

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
