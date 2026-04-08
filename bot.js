require('dotenv').config();

const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  PermissionsBitField, ChannelType, MessageFlags,
} = require("discord.js");
const Bottleneck = require("bottleneck");
const https = require("https");
const { google } = require("googleapis");

const DISCORD_TOKEN           = process.env.DISCORD_TOKEN;
const JSONBIN_BIN_ID          = process.env.JSONBIN_BIN_ID;
const JSONBIN_API_KEY         = process.env.JSONBIN_API_KEY;
const STATUS_CHANNEL_ID       = process.env.STATUS_CHANNEL_ID;
const GOOGLE_SHEET_ID         = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT  = process.env.GOOGLE_SERVICE_ACCOUNT;

const SUBSYSTEMS = [
  { id: "manipulator",   label: "Manipulator",     emoji: "🦾", color: 0xe74c3c },
  { id: "drivetrain",    label: "Drivetrain",       emoji: "🚗", color: 0xe67e22 },
  { id: "rf_antenna",   label: "RF & Antenna",     emoji: "📡", color: 0x3498db },
  { id: "vision",        label: "Vision & Cameras", emoji: "📷", color: 0x9b59b6 },
  { id: "power",         label: "Power",            emoji: "⚡", color: 0xf1c40f },
  { id: "onboard_comms", label: "Onboard Comms",   emoji: "🔌", color: 0x1abc9c },
  { id: "science",       label: "Science",          emoji: "🔬", color: 0x2ecc71 },
  { id: "automation",    label: "Automation",       emoji: "🤖", color: 0xe91e63 },
];

const FINANCE_GROUPS = [
  { id: "manipulator", label: "Manipulator", emoji: "🦾", subsystems: ["manipulator"],            color: 0xe74c3c },
  { id: "drivetrain",  label: "Drivetrain",  emoji: "🚗", subsystems: ["drivetrain"],             color: 0xe67e22 },
  { id: "comms",       label: "Comms",       emoji: "📡", subsystems: ["rf_antenna","vision"],    color: 0x3498db },
  { id: "electrical",  label: "Electrical",  emoji: "⚡", subsystems: ["power","onboard_comms"],  color: 0xf1c40f },
  { id: "science",     label: "Science",     emoji: "🔬", subsystems: ["science"],                color: 0x2ecc71 },
  { id: "automation",  label: "Automation",  emoji: "🤖", subsystems: ["automation"],             color: 0xe91e63 },
];

const DEFAULT_BUDGETS = {
  manipulator: 1000, drivetrain: 1000, comms: 1000,
  electrical: 1000, science: 1000, automation: 1000,
};

// ─────────────────────────────────────────
//  HELPER — reply then auto-delete after delay
// ─────────────────────────────────────────
async function replyAndDelete(interaction, content, delay = 5000) {
  await interaction.editReply({ content, components: [] });
  setTimeout(() => interaction.deleteReply().catch(() => {}), delay);
}

// ─────────────────────────────────────────
//  GOOGLE SHEETS
// ─────────────────────────────────────────
let sheetsClient = null;
function getSheets() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

async function ensureSheetHeaders() {
  const sheets  = getSheets();
  const headers = ["Receipt ID","Date","Who Paid","Finance Group","Item Description","Qty",
    "Est. Unit Cost (AUD)","Est. Total (AUD)","Final Unit Cost (AUD)","Final Total (AUD)",
    "Pre-Approved?","Reimbursement Status","Receipt Link","Notes"];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: "Sheet1!A1:N1" });
    if (!res.data.values?.length) {
      await sheets.spreadsheets.values.update({ spreadsheetId: GOOGLE_SHEET_ID, range: "Sheet1!A1", valueInputOption: "RAW", requestBody: { values: [headers] } });
      console.log("✅ Sheet headers written");
    }
  } catch (e) { console.error("Sheet header error:", e.message); }
}

async function appendExpenseRow(row) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID, range: "Sheet1!A1",
    valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

// ─────────────────────────────────────────
//  JSONBIN
// ─────────────────────────────────────────
const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 300 });

function jsonbinRequest(method, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.jsonbin.io", path: `/v3/b/${JSONBIN_BIN_ID}`, method,
      headers: { "Content-Type": "application/json", "X-Master-Key": JSONBIN_API_KEY, "X-Bin-Versioning": "false",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}) },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error("Bad JSON")); } });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

let store = null;

