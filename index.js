const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { google } = require("googleapis");
const NodeCache = require("node-cache");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const cache = new NodeCache({ stdTTL: 300 });

const sessions = {};

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });
const SHEET_ID = process.env.SHEET_ID;

function menu() {
  return Markup.keyboard([
    ["📦 Қарзга олиш"],
    ["💳 Тўлов учун ариза"]
  ]).resize();
}

function backKeyboard() {
  return Markup.keyboard([["⬅️ Орқага"]]).resize();
}

function makeKeyboard(items, addNewText) {
  const rows = items.map(x => [x]);
  rows.push([addNewText]);
  rows.push(["⬅️ Орқага"]);
  return Markup.keyboard(rows).resize();
}

function isInnValid(inn) {
  return /^\d{9}$/.test(String(inn).trim());
}

function cleanNumber(text) {
  return Number(String(text).replace(/\s/g, "").replace(/,/g, "").replace(/\./g, ""));
}

function formatSum(n) {
  return Number(n || 0).toLocaleString("ru-RU");
}

async function getRows(range, cacheKey) {
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  });

  const rows = res.data.values || [];
  cache.set(cacheKey, rows);
  return rows;
}

async function appendRow(range, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] }
  });
}

async function getObjects() {
  const rows = await getRows("Объектлар!A2:B", "objects");
  return rows.filter(r => r[0] && String(r[1]).toUpperCase() === "TRUE").map(r => r[0]);
}

async function getSuppliers() {
  const rows = await getRows("Етказиб_берувчилар!A2:E", "suppliers");
  return rows
    .filter(r => r[0] && (String(r[4]).toUpperCase() === "TRUE" || !r[4]))
    .map(r => `${r[0]} — ${r[1] || ""}`);
}

async function getMaterials() {
  const rows = await getRows("Материаллар_хизматлар!A2:C", "materials");
  return rows
    .filter(r => r[0] && (String(r[2]).toUpperCase() === "TRUE" || !r[2]))
    .map(r => r[0]);
}

function parseSupplier(text) {
  const parts = String(text).split(" — ");
  return {
    name: parts[0].trim(),
    inn: (parts[1] || "").trim()
  };
}

async function addSupplier(name, inn) {
  await appendRow("Етказиб_берувчилар!A:E", [
    name,
    inn,
    "",
    "",
    "TRUE"
  ]);
  cache.del("suppliers");
}

async function addMaterial(name) {
  await appendRow("Материаллар_хизматлар!A:C", [
    name,
    "",
    "TRUE"
  ]);
  cache.del("materials");
}

async function savePaymentRequest(ctx, d) {
  const id = "P-" + Date.now();

  await appendRow("Тўлов_аризалар!A:O", [
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
    d.comment || ""
  ]);

  await ctx.reply(
    "✅ Тўлов учун ариза сақланди.\n\n" +
    `ID: ${id}\n` +
    `Объект: ${d.object}\n` +
    `Тўлов тури: ${d.payType}\n` +
    `Етказиб берувчи: ${d.supplier}\n` +
    `ИНН: ${d.supplierInn}\n` +
    `Материал/хизмат: ${d.material}\n` +
    `Сумма: ${formatSum(d.sum)} сўм`,
    menu()
  );
}

bot.start(async (ctx) => {
  sessions[ctx.chat.id] = null;
  await ctx.reply("Асосий меню", menu());
});

bot.hears("⬅️ Орқага", async (ctx) => {
  sessions[ctx.chat.id] = null;
  await ctx.reply("Асосий меню", menu());
});

bot.hears("💳 Тўлов учун ариза", async (ctx) => {
  sessions[ctx.chat.id] = {
    step: "pay_type",
    data: {}
  };

  await ctx.reply(
    "Тўлов турини танланг:",
    Markup.keyboard([
      ["Қарз ёпиш"],
      ["Аванс ўтказиш"],
      ["⬅️ Орқага"]
    ]).resize()
  );
});

bot.hears("📦 Қарзга олиш", async (ctx) => {
  await ctx.reply("Бу қисм кейинги босқичда уланади. Ҳозир тўлов аризани текширамиз.", menu());
});

bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;
  const session = sessions[chatId];

  if (!session) {
    await ctx.reply("Асосий меню", menu());
    return;
  }

  const d = session.data;

  if (session.step === "pay_type") {
    if (text !== "Қарз ёпиш" && text !== "Аванс ўтказиш") {
      await ctx.reply("❌ Тўлов турини танланг.");
      return;
    }

    d.payType = text;
    session.step = "pay_object";

    const objects = await getObjects();
    await ctx.reply("Объектни танланг:", Markup.keyboard([...objects.map(x => [x]), ["⬅️ Орқага"]]).resize());
    return;
  }

  if (session.step === "pay_object") {
    const objects = await getObjects();

    if (!objects.includes(text)) {
      await ctx.reply("❌ Объект фақат рўйхатдан танланади.");
      return;
    }

    d.object = text;
    session.step = "pay_supplier";

    const suppliers = await getSuppliers();
    await ctx.reply(
      "Етказиб берувчини танланг ёки янги киритинг:",
      makeKeyboard(suppliers, "➕ Янги етказиб берувчи")
    );
    return;
  }

  if (session.step === "pay_supplier") {
    if (text === "➕ Янги етказиб берувчи") {
      session.step = "pay_new_supplier_name";
      await ctx.reply("Янги етказиб берувчи номини киритинг:", backKeyboard());
      return;
    }

    const supplier = parseSupplier(text);

    if (!supplier.name || !isInnValid(supplier.inn)) {
      await ctx.reply("❌ Рўйхатдан танланг ёки янги етказиб берувчи киритинг.");
      return;
    }

    d.supplier = supplier.name;
    d.supplierInn = supplier.inn;

    session.step = "pay_material";
    const materials = await getMaterials();

    await ctx.reply(
      "Материал/хизматни танланг ёки янги киритинг:",
      makeKeyboard(materials, "➕ Янги материал/хизмат")
    );
    return;
  }

  if (session.step === "pay_new_supplier_name") {
    d.supplier = text.trim();

    if (!d.supplier) {
      await ctx.reply("❌ Ном бўш бўлмасин.");
      return;
    }

    session.step = "pay_new_supplier_inn";
    await ctx.reply("Етказиб берувчи ИНН рақамини киритинг. ИНН 9 рақам бўлиши шарт:");
    return;
  }

  if (session.step === "pay_new_supplier_inn") {
    if (!isInnValid(text)) {
      await ctx.reply("❌ ИНН нотўғри. ИНН фақат 9 та рақам бўлиши керак. Масалан: 123456789");
      return;
    }

    d.supplierInn = text.trim();
    await addSupplier(d.supplier, d.supplierInn);

    session.step = "pay_material";
    const materials = await getMaterials();

    await ctx.reply(
      "✅ Етказиб берувчи сақланди.\n\nМатериал/хизматни танланг ёки янги киритинг:",
      makeKeyboard(materials, "➕ Янги материал/хизмат")
    );
    return;
  }

  if (session.step === "pay_material") {
    if (text === "➕ Янги материал/хизмат") {
      session.step = "pay_new_material";
      await ctx.reply("Янги материал/хизмат номини киритинг:", backKeyboard());
      return;
    }

    d.material = text;
    session.step = "pay_sum";

    await ctx.reply("Ўтказиладиган суммани киритинг:");
    return;
  }

  if (session.step === "pay_new_material") {
    d.material = text.trim();

    if (!d.material) {
      await ctx.reply("❌ Материал/хизмат номи бўш бўлмасин.");
      return;
    }

    await addMaterial(d.material);

    session.step = "pay_sum";
    await ctx.reply("✅ Материал/хизмат сақланди.\n\nЎтказиладиган суммани киритинг:");
    return;
  }

  if (session.step === "pay_sum") {
    const sum = cleanNumber(text);

    if (!sum || sum <= 0) {
      await ctx.reply("❌ Суммани тўғри киритинг. Масалан: 25000000");
      return;
    }

    d.sum = sum;
    session.step = "pay_comment";

    await ctx.reply("Изоҳ киритинг ёки '-' юборинг:");
    return;
  }

  if (session.step === "pay_comment") {
    d.comment = text;
    await savePaymentRequest(ctx, d);
    sessions[chatId] = null;
    return;
  }
});

app.use(bot.webhookCallback("/bot"));

app.get("/", (req, res) => {
  res.send("Bot ishlayapti");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server started on " + PORT);
});