async function loadData() {
  const res = await jsonbinRequest("GET");
  const r   = res.record || {};
  store = {
    tasks:           r.tasks           || Object.fromEntries(SUBSYSTEMS.map((s) => [s.id, []])),
    messageId:       r.messageId       || null,
    leadMessageIds:  r.leadMessageIds  || {},
    leadChannelIds:  r.leadChannelIds  || {},
    logChannelId:    r.logChannelId    || null,
    budgetChannelId: r.budgetChannelId || null,
    budgetMessageId: r.budgetMessageId || null,
    budgets:         r.budgets         || { ...DEFAULT_BUDGETS },
    spent:           r.spent           || Object.fromEntries(FINANCE_GROUPS.map((g) => [g.id, 0])),
    pendingRequests: r.pendingRequests || [],
    receiptCounter:  r.receiptCounter  || 1,
  };
  for (const sub of SUBSYSTEMS) { if (!store.tasks[sub.id]) store.tasks[sub.id] = []; }
  for (const g of FINANCE_GROUPS) {
    if (!store.budgets[g.id]) store.budgets[g.id] = DEFAULT_BUDGETS[g.id] || 1000;
    if (store.spent[g.id] === undefined) store.spent[g.id] = 0;
  }
  return store;
}

const saveData = limiter.wrap(async () => { await jsonbinRequest("PUT", store); });

function makeId() { return Math.random().toString(36).slice(2, 10); }
function makeReceiptId() { const id = `RCP-${String(store.receiptCounter).padStart(4,"0")}`; store.receiptCounter++; return id; }
function fmtAUD(n) { return `$${Number(n).toFixed(2)}`; }

// ─────────────────────────────────────────
//  LOGS
// ─────────────────────────────────────────
async function getLogChannel(guild) {
  if (store.logChannelId) {
    try { return await guild.channels.fetch(store.logChannelId); } catch { store.logChannelId = null; }
  }
  const existing = guild.channels.cache.find((c) => c.name === "rover-logs");
  if (existing) { store.logChannelId = existing.id; return existing; }
  const ch = await guild.channels.create({ name: "rover-logs", type: ChannelType.GuildText, topic: "📋 URT Rover Bot — automatic task log" });
  store.logChannelId = ch.id;
  await saveData();
  return ch;
}

async function postLog(guild, embed) {
  try { const ch = await getLogChannel(guild); await ch.send({ embeds: [embed] }); }
  catch (e) { console.error("Log post failed:", e.message); }
}

function logEmbed(color, title, lines) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(lines.join("\n")).setTimestamp();
}

async function postSnapshot(guild) {
  const ch    = await getLogChannel(guild);
  const lines = SUBSYSTEMS.map((sub) => {
    const list = store.tasks[sub.id] || [];
    if (!list.length) return `${sub.emoji} **${sub.label}** — no tasks`;
    return `${sub.emoji} **${sub.label}**\n${list.map((t) => `  ${t.done ? "✅" : "⬜"} ${t.name} — ${t.assignees?.length ? t.assignees.map((id) => `<@${id}>`).join(", ") : "*unassigned*"}`).join("\n")}`;
  });
  const total = Object.values(store.tasks).flat().length;
  const done  = Object.values(store.tasks).flat().filter((t) => t.done).length;
  await ch.send({ embeds: [new EmbedBuilder().setColor(0x38bdf8).setTitle("📋 URT Rover — Full Task Snapshot").setDescription(lines.join("\n\n")).setFooter({ text: `${done}/${total} tasks complete — posted on bot startup` }).setTimestamp()] });
}

// ─────────────────────────────────────────
//  BUDGET DASHBOARD
// ─────────────────────────────────────────
function buildBudgetEmbed() {
  const lines = FINANCE_GROUPS.map((g) => {
    const budget = store.budgets[g.id] || 0;
    const spent  = store.spent[g.id]   || 0;
    const left   = budget - spent;
    const pct    = budget === 0 ? 0 : Math.min(100, Math.round((spent / budget) * 100));
    const bar    = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
    const dot    = left < 0 ? "🔴" : left < budget * 0.2 ? "🟡" : "🟢";
    const subs   = g.subsystems.map((sid) => SUBSYSTEMS.find((s) => s.id === sid)?.label).join(" + ");
    return `${g.emoji} **${g.label}** ${dot}\n\`${bar}\` ${pct}% spent\n${fmtAUD(spent)} / ${fmtAUD(budget)} — **${fmtAUD(left)} remaining**\n*${subs}*`;
  });
  const tb = Object.values(store.budgets).reduce((a, b) => a + b, 0);
  const ts = Object.values(store.spent).reduce((a, b) => a + b, 0);
  return new EmbedBuilder()
    .setTitle("💰  URT ROVER — BUDGET STATUS")
    .setColor(0x2ecc71)
    .setDescription(`**Total: ${fmtAUD(tb)}  |  Spent: ${fmtAUD(ts)}  |  Remaining: ${fmtAUD(tb - ts)}**\n\n━━━━━━━━━━━━━━━━━━━━━━\n\n` + lines.join("\n\n"))
    .setTimestamp()
    .setFooter({ text: "🟢 Healthy  🟡 Under 20%  🔴 Over budget" });
}

function buildBudgetButtons() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("log_expense")     .setLabel("💸 Log Expense")     .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("purchase_request").setLabel("📝 Purchase Request").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("set_budget")      .setLabel("⚙️ Set Budget")      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("refresh_budget")  .setLabel("🔄 Refresh")         .setStyle(ButtonStyle.Secondary),
  )];
}

async function updateBudgetDashboard(guild) {
  if (store.budgetChannelId) {
    try { await guild.channels.fetch(store.budgetChannelId); }
    catch { store.budgetChannelId = null; store.budgetMessageId = null; }
  }
  if (!store.budgetChannelId) {
    const existing = guild.channels.cache.find((c) => c.name === "budget-status");
    if (existing) { store.budgetChannelId = existing.id; store.budgetMessageId = null; }
    else {
      const ch = await guild.channels.create({ name: "budget-status", type: ChannelType.GuildText, topic: "💰 URT Rover budget tracker" });
      store.budgetChannelId = ch.id;
    }
  }
  try {
    const ch      = await guild.channels.fetch(store.budgetChannelId);
    const payload = { embeds: [buildBudgetEmbed()], components: buildBudgetButtons() };
    if (store.budgetMessageId) {
      try { const m = await ch.messages.fetch(store.budgetMessageId); await m.edit(payload); return; }
      catch { store.budgetMessageId = null; }
    }
    const fetched = await ch.messages.fetch({ limit: 10 });
    for (const msg of fetched.filter((m) => m.author.id === client.user.id).values()) { try { await msg.delete(); } catch {} }
    const m = await ch.send(payload);
    store.budgetMessageId = m.id;
  } catch (e) { console.error("Budget dashboard update failed:", e.message); }
}

// ─────────────────────────────────────────
//  TASK EMBEDS
// ─────────────────────────────────────────
function buildOverviewEmbed(tasks) {
  let td = 0, ta = 0;
  const sections = SUBSYSTEMS.map((sub) => {
    const list = tasks[sub.id] || [];
    const done = list.filter((t) => t.done).length;
    const total = list.length;
    td += done; ta += total;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
    return `${sub.emoji} **${sub.label}**\n\`${bar}\` ${String(pct).padStart(3)}%  (${done}/${total})${pct === 100 && total > 0 ? "  ✅" : ""}`;
  });
  const op = ta === 0 ? 0 : Math.round((td / ta) * 100);
  const ob = "█".repeat(Math.round(op / 10)) + "░".repeat(10 - Math.round(op / 10));
  return new EmbedBuilder().setTitle("🛸  URT ROVER — BUILD STATUS").setColor(0x38bdf8)
    .setDescription(`**Overall**\n\`${ob}\` ${op}%  (${td}/${ta} tasks)\n\n━━━━━━━━━━━━━━━━━━━━━━\n\n` + sections.join("\n\n"))
    .setTimestamp().setFooter({ text: "See your subsystem channel for details" });
}

function buildLeadEmbed(sub, tasks) {
  const list = tasks[sub.id] || [];
  const todo = list.filter((t) => !t.done);
  const done = list.filter((t) =>  t.done);
  const pct  = list.length === 0 ? 0 : Math.round((done.length / list.length) * 100);
  const bar  = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
  const fmt  = (t) => `> ${t.done ? "✅" : "⬜"} **${t.name}**\n> 👤 ${t.assignees?.length ? t.assignees.map((id) => `<@${id}>`).join(", ") : "*Unassigned*"}`;
  return new EmbedBuilder().setTitle(`${sub.emoji}  ${sub.label} — Task Board`).setColor(sub.color)
    .setDescription(`\`${bar}\` ${pct}%  (${done.length}/${list.length} tasks complete)`)
    .addFields(
      { name: `📋 Remaining (${todo.length})`, value: (todo.length > 0 ? todo.map(fmt).join("\n\n") : "*No remaining tasks*").slice(0, 1024) },
      { name: `✅ Completed (${done.length})`, value: (done.length > 0 ? done.map(fmt).join("\n\n") : "*None completed yet*").slice(0, 1024) },
    ).setTimestamp().setFooter({ text: "Use the buttons below to manage tasks" });
}

// ─────────────────────────────────────────
//  BUTTONS & MENUS
// ─────────────────────────────────────────
function buildOverviewButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("add_task")   .setLabel("➕ Add Task") .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mark_done")  .setLabel("✅ Mark Done").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("reopen_task").setLabel("↩️ Reopen")  .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("remove_task").setLabel("🗑️ Remove")  .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("refresh")    .setLabel("🔄 Refresh") .setStyle(ButtonStyle.Secondary),
  );
}

function buildLeadButtons(subId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`lead_add_${subId}`)    .setLabel("➕ Add Task")     .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`lead_done_${subId}`)   .setLabel("✅ Mark Done")    .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`lead_assign_${subId}`) .setLabel("👤 Assign")       .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`lead_remove_${subId}`) .setLabel("🗑️ Remove")      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`lead_remind_${subId}`) .setLabel("📣 Send Reminder").setStyle(ButtonStyle.Secondary),
  );
}

function buildSubSel(customId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("Choose a subsystem...")
      .addOptions(SUBSYSTEMS.map((s) => new StringSelectMenuOptionBuilder().setLabel(s.label).setValue(s.id).setEmoji(s.emoji)))
  );
}

function buildFinanceGroupSel(customId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("Choose a budget group...")
      .addOptions(FINANCE_GROUPS.map((g) => new StringSelectMenuOptionBuilder().setLabel(g.label).setValue(g.id).setEmoji(g.emoji)))
  );
}

function buildTaskSel(customId, tasks, subId, filter) {
  let list = tasks[subId] || [];
  if (filter === "todo") list = list.filter((t) => !t.done);
  if (filter === "done") list = list.filter((t) =>  t.done);
  if (!list.length) return null;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("Choose a task...")
      .addOptions(list.slice(0, 25).map((t) =>
        new StringSelectMenuOptionBuilder().setLabel((t.done ? "✅ " : "⬜ ") + t.name.slice(0, 97)).setValue(t.id)
      ))
  );
}

function addTaskModal(subId) {
  const sub = SUBSYSTEMS.find((s) => s.id === subId);
  return new ModalBuilder().setCustomId(`modal_add_${subId}`).setTitle(`Add task — ${sub.label}`)
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("task_name").setLabel("Task name").setStyle(TextInputStyle.Short).setPlaceholder("e.g. Assemble wheel mounts").setMaxLength(100).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("assignees").setLabel("Assign to — User IDs (optional)").setStyle(TextInputStyle.Short).setPlaceholder("Right-click user → Copy User ID").setRequired(false))
    );
}

function expenseModal(groupId, isRequest = false) {
  const group = FINANCE_GROUPS.find((g) => g.id === groupId);
  return new ModalBuilder()
    .setCustomId(`modal_expense_${groupId}${isRequest ? "_req" : ""}`)
    .setTitle(`${isRequest ? "📝 Request" : "💸 Expense"} — ${group.label}`)
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("item").setLabel("Item description").setStyle(TextInputStyle.Short).setPlaceholder("e.g. 4x Motor Driver Boards").setMaxLength(100).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("qty").setLabel("Quantity").setStyle(TextInputStyle.Short).setPlaceholder("e.g. 4").setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("est_cost").setLabel("Est. unit cost (AUD)").setStyle(TextInputStyle.Short).setPlaceholder("e.g. 25.00").setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("final_cost").setLabel("Final unit cost AUD (blank = estimate)").setStyle(TextInputStyle.Short).setPlaceholder("e.g. 23.50 — leave blank if unknown").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("receipt").setLabel("SharePoint link + reimbursement status").setStyle(TextInputStyle.Paragraph).setPlaceholder("SharePoint link on line 1\nReimbursement status on line 2 (Pending/Paid/N/A)").setRequired(false))
    );
}

function setBudgetModal(groupId) {
  const group = FINANCE_GROUPS.find((g) => g.id === groupId);
  return new ModalBuilder().setCustomId(`modal_budget_${groupId}`).setTitle(`Set Budget — ${group.label}`)
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("amount").setLabel("New budget amount (AUD)").setStyle(TextInputStyle.Short).setPlaceholder("e.g. 1500").setRequired(true)));
}

// ─────────────────────────────────────────
//  UPDATE ALL
// ─────────────────────────────────────────
async function updateOverview(channel) {
  const payload = { embeds: [buildOverviewEmbed(store.tasks)], components: [buildOverviewButtons()] };
  if (store.messageId) {
    try { const m = await channel.messages.fetch(store.messageId); await m.edit(payload); return; } catch {}
  }
  const m = await channel.send(payload);
  store.messageId = m.id;
}

async function updateLeadChannel(channel, sub) {
  const payload = { embeds: [buildLeadEmbed(sub, store.tasks)], components: [buildLeadButtons(sub.id)] };
  const msgId   = store.leadMessageIds[sub.id];
  if (msgId) {
    try { const m = await channel.messages.fetch(msgId); await m.edit(payload); return; } catch {}
  }
  const m = await channel.send(payload);
  store.leadMessageIds[sub.id] = m.id;
}

async function updateAll(client) {
  try { const ch = await client.channels.fetch(STATUS_CHANNEL_ID); await updateOverview(ch); }
  catch (e) { console.error("Overview update failed:", e.message); }
  for (const sub of SUBSYSTEMS) {
    const chId = store.leadChannelIds[sub.id];
    if (!chId) continue;
    try { const ch = await client.channels.fetch(chId); await updateLeadChannel(ch, sub); }
    catch (e) { console.error(`Lead update failed for ${sub.id}:`, e.message); }
  }
  await saveData();
}

// ─────────────────────────────────────────
//  SETUP LEAD CHANNELS
// ─────────────────────────────────────────
async function setupLeadChannels(guild, botUserId) {
  const BOT_PERMS = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: true };
  let category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name.toUpperCase() === "SUBSYSTEM LEADS");
  if (!category) category = await guild.channels.create({ name: "SUBSYSTEM LEADS", type: ChannelType.GuildCategory });

  for (const sub of SUBSYSTEMS) {
    const channelName = sub.id.replace(/_/g, "-") + "-lead";
    if (store.leadChannelIds[sub.id]) {
      try { const ch = await guild.channels.fetch(store.leadChannelIds[sub.id]); await ch.permissionOverwrites.edit(botUserId, BOT_PERMS); console.log(`✅ Fixed: #${ch.name}`); continue; }
      catch { delete store.leadChannelIds[sub.id]; }
    }
    const existing = guild.channels.cache.find((c) => c.name === channelName && c.parentId === category.id);
    if (existing) { await existing.permissionOverwrites.edit(botUserId, BOT_PERMS); store.leadChannelIds[sub.id] = existing.id; console.log(`✅ Found: #${channelName}`); continue; }
    const ch = await guild.channels.create({
      name: channelName, type: ChannelType.GuildText, parent: category.id,
      topic: `${sub.emoji} ${sub.label} team lead channel`,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: botUserId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.EmbedLinks] },
      ],
    });
    store.leadChannelIds[sub.id] = ch.id;
    console.log(`✅ Created: #${channelName}`);
  }
}

// ─────────────────────────────────────────
//  CLIENT
// ─────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers] });
const pending = new Map();

client.once("clientReady", async () => {
  console.log(`✅ URT Bot online as ${client.user.tag}`);
  try {
    const guild = client.guilds.cache.first();
    await loadData();
    await guild.channels.fetch();
    await setupLeadChannels(guild, client.user.id);
    await ensureSheetHeaders();

    // Save channel IDs BEFORE wiping message IDs
    await saveData();

    store.messageId       = null;
    store.leadMessageIds  = {};
    store.budgetMessageId = null;

    const overviewCh = await client.channels.fetch(STATUS_CHANNEL_ID);
    const fetched    = await overviewCh.messages.fetch({ limit: 20 });
    for (const msg of fetched.filter((m) => m.author.id === client.user.id).values()) { try { await msg.delete(); } catch {} }

    await updateAll(client);
    await updateBudgetDashboard(guild);
    await postSnapshot(guild);
    await saveData();
    console.log("✅ All done!");
  } catch (e) { console.error("Startup error:", e); }
});

// ─────────────────────────────────────────
//  INTERACTIONS
// ─────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  try {
    const uid   = interaction.user?.id;
    const guild = interaction.guild;

    // ── BUTTONS ──────────────────────────────────────────────────────────
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id.startsWith("lead_add_")) return interaction.showModal(addTaskModal(id.replace("lead_add_", "")));

      if (id === "refresh") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await updateAll(client);
        return replyAndDelete(interaction, "🔄 Refreshed!");
      }
      if (id === "refresh_budget") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await updateBudgetDashboard(guild);
        await saveData();
        return replyAndDelete(interaction, "🔄 Budget refreshed!");
      }

      if (id === "log_expense")      return interaction.reply({ content: "Which budget group?", components: [buildFinanceGroupSel("group_for_expense")], flags: MessageFlags.Ephemeral });
      if (id === "purchase_request") return interaction.reply({ content: "Which budget group?", components: [buildFinanceGroupSel("group_for_request")], flags: MessageFlags.Ephemeral });
      if (id === "set_budget")       return interaction.reply({ content: "Which budget group?", components: [buildFinanceGroupSel("group_for_budget")],  flags: MessageFlags.Ephemeral });
      if (id === "add_task")         return interaction.reply({ content: "Which subsystem?",    components: [buildSubSel("sub_for_add")],                flags: MessageFlags.Ephemeral });
      if (id === "mark_done")        return interaction.reply({ content: "Which subsystem?",    components: [buildSubSel("sub_for_done")],               flags: MessageFlags.Ephemeral });
      if (id === "reopen_task")      return interaction.reply({ content: "Which subsystem?",    components: [buildSubSel("sub_for_reopen")],             flags: MessageFlags.Ephemeral });
      if (id === "remove_task")      return interaction.reply({ content: "Which subsystem?",    components: [buildSubSel("sub_for_remove")],             flags: MessageFlags.Ephemeral });

      if (id.startsWith("lead_done_")) {
        const subId = id.replace("lead_done_", "");
        const sel   = buildTaskSel("task_for_done", store.tasks, subId, "todo");
        if (!sel) return interaction.reply({ content: "No incomplete tasks!", flags: MessageFlags.Ephemeral });
        pending.set(`${uid}_done`, subId);
        return interaction.reply({ content: "Which task is done?", components: [sel], flags: MessageFlags.Ephemeral });
      }
      if (id.startsWith("lead_assign_")) {
        const subId = id.replace("lead_assign_", "");
        const sel   = buildTaskSel("task_for_assign", store.tasks, subId, "all");
        if (!sel) return interaction.reply({ content: "No tasks to assign!", flags: MessageFlags.Ephemeral });
        pending.set(`${uid}_assign`, subId);
        return interaction.reply({ content: "Which task to assign?", components: [sel], flags: MessageFlags.Ephemeral });
      }
      if (id.startsWith("lead_remove_")) {
        const subId = id.replace("lead_remove_", "");
        const sel   = buildTaskSel("task_for_remove", store.tasks, subId, "all");
        if (!sel) return interaction.reply({ content: "No tasks to remove!", flags: MessageFlags.Ephemeral });
        pending.set(`${uid}_remove`, subId);
        return interaction.reply({ content: "Which task to remove?", components: [sel], flags: MessageFlags.Ephemeral });
      }
      if (id.startsWith("lead_remind_")) {
        const subId      = id.replace("lead_remind_", "");
        const sub        = SUBSYSTEMS.find((s) => s.id === subId);
        const todos      = (store.tasks[subId] || []).filter((t) => !t.done);
        if (!todos.length) return interaction.reply({ content: "✅ No incomplete tasks!", flags: MessageFlags.Ephemeral });
        const assigneeIds = [...new Set(todos.flatMap((t) => t.assignees || []))];
        if (!assigneeIds.length) return interaction.reply({ content: "⚠️ No one assigned. Use 👤 Assign first!", flags: MessageFlags.Ephemeral });
        const taskList = todos.map((t) => `• **${t.name}** — ${t.assignees?.length ? t.assignees.map((id) => `<@${id}>`).join(", ") : "*unassigned*"}`).join("\n");
        let dmCount = 0;
        for (const assigneeId of assigneeIds) {
          try { const member = await guild.members.fetch(assigneeId); await member.send(`📣 **Progress update — ${sub.emoji} ${sub.label}**\n\nHey ${member.displayName}! Your team lead is asking for a progress update:\n\n${taskList}\n\nPlease update the bot when done. Thanks!`); dmCount++; } catch {}
        }
        await postLog(guild, logEmbed(sub.color, `📣 Reminder — ${sub.emoji} ${sub.label}`, [`Sent by <@${uid}>`, `DMed ${dmCount} member(s)`, "", taskList]));
        return interaction.reply({ content: `📣 Reminder sent to **${dmCount}** member(s) via DM!`, flags: MessageFlags.Ephemeral });
      }

      if (id.startsWith("approve_req_") || id.startsWith("reject_req_")) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const approved = id.startsWith("approve_req_");
        const reqId    = id.replace(approved ? "approve_req_" : "reject_req_", "");
        const req      = store.pendingRequests.find((r) => r.id === reqId);
        if (!req) return replyAndDelete(interaction, "Request not found or already processed.");
        store.pendingRequests = store.pendingRequests.filter((r) => r.id !== reqId);
        const group = FINANCE_GROUPS.find((g) => g.id === req.groupId);
        if (approved) {
          const estTotal  = req.qty * req.estCost;
          store.spent[req.groupId] = (store.spent[req.groupId] || 0) + estTotal;
          const receiptId = makeReceiptId();
          await appendExpenseRow([receiptId, new Date().toLocaleDateString("en-AU"), req.userName, group.label, req.item, req.qty, fmtAUD(req.estCost), fmtAUD(estTotal), "", "", "Yes", req.reimbursement || "Pending", req.receipt || "", "Purchase request"]);
          await updateBudgetDashboard(guild);
          await postLog(guild, logEmbed(0x2ecc71, `✅ Request Approved — ${group.emoji} ${group.label}`, [`**${req.item}** x${req.qty}`, `Est. Total: ${fmtAUD(estTotal)}`, `Approved by <@${uid}>`, `Receipt ID: ${receiptId}`]));
          await saveData();
          return replyAndDelete(interaction, `✅ Approved! **${receiptId}** — ${fmtAUD(estTotal)} charged to ${group.label}.`);
        } else {
          await postLog(guild, logEmbed(0xe74c3c, `❌ Request Rejected — ${group.emoji} ${group.label}`, [`**${req.item}** x${req.qty}`, `Rejected by <@${uid}>`]));
          await saveData();
          return replyAndDelete(interaction, "❌ Request rejected.");
        }
      }
    }

    // ── SELECT MENUS ──────────────────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
      const id    = interaction.customId;
      const value = interaction.values[0];

      if (id === "sub_for_add")       return interaction.showModal(addTaskModal(value));
      if (id === "group_for_expense") return interaction.showModal(expenseModal(value, false));
      if (id === "group_for_request") return interaction.showModal(expenseModal(value, true));
      if (id === "group_for_budget")  return interaction.showModal(setBudgetModal(value));
      if (id === "task_for_assign") {
        const subId = pending.get(`${uid}_assign`);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) return interaction.update({ content: "Task not found.", components: [] });
        pending.set(`${uid}_assigntask`, value);
        return interaction.showModal(new ModalBuilder().setCustomId(`modal_assign_${subId}`).setTitle(`Assign — ${task.name.slice(0, 40)}`).addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("assignees").setLabel("Discord User IDs (comma separated)").setStyle(TextInputStyle.Short).setPlaceholder("Right-click user → Copy User ID").setRequired(true))));
      }

      if (id === "sub_for_done") {
        const sel = buildTaskSel("task_for_done", store.tasks, value, "todo");
        if (!sel) return interaction.update({ content: "No incomplete tasks!", components: [] });
        pending.set(`${uid}_done`, value);
        return interaction.update({ content: "Which task is done?", components: [sel] });
      }
      if (id === "sub_for_reopen") {
        const sel = buildTaskSel("task_for_reopen", store.tasks, value, "done");
        if (!sel) return interaction.update({ content: "No completed tasks!", components: [] });
        pending.set(`${uid}_reopen`, value);
        return interaction.update({ content: "Which task to reopen?", components: [sel] });
      }
      if (id === "sub_for_remove") {
        const sel = buildTaskSel("task_for_remove", store.tasks, value, "all");
        if (!sel) return interaction.update({ content: "No tasks.", components: [] });
        pending.set(`${uid}_remove`, value);
        return interaction.update({ content: "Which task to remove?", components: [sel] });
      }

      if (id === "task_for_done") {
        await interaction.deferUpdate();
        const subId = pending.get(`${uid}_done`);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) { await interaction.editReply({ content: "Task not found.", components: [] }); return; }
        task.done = true; task.doneAt = Date.now();
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        await postLog(guild, logEmbed(0x2ecc71, `✅ Task done — ${sub.emoji} ${sub.label}`, [`**${task.name}**`, `By <@${uid}>`]));
        await interaction.editReply({ content: `✅ **${task.name}** marked done!`, components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
        return;
      }
      if (id === "task_for_reopen") {
        await interaction.deferUpdate();
        const subId = pending.get(`${uid}_reopen`);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) { await interaction.editReply({ content: "Task not found.", components: [] }); return; }
        task.done = false; delete task.doneAt;
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        await postLog(guild, logEmbed(0xe67e22, `↩️ Task reopened — ${sub.emoji} ${sub.label}`, [`**${task.name}**`, `By <@${uid}>`]));
        await interaction.editReply({ content: `↩️ **${task.name}** reopened.`, components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
        return;
      }
      if (id === "task_for_remove") {
        await interaction.deferUpdate();
        const subId = pending.get(`${uid}_remove`);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) { await interaction.editReply({ content: "Task not found.", components: [] }); return; }
        store.tasks[subId] = store.tasks[subId].filter((t) => t.id !== value);
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        await postLog(guild, logEmbed(0xe74c3c, `🗑️ Task removed — ${sub.emoji} ${sub.label}`, [`**${task.name}**`, `By <@${uid}>`]));
        await interaction.editReply({ content: `🗑️ **${task.name}** removed.`, components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
        return;
      }
    }

    // ── MODALS ────────────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (interaction.customId.startsWith("modal_add_")) {
        const subId     = interaction.customId.replace("modal_add_", "");
        const name      = interaction.fields.getTextInputValue("task_name").trim();
        const rawIds    = interaction.fields.getTextInputValue("assignees").trim();
        const assignees = rawIds ? rawIds.split(",").map((s) => s.trim()).filter(Boolean) : [];
        if (!store.tasks[subId]) store.tasks[subId] = [];
        store.tasks[subId].push({ id: makeId(), name, done: false, assignees, addedAt: Date.now() });
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        const who = assignees.length ? assignees.map((id) => `<@${id}>`).join(", ") : "*unassigned*";
        await postLog(guild, logEmbed(sub.color, `➕ Task added — ${sub.emoji} ${sub.label}`, [`**${name}**`, `By <@${uid}>`, `Assigned: ${who}`]));
        return replyAndDelete(interaction, `${sub.emoji} **${name}** added to **${sub.label}**!\n👤 ${who}`);
      }

      if (interaction.customId.startsWith("modal_assign_")) {
        const subId     = interaction.customId.replace("modal_assign_", "");
        const taskId    = pending.get(`${uid}_assigntask`);
        const assignees = interaction.fields.getTextInputValue("assignees").trim().split(",").map((s) => s.trim()).filter(Boolean);
        const task      = store.tasks[subId]?.find((t) => t.id === taskId);
        if (!task) return replyAndDelete(interaction, "Task not found.");
        task.assignees = assignees;
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        const who = assignees.map((id) => `<@${id}>`).join(", ");
        await postLog(guild, logEmbed(sub.color, `👤 Task assigned — ${sub.emoji} ${sub.label}`, [`**${task.name}**`, `Assigned to: ${who}`, `By <@${uid}>`]));
        return replyAndDelete(interaction, `👤 **${task.name}** assigned to ${who}!`);
      }

      if (interaction.customId.startsWith("modal_budget_")) {
        const groupId = interaction.customId.replace("modal_budget_", "");
        const amount  = parseFloat(interaction.fields.getTextInputValue("amount").replace(/[^0-9.]/g, ""));
        if (isNaN(amount) || amount < 0) return replyAndDelete(interaction, "❌ Invalid amount.");
        const group = FINANCE_GROUPS.find((g) => g.id === groupId);
        store.budgets[groupId] = amount;
        await updateBudgetDashboard(guild);
        await saveData();
        await postLog(guild, logEmbed(group.color, `⚙️ Budget updated — ${group.emoji} ${group.label}`, [`New budget: ${fmtAUD(amount)}`, `Set by <@${uid}>`]));
        return replyAndDelete(interaction, `⚙️ **${group.label}** budget set to **${fmtAUD(amount)}**!`);
      }

      if (interaction.customId.startsWith("modal_expense_")) {
        const isRequest = interaction.customId.endsWith("_req");
        const groupId   = interaction.customId.replace("modal_expense_", "").replace("_req", "");
        const group     = FINANCE_GROUPS.find((g) => g.id === groupId);
        const item      = interaction.fields.getTextInputValue("item").trim();
        const qty       = parseFloat(interaction.fields.getTextInputValue("qty")) || 1;
        const estCost   = parseFloat(interaction.fields.getTextInputValue("est_cost").replace(/[^0-9.]/g, "")) || 0;
        const finalRaw  = interaction.fields.getTextInputValue("final_cost").trim();
        const finalCost = finalRaw ? parseFloat(finalRaw.replace(/[^0-9.]/g, "")) : null;
        const receiptRaw    = interaction.fields.getTextInputValue("receipt").trim();
        const receiptLines  = receiptRaw.split("\n");
        const receipt       = receiptLines[0]?.trim() || "";
        const reimbursement = receiptLines[1]?.trim() || "Pending";
        const estTotal   = qty * estCost;
        const finalTotal = finalCost !== null ? qty * finalCost : null;
        const member     = await guild.members.fetch(uid);
        const userName   = member.displayName;

        if (isRequest) {
          const reqId = makeId();
          store.pendingRequests.push({ id: reqId, groupId, item, qty, estCost, receipt, reimbursement, userName, userId: uid });
          const logCh = await getLogChannel(guild);
          await logCh.send({
            embeds: [new EmbedBuilder().setTitle(`📝 Purchase Request — ${group.emoji} ${group.label}`).setColor(group.color)
              .setDescription(`**${item}** x${qty}\nEst. Unit: ${fmtAUD(estCost)}  |  Est. Total: ${fmtAUD(estTotal)}\nReceipt: ${receipt || "*none yet*"}\nRequested by: <@${uid}>`)
              .setTimestamp()],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`approve_req_${reqId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`reject_req_${reqId}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger),
            )],
          });
          await saveData();
          return replyAndDelete(interaction, `📝 Purchase request submitted for **${item}** x${qty} (${fmtAUD(estTotal)}) — awaiting approval in #rover-logs!`);
        } else {
          const receiptId  = makeReceiptId();
          const costToLog  = finalTotal !== null ? finalTotal : estTotal;
          store.spent[groupId] = (store.spent[groupId] || 0) + costToLog;
          await appendExpenseRow([receiptId, new Date().toLocaleDateString("en-AU"), userName, group.label, item, qty, fmtAUD(estCost), fmtAUD(estTotal), finalCost !== null ? fmtAUD(finalCost) : "", finalTotal !== null ? fmtAUD(finalTotal) : "", "No", reimbursement, receipt, ""]);
          await updateBudgetDashboard(guild);
          await postLog(guild, logEmbed(group.color, `💸 Expense logged — ${group.emoji} ${group.label}`,
            [`**${item}** x${qty}`, `Est: ${fmtAUD(estTotal)}${finalTotal !== null ? `  |  Final: ${fmtAUD(finalTotal)}` : ""}`, `By <@${uid}>`, `Receipt ID: ${receiptId}`, `Reimbursement: ${reimbursement}`]));
          await saveData();
          return replyAndDelete(interaction, `💸 **${receiptId}** logged!\n${item} x${qty} — ${fmtAUD(costToLog)} charged to **${group.label}**`);
        }
      }
    }

  } catch (err) {
    console.error(err);
    try {
      const msg = { content: "⚠️ Something went wrong — try again!" };
      if (interaction.deferred) await interaction.editReply(msg);
      else if (!interaction.replied) await interaction.reply({ ...msg, flags: MessageFlags.Ephemeral });
    } catch {}
  }
});

client.login(DISCORD_TOKEN);
