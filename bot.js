require('dotenv').config();

const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder, PermissionsBitField, ChannelType, MessageFlags,
} = require("discord.js");
const Bottleneck = require("bottleneck");
const https = require("https");
const { google } = require("googleapis");

const DISCORD_TOKEN          = process.env.DISCORD_TOKEN;
const JSONBIN_BIN_ID         = process.env.JSONBIN_BIN_ID;
const JSONBIN_API_KEY        = process.env.JSONBIN_API_KEY;
const STATUS_CHANNEL_ID      = process.env.STATUS_CHANNEL_ID;
const GOOGLE_SHEET_ID        = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;

const KANBAN_URL = 'https://eddywin3245.github.io/URTBOT/kanban.html';

const SUBSYSTEMS = [
  { id: "manipulator", label: "Manipulator", emoji: "🦾", color: 0xe74c3c },
  { id: "drivetrain",  label: "Drivetrain Chassis",             emoji: "🚗", color: 0xe67e22 },
  { id: "comms",       label: "Teleoperations",                  emoji: "📡", color: 0x3498db },
  { id: "electrical",  label: "Power Systems & Electronics",     emoji: "⚡", color: 0xf1c40f },
  { id: "science",     label: "Science",     emoji: "🔬", color: 0x2ecc71 },
  { id: "automation",  label: "Automation",  emoji: "🤖", color: 0xe91e63 },
  { id: "admin",        label: "Admin",        emoji: "🛠️", color: 0x8e44ad },
  { id: "marketing",    label: "Marketing",    emoji: "📣", color: 0x16a085 },
];

const FINANCE_GROUPS = [
  { id: "manipulator", label: "Manipulator", emoji: "🦾", color: 0xe74c3c },
  { id: "drivetrain",  label: "Drivetrain Chassis",             emoji: "🚗", color: 0xe67e22 },
  { id: "comms",       label: "Teleoperations",                  emoji: "📡", color: 0x3498db },
  { id: "electrical",  label: "Power Systems & Electronics",     emoji: "⚡", color: 0xf1c40f },
  { id: "science",     label: "Science",     emoji: "🔬", color: 0x2ecc71 },
  { id: "automation",  label: "Automation",  emoji: "🤖", color: 0xe91e63 },
  { id: "admin",        label: "Admin",        emoji: "🛠️", color: 0x8e44ad },
  { id: "marketing",    label: "Marketing",    emoji: "📣", color: 0x16a085 },
];

const DEFAULT_BUDGETS = {
  manipulator: 1000, drivetrain: 1000, comms: 1000,
  electrical: 1000, science: 1000, automation: 1000, admin: 500, marketing: 1000,
};

const PRI_EMOJI = { high: "🔴", medium: "🟡", low: "🟢" };

// Role names for permission checks — update these to match your Discord server
// Role names matching your Discord server
const FINANCE_ROLES  = ["Project Lead", "Team Leads", "Treasurer"];  // Can log expenses directly
const BUDGET_ROLES   = ["Project Lead", "Treasurer"];                  // Can change budgets

function hasAnyRole(member, roleNames) {
  return member.roles.cache.some(r => roleNames.includes(r.name));
}
function isLead(member)        { return hasAnyRole(member, FINANCE_ROLES); }
function isProjectLead(member) { return hasAnyRole(member, BUDGET_ROLES); }

// ─────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────
async function replyAndDelete(interaction, content, delay = 4000) {
  await interaction.editReply({ content, components: [] });
  setTimeout(() => interaction.deleteReply().catch(() => {}), delay);
}
function scheduleDelete(interaction, delay = 4000) {
  setTimeout(() => interaction.deleteReply().catch(() => {}), delay);
}
function makeId() { return Math.random().toString(36).slice(2, 10); }
function makeReceiptId() {
  const id = `RCP-${String(store.receiptCounter).padStart(4, "0")}`;
  store.receiptCounter++;
  return id;
}
function fmtAUD(n) { return `$${Number(n).toFixed(2)}`; }
function memberName(id) { return store.members?.[id] ? `${store.members[id]} (<@${id}>)` : `<@${id}>`; }

// ─────────────────────────────────────────
//  DEPENDENCY HELPERS
// ─────────────────────────────────────────
function findTaskById(taskId) {
  for (const sub of SUBSYSTEMS) {
    const task = (store.tasks[sub.id] || []).find(t => t.id === taskId);
    if (task) return { task, sub };
  }
  return null;
}

// When a task is marked done, DM assignees of any task that is now fully unblocked
async function notifyUnblocked(guild, completedTaskId) {
  for (const sub of SUBSYSTEMS) {
    for (const task of (store.tasks[sub.id] || [])) {
      if (task.status === 'done') continue;
      if (!(task.dependsOn || []).includes(completedTaskId)) continue;
      // Check if ALL deps are now done
      const allDone = (task.dependsOn || []).every(depId => {
        const found = findTaskById(depId);
        return !found || found.task.status === 'done';
      });
      if (!allDone) continue;
      // DM all assignees
      if (!task.assignees?.length) continue;
      const completedFound = findTaskById(completedTaskId);
      const completedName  = completedFound?.task.name || 'a dependency';
      for (const assigneeId of task.assignees) {
        try {
          const member = await guild.members.fetch(assigneeId);
          await member.send(
            `🔓 **Task unblocked — ${sub.emoji} ${sub.label}**\n\n` +
            `Hey ${member.displayName}! All dependencies for **${task.name}** are now complete.\n\n` +
            `"${completedName}" was just marked done, which was the last blocker.\n\n` +
            `You can now start working on **${task.name}**! 🚀`
          );
          console.log(`📬 Unblock notification sent to ${member.displayName} for task "${task.name}"`);
        } catch (e) { console.error(`Failed to DM ${assigneeId}:`, e.message); }
      }
    }
  }
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
    "Pre-Approved?","Reimbursement Status","Receipt Link","Justification","Notes"];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: "Sheet1!A1:O1" });
    if (!res.data.values?.length) {
      await sheets.spreadsheets.values.update({ spreadsheetId: GOOGLE_SHEET_ID, range: "Sheet1!A1", valueInputOption: "RAW", requestBody: { values: [headers] } });
      console.log("✅ Sheet headers written");
    }
  } catch (e) { console.error("Sheet header error:", e.message); }
}

async function appendExpenseRow(row) {
  await getSheets().spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID, range: "Sheet1!A1",
    valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

async function deleteSheetRow(receiptId) {
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: "Sheet1!A:A" });
    const rows = res.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === receiptId) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: GOOGLE_SHEET_ID,
          requestBody: { requests: [{ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: i, endIndex: i + 1 } } }] }
        });
        return true;
      }
    }
  } catch (e) { console.error("Delete sheet row error:", e.message); }
  return false;
}

async function syncBudgetSheet() {
  try {
    const sheets = getSheets();
    // Get or create Budget Summary sheet
    const meta = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEET_ID });
    let budgetSheet = meta.data.sheets.find(s => s.properties.title === "Budget Summary");
    if (!budgetSheet) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: GOOGLE_SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: "Budget Summary" } } }] }
      });
    }
    const rows = [
      ["Subsystem", "Budget (AUD)", "Spent (AUD)", "Remaining (AUD)", "Last Updated"],
      ...FINANCE_GROUPS.map(g => [
        g.label,
        store.budgets[g.id] || 0,
        store.spent[g.id] || 0,
        (store.budgets[g.id] || 0) - (store.spent[g.id] || 0),
        new Date().toLocaleDateString("en-AU")
      ]),
      [],
      ["TOTAL",
        Object.values(store.budgets).reduce((a,b) => a+b, 0),
        Object.values(store.spent).reduce((a,b) => a+b, 0),
        Object.values(store.budgets).reduce((a,b) => a+b, 0) - Object.values(store.spent).reduce((a,b) => a+b, 0),
        ""
      ]
    ];
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID, range: "Budget Summary!A1",
      valueInputOption: "RAW", requestBody: { values: rows }
    });
    console.log("✅ Budget summary sheet updated");
  } catch (e) { console.error("Budget sheet sync error:", e.message); }
}

async function updateSheetRow(receiptId, colLetter, value) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: "Sheet1!A:A" });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === receiptId) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID, range: `Sheet1!${colLetter}${i + 1}`,
        valueInputOption: "RAW", requestBody: { values: [[value]] },
      });
      return true;
    }
  }
  return false;
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
    tasks:               r.tasks               || Object.fromEntries(SUBSYSTEMS.map((s) => [s.id, []])),
    members:             r.members             || {},
    messageId:           r.messageId           || null,
    leadMessageIds:      r.leadMessageIds      || {},
    leadChannelIds:      r.leadChannelIds      || {},
    logChannelId:        r.logChannelId        || null,
    financeLogChannelId: r.financeLogChannelId || null,
    approvalChannelId:   r.approvalChannelId   || null,
    adminChannelId:      r.adminChannelId      || null,
    budgetChannelId:     r.budgetChannelId     || null,
    budgetMessageId:     r.budgetMessageId     || null,
    budgets:             r.budgets             || { ...DEFAULT_BUDGETS },
    spent:               r.spent               || Object.fromEntries(FINANCE_GROUPS.map((g) => [g.id, 0])),
    pendingRequests:     r.pendingRequests     || [],
    receiptCounter:      r.receiptCounter      || 1,
    expenses:            r.expenses            || [],
    milestones:          r.milestones          || [],
  };
  for (const sub of SUBSYSTEMS) {
    if (!store.tasks[sub.id]) store.tasks[sub.id] = [];
    store.tasks[sub.id].forEach(t => {
      if (!t.status)   t.status   = t.done ? 'done' : 'todo';
      if (!t.priority) t.priority = '';
      if (!t.dependsOn) t.dependsOn = [];
    });
  }
  for (const g of FINANCE_GROUPS) {
    if (!store.budgets[g.id]) store.budgets[g.id] = DEFAULT_BUDGETS[g.id] || 1000;
    if (store.spent[g.id] === undefined) store.spent[g.id] = 0;
  }
  return store;
}

const saveData = limiter.wrap(async () => { await jsonbinRequest("PUT", store); });

// ─────────────────────────────────────────
//  LOGS
// ─────────────────────────────────────────
async function getLogChannel(guild) {
  if (store.logChannelId) {
    try { return await guild.channels.fetch(store.logChannelId); } catch { store.logChannelId = null; }
  }
  const existing = guild.channels.cache.find((c) => c.name === "rover-logs");
  if (existing) { store.logChannelId = existing.id; return existing; }
  const ch = await guild.channels.create({ name: "rover-logs", type: ChannelType.GuildText, topic: "📋 Warp — task activity log" });
  store.logChannelId = ch.id;
  await saveData();
  return ch;
}

async function getFinanceLogChannel(guild) {
  if (store.financeLogChannelId) {
    try { return await guild.channels.fetch(store.financeLogChannelId); } catch { store.financeLogChannelId = null; }
  }
  const existing = guild.channels.cache.find((c) => c.name === "finance-logs");
  if (existing) { store.financeLogChannelId = existing.id; return existing; }
  const ch = await guild.channels.create({ name: "finance-logs", type: ChannelType.GuildText, topic: "💰 Warp — finance activity log" });
  store.financeLogChannelId = ch.id;
  await saveData();
  return ch;
}

async function getApprovalChannel(guild, botUserId) {
  if (store.approvalChannelId) {
    try { return await guild.channels.fetch(store.approvalChannelId); } catch { store.approvalChannelId = null; }
  }
  const existing = guild.channels.cache.find((c) => c.name === "purchase-approvals");
  if (existing) { store.approvalChannelId = existing.id; return existing; }
  const ch = await guild.channels.create({
    name: "purchase-approvals", type: ChannelType.GuildText,
    topic: "📝 Warp — purchase request approvals",
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: botUserId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.EmbedLinks] },
    ],
  });
  store.approvalChannelId = ch.id;
  await saveData();
  return ch;
}

async function getAdminChannel(guild, botUserId) {
  if (store.adminChannelId) {
    try { return await guild.channels.fetch(store.adminChannelId); } catch { store.adminChannelId = null; }
  }
  const existing = guild.channels.cache.find((c) => c.name === "urt-admin");
  if (existing) { store.adminChannelId = existing.id; return existing; }
  const ch = await guild.channels.create({
    name: "urt-admin",
    type: ChannelType.GuildText,
    topic: "🛠️ Warp — admin channel",
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: botUserId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.EmbedLinks] },
    ],
  });
  store.adminChannelId = ch.id;
  await saveData();
  return ch;
}

async function postAdmin(guild, embed, components) {
  try {
    const ch = await getAdminChannel(guild, client.user.id);
    await ch.send({ embeds: [embed], ...(components ? { components } : {}) });
  } catch (e) { console.error("Admin post failed:", e.message); }
}

async function postLog(guild, embed) {
  try { const ch = await getLogChannel(guild); await ch.send({ embeds: [embed] }); }
  catch (e) { console.error("Log post failed:", e.message); }
}
async function postFinanceLog(guild, embed) {
  try { const ch = await getFinanceLogChannel(guild); await ch.send({ embeds: [embed] }); }
  catch (e) { console.error("Finance log post failed:", e.message); }
}
async function postApprovalRequest(guild, embed, components, botUserId) {
  try { const ch = await getApprovalChannel(guild, botUserId); await ch.send({ embeds: [embed], components }); }
  catch (e) { console.error("Approval post failed:", e.message); }
}

function logEmbed(color, title, lines) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(lines.filter(Boolean).join("\n")).setTimestamp();
}

async function postSnapshot(guild) {
  const ch = await getLogChannel(guild);
  const lines = SUBSYSTEMS.map((sub) => {
    const list = store.tasks[sub.id] || [];
    if (!list.length) return `${sub.emoji} **${sub.label}** — no tasks`;
    return `${sub.emoji} **${sub.label}**\n${list.map((t) => {
      const who = t.assignees?.length ? t.assignees.map(id => `<@${id}>`).join(", ") : "*unassigned*";
      const pri = t.priority ? ` ${PRI_EMOJI[t.priority]}` : "";
      const due = t.dueDate ? `  📅 ${t.dueDate}` : "";
      const dep = (t.dependsOn||[]).length > 0 ? " ⛓" : "";
      return `  ${t.status === 'done' ? "✅" : t.status === 'inprogress' ? "◑" : "⬜"} ${t.name}${pri}${dep} — ${who}${due}`;
    }).join("\n")}`;
  });
  const total = Object.values(store.tasks).flat().length;
  const done  = Object.values(store.tasks).flat().filter((t) => t.done).length;
  await ch.send({ embeds: [new EmbedBuilder().setColor(0x38bdf8).setTitle("📋 Warp — Full Task Snapshot")
    .setDescription(lines.join("\n\n")).setFooter({ text: `${done}/${total} tasks complete` }).setTimestamp()] });
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
    return `${g.emoji} **${g.label}** ${dot}\n\`${bar}\` ${pct}% spent\n${fmtAUD(spent)} / ${fmtAUD(budget)} — **${fmtAUD(left)} remaining**`;
  });
  const tb = Object.values(store.budgets).reduce((a, b) => a + b, 0);
  const ts = Object.values(store.spent).reduce((a, b) => a + b, 0);
  return new EmbedBuilder()
    .setTitle("💰  WARP — BUDGET STATUS").setColor(0x2ecc71)
    .setDescription(`**Total: ${fmtAUD(tb)}  |  Spent: ${fmtAUD(ts)}  |  Remaining: ${fmtAUD(tb - ts)}**\n\n━━━━━━━━━━━━━━━━━━━━━━\n\n` + lines.join("\n\n"))
    .setTimestamp().setFooter({ text: "🟢 Healthy  🟡 Under 20%  🔴 Over budget" });
}

function buildBudgetButtons() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("log_expense")      .setLabel("💸 Log Expense")      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("purchase_request") .setLabel("📝 Purchase Request") .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("update_payment")   .setLabel("💳 Update Payment")   .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("set_budget")       .setLabel("⚙️ Set Budget")       .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("refresh_budget")   .setLabel("🔄 Refresh")          .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("remove_expense")   .setLabel("🗑️ Remove Expense")    .setStyle(ButtonStyle.Danger),
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
      const ch = await guild.channels.create({ name: "budget-status", type: ChannelType.GuildText, topic: "💰 Warp budget tracker" });
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
  return new EmbedBuilder().setTitle("🛸  WARP — BUILD STATUS").setColor(0x38bdf8)
    .setDescription(`**Overall**\n\`${ob}\` ${op}%  (${td}/${ta} tasks)\n\n━━━━━━━━━━━━━━━━━━━━━━\n\n` + sections.join("\n\n"))
    .setTimestamp().setFooter({ text: `Kanban: ${KANBAN_URL}` });
}

function buildLeadEmbed(sub, tasks) {
  const list = tasks[sub.id] || [];
  const todo = list.filter((t) => t.status === 'todo');
  const inp  = list.filter((t) => t.status === 'inprogress');
  const done = list.filter((t) => t.status === 'done');
  const pct  = list.length === 0 ? 0 : Math.round((done.length / list.length) * 100);
  const bar  = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));

  const fmt = (t) => {
    const who  = t.assignees?.length ? t.assignees.map(id => `<@${id}>`).join(", ") : "*Unassigned*";
    const pri  = t.priority ? ` ${PRI_EMOJI[t.priority]}` : "";
    const due  = t.dueDate ? `\n> 📅 Due: ${t.dueDate}` : "";
    const note = t.notes ? `\n> 📝 ${t.notes}` : "";
    // Dependency info
    const blockedBy = (t.dependsOn||[]).filter(id => { const f = findTaskById(id); return f && f.task.status !== 'done'; });
    const depStr = blockedBy.length > 0 ? `\n> ⛔ Blocked by ${blockedBy.length} task(s)` :
                   (t.dependsOn||[]).length > 0 ? `\n> ✅ All deps complete` : "";
    return `> **${t.name}**${pri}\n> 👤 ${who}${due}${note}${depStr}`;
  };

  const fields = [];
  if (inp.length > 0) fields.push({ name: `◑ In Progress (${inp.length})`, value: inp.map(fmt).join("\n\n").slice(0, 1024) });
  fields.push({ name: `📋 To Do (${todo.length})`, value: (todo.length > 0 ? todo.map(fmt).join("\n\n") : "*No tasks*").slice(0, 1024) });
  fields.push({ name: `✅ Done (${done.length})`, value: (done.length > 0 ? done.map(fmt).join("\n\n") : "*None yet*").slice(0, 1024) });

  return new EmbedBuilder().setTitle(`${sub.emoji}  ${sub.label} — Task Board`).setColor(sub.color)
    .setDescription(`\`${bar}\` ${pct}%  (${done.length}/${list.length} tasks complete)`)
    .addFields(...fields)
    .setTimestamp().setFooter({ text: "Use the buttons below to manage tasks" });
}

// ─────────────────────────────────────────
//  BUTTONS & MENUS
// ─────────────────────────────────────────
function buildOverviewButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("add_task")   .setLabel("➕ Add Task") .setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("mark_done")  .setLabel("✅ Mark Done").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("reopen_task").setLabel("↩️ Reopen")  .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("remove_task").setLabel("🗑️ Remove")  .setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("refresh")    .setLabel("🔄 Refresh") .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setURL(KANBAN_URL).setLabel("🗺️ Open Kanban Board").setStyle(ButtonStyle.Link),
    ),
  ];
}

function buildLeadButtons(subId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`lead_add_${subId}`)       .setLabel("➕ Add Task")      .setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`lead_inprogress_${subId}`).setLabel("◑ In Progress")    .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`lead_done_${subId}`)      .setLabel("✅ Mark Done")      .setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`lead_reopen_${subId}`)    .setLabel("↩️ Reopen")        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`lead_remove_${subId}`)    .setLabel("🗑️ Remove")        .setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`lead_assign_${subId}`)    .setLabel("👤 Assign")         .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`lead_remind_${subId}`)    .setLabel("📣 Send Reminder")  .setStyle(ButtonStyle.Secondary),
    ),
  ];
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
  if (filter === "todo") list = list.filter((t) => t.status !== 'done');
  if (filter === "done") list = list.filter((t) => t.done);
  if (!list.length) return null;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("Choose a task...")
      .addOptions(list.slice(0, 25).map((t) => {
        const pri  = t.priority ? ` ${PRI_EMOJI[t.priority]}` : "";
        const dep  = (t.dependsOn||[]).length > 0 ? " ⛓" : "";
        const icon = t.status === 'done' ? "✅ " : t.status === 'inprogress' ? "◑ " : "⬜ ";
        return new StringSelectMenuOptionBuilder().setLabel((icon + t.name + pri + dep).slice(0, 100)).setValue(t.id);
      }))
  );
}

function buildOpenFormButton(subId) {
  const sub = SUBSYSTEMS.find((s) => s.id === subId);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`open_form_add_${subId}`).setLabel(`➕ Open form for ${sub.label}`).setStyle(ButtonStyle.Primary)
  );
}

function addTaskModal(subId) {
  const sub = SUBSYSTEMS.find((s) => s.id === subId);
  return new ModalBuilder().setCustomId(`modal_add_${subId}`).setTitle(`Add task — ${sub.label}`)
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("task_name").setLabel("Task name").setStyle(TextInputStyle.Short).setPlaceholder("e.g. Assemble wheel mounts").setMaxLength(100).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("priority").setLabel("Priority (high / medium / low)").setStyle(TextInputStyle.Short).setPlaceholder("high / medium / low — leave blank for none").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("start_date").setLabel("Start date (optional)").setStyle(TextInputStyle.Short).setPlaceholder("DD/MM/YYYY").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("due_date").setLabel("Due date (optional)").setStyle(TextInputStyle.Short).setPlaceholder("DD/MM/YYYY").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("notes").setLabel("Notes (optional)").setStyle(TextInputStyle.Paragraph).setPlaceholder("Any extra context. Add dependencies via the Kanban board.").setRequired(false))
    );
}

function expenseModalBasic(groupId, isRequest = false) {
  const group = FINANCE_GROUPS.find((g) => g.id === groupId);
  return new ModalBuilder()
    .setCustomId(`modal_expense1_${groupId}${isRequest ? "_req" : ""}`)
    .setTitle(`${isRequest ? "📝 Request" : "💸 Expense"} — ${group.label}`)
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("item").setLabel("Item description").setStyle(TextInputStyle.Short).setPlaceholder("e.g. 4x Motor Driver Boards").setMaxLength(100).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("qty").setLabel("Quantity").setStyle(TextInputStyle.Short).setPlaceholder("e.g. 4").setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("est_cost").setLabel("Est. unit cost (AUD)").setStyle(TextInputStyle.Short).setPlaceholder("e.g. 25.00").setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("final_cost").setLabel("Final unit cost AUD (blank = estimate)").setStyle(TextInputStyle.Short).setPlaceholder("e.g. 23.50 — leave blank if unknown").setRequired(false))
    );
}

function expenseModalDetails(groupId, isRequest, tempId) {
  return new ModalBuilder()
    .setCustomId(`modal_expense2_${groupId}_${isRequest ? "req" : "log"}_${tempId}`)
    .setTitle("Receipt & Details")
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("receipt").setLabel("Receipt link (SharePoint)").setStyle(TextInputStyle.Short).setPlaceholder("Paste your SharePoint link here").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reimbursement").setLabel("Reimbursement status").setStyle(TextInputStyle.Short).setPlaceholder("Pending / Paid / N/A").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("justification").setLabel("Justification for purchase").setStyle(TextInputStyle.Paragraph).setPlaceholder("Why is this purchase needed?").setRequired(false))
    );
}

function setBudgetModal(groupId) {
  const group = FINANCE_GROUPS.find((g) => g.id === groupId);
  return new ModalBuilder().setCustomId(`modal_budget_${groupId}`).setTitle(`Set Budget — ${group.label}`)
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("amount").setLabel("New budget amount (AUD)").setStyle(TextInputStyle.Short).setPlaceholder("e.g. 1500").setRequired(true)));
}

function updatePaymentModal(receiptId) {
  return new ModalBuilder().setCustomId(`modal_payment_${receiptId}`).setTitle(`Update Payment — ${receiptId}`)
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("status").setLabel("New reimbursement status").setStyle(TextInputStyle.Short).setPlaceholder("Paid / Pending / N/A / Partial").setRequired(true)));
}

function addMemberModal() {
  return new ModalBuilder().setCustomId("modal_add_member").setTitle("Add Member Name Mapping")
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("member_name").setLabel("Display name").setStyle(TextInputStyle.Short).setPlaceholder("e.g. Eddywin").setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("member_id").setLabel("Discord User ID").setStyle(TextInputStyle.Short).setPlaceholder("Right-click user → Copy User ID").setRequired(true))
    );
}

// ─────────────────────────────────────────
//  UPDATE ALL
// ─────────────────────────────────────────
async function updateOverview(channel) {
  const payload = { embeds: [buildOverviewEmbed(store.tasks)], components: buildOverviewButtons() };
  if (store.messageId) {
    try { const m = await channel.messages.fetch(store.messageId); await m.edit(payload); return; } catch {}
  }
  const m = await channel.send(payload);
  store.messageId = m.id;
}

async function updateLeadChannel(channel, sub) {
  const payload = { embeds: [buildLeadEmbed(sub, store.tasks)], components: buildLeadButtons(sub.id) };
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

  // Ensure Bot-channels category exists
  let botCat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name.toUpperCase() === "BOT-CHANNELS");
  if (!botCat) botCat = await guild.channels.create({ name: "Bot-channels", type: ChannelType.GuildCategory });

  // Move bot utility channels into Bot-channels category
  const botChannelNames = ["rover-status","budget-status","purchase-approvals","urt-admin","task-logs","finance-logs","rover-logs"];
  for (const name of botChannelNames) {
    const ch = guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildText);
    if (ch && ch.parentId !== botCat.id) { try { await ch.setParent(botCat.id, { lockPermissions: false }); } catch {} }
  }

  let category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name.toUpperCase() === "TASK SELECTOR");
  if (!category) category = await guild.channels.create({ name: "TASK SELECTOR", type: ChannelType.GuildCategory });
  for (const sub of SUBSYSTEMS) {
    const channelName = sub.id.replace(/_/g, "-") + "-lead";
    if (store.leadChannelIds[sub.id]) {
      try {
        const ch = await guild.channels.fetch(store.leadChannelIds[sub.id]);
        await ch.permissionOverwrites.edit(botUserId, BOT_PERMS);
        // Move to correct category if not already there
        if (ch.parentId !== category.id) { try { await ch.setParent(category.id, { lockPermissions: false }); } catch {} }
        console.log(`✅ Fixed: #${ch.name}`);
        continue;
      } catch { delete store.leadChannelIds[sub.id]; }
    }
    // Search anywhere in the guild (not just the category) so we pick up orphaned channels
    const existing = guild.channels.cache.find((c) => c.name === channelName && c.type === ChannelType.GuildText);
    if (existing) {
      await existing.permissionOverwrites.edit(botUserId, BOT_PERMS);
      if (existing.parentId !== category.id) { try { await existing.setParent(category.id, { lockPermissions: false }); } catch {} }
      store.leadChannelIds[sub.id] = existing.id;
      console.log(`✅ Found & moved: #${channelName}`);
      continue;
    }
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
    await getLogChannel(guild);
    await getFinanceLogChannel(guild);
    await getApprovalChannel(guild, client.user.id);
    await getAdminChannel(guild, client.user.id);
    await saveData();

    store.messageId = null;
    store.budgetMessageId = null;

    const overviewCh = await client.channels.fetch(STATUS_CHANNEL_ID);
    const fetched    = await overviewCh.messages.fetch({ limit: 20 });
    for (const msg of fetched.filter((m) => m.author.id === client.user.id).values()) { try { await msg.delete(); } catch {} }

    await updateAll(client);
    await updateBudgetDashboard(guild);
    await postSnapshot(guild);
    await saveData();
    console.log("✅ All done!");

    // Register slash commands
    await client.application.commands.set([
      {
        name: 'task',
        description: 'Add a task to a subsystem',
        options: [
          { name: 'subsystem', description: 'Which subsystem', type: 3, required: true, choices: SUBSYSTEMS.map(s => ({ name: s.label, value: s.id })) },
          { name: 'name', description: 'Task name', type: 3, required: true },
          { name: 'priority', description: 'Priority level', type: 3, required: false, choices: [{ name: 'High', value: 'high' }, { name: 'Medium', value: 'medium' }, { name: 'Low', value: 'low' }] },
          { name: 'due', description: 'Due date (DD/MM/YYYY)', type: 3, required: false },
          { name: 'start', description: 'Start date (DD/MM/YYYY)', type: 3, required: false },
          { name: 'notes', description: 'Task notes', type: 3, required: false },
        ],
      },
      {
        name: 'milestone',
        description: 'Add a project milestone or deadline',
        options: [
          { name: 'name', description: 'Milestone name', type: 3, required: true },
          { name: 'date', description: 'Date (DD/MM/YYYY)', type: 3, required: true },
          { name: 'description', description: 'Optional description', type: 3, required: false },
        ],
      },
      {
        name: 'milestones',
        description: 'List all upcoming milestones',
      },
      {
        name: 'checkin',
        description: 'Schedule a check-in for a task',
        options: [
          { name: 'subsystem', description: 'Which subsystem', type: 3, required: true, choices: SUBSYSTEMS.map(s => ({ name: s.label, value: s.id })) },
          { name: 'task', description: 'Task name (partial match)', type: 3, required: true },
          { name: 'date', description: 'Check-in date (DD/MM/YYYY)', type: 3, required: true },
          { name: 'note', description: 'Optional note for the check-in', type: 3, required: false },
        ],
      },
    ]);
    console.log("✅ Slash commands registered");

    // Poll for check-ins every hour and DM assigned members
    setInterval(async () => {
      try {
        await loadData();
        const todayDmy = new Date().toLocaleDateString('en-AU').replace(/\//g, '/').split('/').map((p,i) => i<2?p.padStart(2,'0'):p).join('/');
        let changed = false;
        for (const sub of SUBSYSTEMS) {
          for (const task of store.tasks[sub.id] || []) {
            for (const ci of task.checkIns || []) {
              if (ci.sent || ci.date !== todayDmy) continue;
              const assignees = task.assignees || [];
              for (const assigneeId of assignees) {
                try {
                  const member = await guild.members.fetch(assigneeId);
                  await member.send(
                    `🕐 **Check-in reminder — ${sub.emoji} ${sub.label}**

` +
                    `Hey ${member.displayName}! You have a scheduled check-in for:

` +
                    `• **${task.name}**${ci.note ? `
📝 ${ci.note}` : ''}

` +
                    `Please update your team lead on progress. Thanks!`
                  );
                } catch {}
              }
              ci.sent = true;
              changed = true;
              console.log(`✅ Check-in sent for task: ${task.name}`);
            }
          }
        }
        if (changed) await saveData();
      } catch (e) { console.error("Check-in poll error:", e.message); }
    }, 60 * 60 * 1000);

    // Poll JSONBin every 30s — refresh embeds only, never write back
    setInterval(async () => {
      try {
        const prev = JSON.stringify(store.tasks);
        await loadData();
        if (JSON.stringify(store.tasks) !== prev) {
          console.log("🔄 External change detected — refreshing embeds");
          try { const ch = await client.channels.fetch(STATUS_CHANNEL_ID); await updateOverview(ch); } catch {}
          for (const sub of SUBSYSTEMS) {
            const chId = store.leadChannelIds[sub.id];
            if (!chId) continue;
            try { const ch = await client.channels.fetch(chId); await updateLeadChannel(ch, sub); } catch {}
          }
        }
      } catch (e) { console.error("Poll error:", e.message); }
    }, 30000);

  } catch (e) { console.error("Startup error:", e); }
});

// ─────────────────────────────────────────
//  INTERACTIONS
// ─────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  try {
    const uid   = interaction.user?.id;
    const guild = interaction.guild;

    // ── SLASH COMMANDS ──────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const cmd = interaction.commandName;

      if (cmd === 'task') {
        const subId    = interaction.options.getString('subsystem');
        const name     = interaction.options.getString('name');
        const priority = interaction.options.getString('priority') || '';
        const dueDate  = interaction.options.getString('due') || null;
        const startDate = interaction.options.getString('start') || null;
        const notes    = interaction.options.getString('notes') || null;
        if (!store.tasks[subId]) store.tasks[subId] = [];
        store.tasks[subId].push({ id: makeId(), name, status: 'todo', done: false, priority, assignees: [], startDate, dueDate, notes, checkIns: [], addedAt: Date.now() });
        await updateAll(client);
        const sub    = SUBSYSTEMS.find(s => s.id === subId);
        const priStr = priority ? ` ${PRI_EMOJI[priority]} ${priority}` : '';
        await postLog(guild, logEmbed(sub.color, `➕ Task added — ${sub.emoji} ${sub.label}`, [`**${name}**${priStr}`, `By <@${uid}>`, dueDate ? `Due: ${dueDate}` : null, notes ? `Notes: ${notes}` : null].filter(Boolean)));
        return replyAndDelete(interaction, `${sub.emoji} **${name}** added to **${sub.label}**!${priority ? ` ${PRI_EMOJI[priority]} ${priority} priority` : ''}${dueDate ? `
📅 Due: ${dueDate}` : ''}`);
      }

      if (cmd === 'milestone') {
        const name = interaction.options.getString('name');
        const date = interaction.options.getString('date');
        const desc = interaction.options.getString('description') || null;
        // Validate date format
        const parts = date.split('/');
        if (parts.length !== 3) return replyAndDelete(interaction, '❌ Date must be DD/MM/YYYY');
        if (!store.milestones) store.milestones = [];
        const ms = { id: makeId(), name, date, description: desc };
        store.milestones.push(ms);
        store.milestones.sort((a, b) => {
          const pa = a.date.split('/'), pb = b.date.split('/');
          return new Date(pa[2],pa[1]-1,pa[0]) - new Date(pb[2],pb[1]-1,pb[0]);
        });
        await saveData();
        // Post to admin channel
        const daysLeft = Math.round((new Date(parts[2],parts[1]-1,parts[0]) - new Date().setHours(0,0,0,0)) / 86400000);
        const urgency = daysLeft < 0 ? '🔴 PAST' : daysLeft <= 7 ? '🔴 URGENT' : daysLeft <= 30 ? '🟡 SOON' : '🟢';
        await postAdmin(guild, new EmbedBuilder()
          .setTitle(`🏁 New Milestone — ${name}`)
          .setColor(0x9b59b6)
          .setDescription(`**Date:** ${date}
**Days away:** ${daysLeft < 0 ? `${Math.abs(daysLeft)} days ago` : `${daysLeft} days`} ${urgency}
${desc ? `**Description:** ${desc}` : ''}`)
          .setFooter({ text: `Added by ${(await guild.members.fetch(uid)).displayName}` })
          .setTimestamp()
        );
        return replyAndDelete(interaction, `🏁 Milestone **${name}** set for **${date}**! Posted to #urt-admin.`);
      }

      if (cmd === 'milestones') {
        if (!store.milestones?.length) return replyAndDelete(interaction, '📭 No milestones set yet. Use /milestone to add one!');
        const now = new Date(); now.setHours(0,0,0,0);
        const lines = store.milestones.map(ms => {
          const p = ms.date.split('/');
          const daysLeft = Math.round((new Date(p[2],p[1]-1,p[0]) - now) / 86400000);
          const icon = daysLeft < 0 ? '✅' : daysLeft <= 7 ? '🔴' : daysLeft <= 30 ? '🟡' : '🟢';
          const when = daysLeft < 0 ? Math.abs(daysLeft) + 'd ago' : daysLeft === 0 ? 'TODAY' : 'in ' + daysLeft + 'd';
          const desc = ms.description ? '\n  *' + ms.description + '*' : '';
          return icon + ' **' + ms.name + '** \u2014 ' + ms.date + ' (' + when + ')' + desc;
        }).join('\n\n');
        await interaction.editReply({ content: '\ud83c\udfc1 **Upcoming Milestones**\n\n' + lines });
        return;
      }

      if (cmd === 'checkin') {
        const subId  = interaction.options.getString('subsystem');
        const search = interaction.options.getString('task').toLowerCase();
        const date   = interaction.options.getString('date');
        const note   = interaction.options.getString('note') || null;
        const task   = (store.tasks[subId] || []).find(t => t.name.toLowerCase().includes(search));
        if (!task) return replyAndDelete(interaction, `❌ No task found matching "${search}" in ${SUBSYSTEMS.find(s=>s.id===subId)?.label}`);
        if (!task.checkIns) task.checkIns = [];
        task.checkIns.push({ id: makeId(), date, note, sent: false });
        task.checkIns.sort((a, b) => {
          const pa = a.date.split('/'), pb = b.date.split('/');
          return new Date(pa[2],pa[1]-1,pa[0]) - new Date(pb[2],pb[1]-1,pb[0]);
        });
        await saveData();
        const sub = SUBSYSTEMS.find(s => s.id === subId);
        return replyAndDelete(interaction, `🕐 Check-in scheduled for **${task.name}** on **${date}**${note ? `
📝 ${note}` : ''}`);
      }
    }

    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id.startsWith("lead_add_"))      return interaction.showModal(addTaskModal(id.replace("lead_add_", "")));
      if (id.startsWith("open_form_add_")) return interaction.showModal(addTaskModal(id.replace("open_form_add_", "")));
      if (id === "add_member")             return interaction.showModal(addMemberModal());

      if (id.startsWith("open_expense2_")) {
        const tempId  = id.replace("open_expense2_", "");
        const expData = pending.get(`${uid}_expense_${tempId}`);
        if (!expData) return interaction.reply({ content: "Session expired — please start again.", flags: MessageFlags.Ephemeral });
        await interaction.showModal(expenseModalDetails(expData.groupId, expData.isRequest, tempId));
        setTimeout(() => interaction.deleteReply().catch(() => {}), 500);
        return;
      }

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

      const replyMenu = async (content, components) => {
        await interaction.reply({ content, components, flags: MessageFlags.Ephemeral });
        scheduleDelete(interaction, 30000);
      };
      const replyDenied = async (msg) => {
        await interaction.reply({ content: `🚫 ${msg}`, flags: MessageFlags.Ephemeral });
        scheduleDelete(interaction, 5000);
      };

      // Fetch member for role checks
      const member = await guild.members.fetch(uid);

      if (id === "log_expense") {
        if (!isLead(member)) return replyDenied("Only team leads can log expenses directly. Use 📝 Purchase Request instead!");
        return replyMenu("Which budget group?", [buildFinanceGroupSel("group_for_expense")]);
      }
      if (id === "purchase_request") return replyMenu("Which budget group?", [buildFinanceGroupSel("group_for_request")]);
      if (id === "set_budget") {
        if (!isProjectLead(member)) return replyDenied("Only project leads can change budgets.");
        return replyMenu("Which budget group?", [buildFinanceGroupSel("group_for_budget")]);
      }
      if (id === "add_task")         return replyMenu("Which subsystem?",    [buildSubSel("sub_for_add")]);
      if (id === "mark_done")        return replyMenu("Which subsystem?",    [buildSubSel("sub_for_done")]);
      if (id === "reopen_task")      return replyMenu("Which subsystem?",    [buildSubSel("sub_for_reopen")]);
      if (id === "remove_task")      return replyMenu("Which subsystem?",    [buildSubSel("sub_for_remove")]);

      if (id === "update_payment") {
        if (!store.expenses.length) { await interaction.reply({ content: "No logged expenses to update.", flags: MessageFlags.Ephemeral }); scheduleDelete(interaction, 4000); return; }
        const options = store.expenses.slice(-25).reverse().map((e) =>
          new StringSelectMenuOptionBuilder().setLabel(`${e.receiptId} — ${e.item} (${e.status})`).setValue(e.receiptId)
        );
        await interaction.reply({ content: "Which receipt to update?", components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId("expense_for_payment").setPlaceholder("Choose a receipt...").addOptions(options))], flags: MessageFlags.Ephemeral });
        scheduleDelete(interaction, 30000);
        return;
      }

      if (id === "remove_expense") {
        if (!store.expenses.length) { await interaction.reply({ content: "No logged expenses to remove.", flags: MessageFlags.Ephemeral }); scheduleDelete(interaction, 4000); return; }
        const options = store.expenses.slice(-25).reverse().map((e) =>
          new StringSelectMenuOptionBuilder().setLabel(`${e.receiptId} — ${e.item} (${e.status})`).setValue(e.receiptId)
        );
        await interaction.reply({ content: "Which expense to remove?", components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId("expense_for_remove").setPlaceholder("Choose an expense...").addOptions(options))], flags: MessageFlags.Ephemeral });
        scheduleDelete(interaction, 30000);
        return;
      }

      if (id.startsWith("lead_inprogress_")) {
        const subId = id.replace("lead_inprogress_", "");
        const sel   = buildTaskSel("task_for_inprogress", store.tasks, subId, "todo");
        if (!sel) { await interaction.reply({ content: "No To Do tasks to move!", flags: MessageFlags.Ephemeral }); scheduleDelete(interaction, 4000); return; }
        pending.set(`${uid}_inprogress`, subId);
        await interaction.reply({ content: "Which task to mark In Progress?", components: [sel], flags: MessageFlags.Ephemeral });
        scheduleDelete(interaction, 60000);
        return;
      }
      if (id.startsWith("lead_reopen_")) {
        const subId = id.replace("lead_reopen_", "");
        const sel   = buildTaskSel("task_for_reopen_lead", store.tasks, subId, "done");
        if (!sel) { await interaction.reply({ content: "No completed tasks to reopen!", flags: MessageFlags.Ephemeral }); scheduleDelete(interaction, 4000); return; }
        pending.set(`${uid}_reopen`, subId);
        await interaction.reply({ content: "Which task to reopen?", components: [sel], flags: MessageFlags.Ephemeral });
        scheduleDelete(interaction, 60000);
        return;
      }
      if (id.startsWith("lead_done_")) {
        const subId = id.replace("lead_done_", "");
        const sel   = buildTaskSel("task_for_done", store.tasks, subId, "todo");
        if (!sel) { await interaction.reply({ content: "No incomplete tasks!", flags: MessageFlags.Ephemeral }); scheduleDelete(interaction, 4000); return; }
        pending.set(`${uid}_done`, subId);
        await interaction.reply({ content: "Which task is done?", components: [sel], flags: MessageFlags.Ephemeral });
        scheduleDelete(interaction, 60000);
        return;
      }
      if (id.startsWith("lead_assign_")) {
        const subId = id.replace("lead_assign_", "");
        const sel   = buildTaskSel("task_for_assign", store.tasks, subId, "all");
        if (!sel) { await interaction.reply({ content: "No tasks to assign!", flags: MessageFlags.Ephemeral }); scheduleDelete(interaction, 4000); return; }
        pending.set(`${uid}_assign`, subId);
        await interaction.reply({ content: "Which task to assign?", components: [sel], flags: MessageFlags.Ephemeral });
        scheduleDelete(interaction, 60000);
        return;
      }
      if (id.startsWith("lead_remove_")) {
        const subId = id.replace("lead_remove_", "");
        const sel   = buildTaskSel("task_for_remove", store.tasks, subId, "all");
        if (!sel) { await interaction.reply({ content: "No tasks to remove!", flags: MessageFlags.Ephemeral }); scheduleDelete(interaction, 4000); return; }
        pending.set(`${uid}_remove`, subId);
        await interaction.reply({ content: "Which task to remove?", components: [sel], flags: MessageFlags.Ephemeral });
        scheduleDelete(interaction, 60000);
        return;
      }
      if (id.startsWith("lead_remind_")) {
        const subId = id.replace("lead_remind_", "");
        const todos = (store.tasks[subId] || []).filter((t) => t.status !== 'done');
        if (!todos.length) { await interaction.reply({ content: "✅ No incomplete tasks!", flags: MessageFlags.Ephemeral }); scheduleDelete(interaction, 4000); return; }
        const options = todos.slice(0, 25).map((t) => {
          const pri   = t.priority ? ` ${PRI_EMOJI[t.priority]}` : "";
          const dep   = (t.dependsOn||[]).length > 0 ? " ⛓" : "";
          const label = (t.name + pri + dep).slice(0, 80) + (t.assignees?.length ? "" : " ⚠️");
          const desc  = t.assignees?.length ? `${t.assignees.length} member(s) assigned` : "No one assigned";
          return new StringSelectMenuOptionBuilder().setLabel(label).setDescription(desc).setValue(t.id);
        });
        pending.set(`${uid}_remind_sub`, subId);
        await interaction.reply({ content: "📣 Which task to send a reminder for?", components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId("task_for_remind").setPlaceholder("Choose a task...").addOptions(options))], flags: MessageFlags.Ephemeral });
        scheduleDelete(interaction, 60000);
        return;
      }

      if (id.startsWith("approve_req_") || id.startsWith("reject_req_")) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const approved = id.startsWith("approve_req_");
        const reqId    = id.replace(approved ? "approve_req_" : "reject_req_", "");
        const req      = store.pendingRequests.find((r) => r.id === reqId);
        if (!req) return replyAndDelete(interaction, "Request not found or already processed.");
        store.pendingRequests = store.pendingRequests.filter((r) => r.id !== reqId);
        const group = FINANCE_GROUPS.find((g) => g.id === req.groupId);
        try { await interaction.message.delete(); } catch {}
        if (approved) {
          const estTotal  = req.qty * req.estCost;
          store.spent[req.groupId] = (store.spent[req.groupId] || 0) + estTotal;
          const receiptId = makeReceiptId();
          store.expenses.push({ receiptId, item: req.item, groupId: req.groupId, status: req.reimbursement || "Pending", date: new Date().toLocaleDateString("en-AU") });
          await appendExpenseRow([receiptId, new Date().toLocaleDateString("en-AU"), req.userName, group.label, req.item, req.qty, fmtAUD(req.estCost), fmtAUD(estTotal), "", "", "Yes", req.reimbursement || "Pending", req.receipt || "", req.justification || "", ""]);
          await updateBudgetDashboard(guild);
          await postFinanceLog(guild, logEmbed(0x2ecc71, `✅ Request Approved — ${group.emoji} ${group.label}`,
            [`**${req.item}** x${req.qty}`, `Est. Total: ${fmtAUD(estTotal)}`, `Approved by <@${uid}>`, `Receipt ID: ${receiptId}`, req.justification ? `Justification: ${req.justification}` : null]));
          await saveData();
          return replyAndDelete(interaction, `✅ Approved! **${receiptId}** — ${fmtAUD(estTotal)} charged to ${group.label}.`);
        } else {
          await postFinanceLog(guild, logEmbed(0xe74c3c, `❌ Request Rejected — ${group.emoji} ${group.label}`, [`**${req.item}** x${req.qty}`, `Rejected by <@${uid}>`]));
          await saveData();
          return replyAndDelete(interaction, "❌ Request rejected.");
        }
      }
    }

    if (interaction.isUserSelectMenu()) {
      const id = interaction.customId;
      if (id.startsWith("users_for_assign_")) {
        await interaction.deferUpdate();
        const subId     = id.replace("users_for_assign_", "");
        const taskId    = pending.get(`${uid}_assigntask`);
        const assignees = interaction.values;
        const task      = store.tasks[subId]?.find((t) => t.id === taskId);
        if (!task) { await interaction.editReply({ content: "Task not found.", components: [] }); setTimeout(() => interaction.deleteReply().catch(() => {}), 3000); return; }
        task.assignees = assignees;
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        const who = assignees.map((id) => `<@${id}>`).join(", ");
        await postLog(guild, logEmbed(sub.color, `👤 Task assigned — ${sub.emoji} ${sub.label}`, [`**${task.name}**`, `Assigned to: ${who}`, `By <@${uid}>`]));
        await interaction.editReply({ content: `👤 **${task.name}** assigned to ${who}!`, components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 4000);
        return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      const id    = interaction.customId;
      const value = interaction.values[0];

      if (id === "group_for_expense") { await interaction.showModal(expenseModalBasic(value, false)); setTimeout(() => interaction.deleteReply().catch(() => {}), 500); return; }
      if (id === "group_for_request") { await interaction.showModal(expenseModalBasic(value, true));  setTimeout(() => interaction.deleteReply().catch(() => {}), 500); return; }
      if (id === "group_for_budget")  { await interaction.showModal(setBudgetModal(value));            setTimeout(() => interaction.deleteReply().catch(() => {}), 500); return; }
      if (id === "expense_for_remove") {
        await interaction.deferUpdate();
        const receiptId = value;
        const expense = store.expenses.find(e => e.receiptId === receiptId);
        if (!expense) { await interaction.editReply({ content: "Expense not found.", components: [] }); setTimeout(() => interaction.deleteReply().catch(() => {}), 3000); return; }
        // Subtract from spent
        const group = FINANCE_GROUPS.find(g => g.id === expense.groupId);
        store.spent[expense.groupId] = Math.max(0, (store.spent[expense.groupId] || 0) - (expense.amount || 0));
        store.expenses = store.expenses.filter(e => e.receiptId !== receiptId);
        await updateBudgetDashboard(guild);
        await deleteSheetRow(receiptId);
        await syncBudgetSheet();
        await saveData();
        await postFinanceLog(guild, logEmbed(0xe74c3c, `🗑️ Expense removed — ${group ? group.emoji + ' ' + group.label : receiptId}`, [`Receipt: **${receiptId}**`, `Item: ${expense.item}`, `Removed by <@${uid}>`]));
        await interaction.editReply({ content: `🗑️ **${receiptId}** removed!`, components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 4000);
        return;
      }

      if (id === "expense_for_payment") { pending.set(`${uid}_payment_receipt`, value); await interaction.showModal(updatePaymentModal(value)); setTimeout(() => interaction.deleteReply().catch(() => {}), 500); return; }

      if (id === "sub_for_add") {
        const sub = SUBSYSTEMS.find((s) => s.id === value);
        await interaction.update({ content: `${sub.emoji} **${sub.label}** selected — click below to open the task form:`, components: [buildOpenFormButton(value)] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 30000);
        return;
      }
      if (id === "task_for_assign") {
        const subId = pending.get(`${uid}_assign`);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) { await interaction.update({ content: "Task not found.", components: [] }); setTimeout(() => interaction.deleteReply().catch(() => {}), 3000); return; }
        pending.set(`${uid}_assigntask`, value);
        await interaction.update({ content: `👤 Who to assign **${task.name}** to?`, components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`users_for_assign_${subId}`).setPlaceholder("Search for a member...").setMinValues(1).setMaxValues(5))] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
      }
      if (id === "task_for_remind") {
        const subId = pending.get(`${uid}_remind_sub`);
        const sub   = SUBSYSTEMS.find((s) => s.id === subId);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) { await interaction.update({ content: "Task not found.", components: [] }); setTimeout(() => interaction.deleteReply().catch(() => {}), 3000); return; }
        if (!task.assignees?.length) { await interaction.update({ content: `⚠️ **${task.name}** has no one assigned!`, components: [] }); setTimeout(() => interaction.deleteReply().catch(() => {}), 5000); return; }
        const due = task.dueDate ? ` (due ${task.dueDate})` : "";
        let dmCount = 0;
        for (const assigneeId of task.assignees) {
          try { const member = await guild.members.fetch(assigneeId); await member.send(`📣 **Progress update — ${sub.emoji} ${sub.label}**\n\nHey ${member.displayName}! Your team lead is asking for an update on:\n\n• **${task.name}**${due}\n\nPlease update the bot when done. Thanks!`); dmCount++; } catch {}
        }
        await postLog(guild, logEmbed(sub.color, `📣 Reminder sent — ${sub.emoji} ${sub.label}`, [`Task: **${task.name}**`, `Sent by <@${uid}>`, `DMed ${dmCount} member(s)`]));
        await interaction.update({ content: `📣 Reminder sent to **${dmCount}** member(s) for **${task.name}**!`, components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 4000);
        return;
      }

      const deferredSelects = {
        "sub_for_done":   ["task_for_done",   "todo", `${uid}_done`],
        "sub_for_reopen": ["task_for_reopen", "done", `${uid}_reopen`],
        "sub_for_remove": ["task_for_remove", "all",  `${uid}_remove`],
      };
      if (deferredSelects[id]) {
        const [selId, filter, pendingKey] = deferredSelects[id];
        const sel = buildTaskSel(selId, store.tasks, value, filter);
        if (!sel) { await interaction.update({ content: "No matching tasks!", components: [] }); setTimeout(() => interaction.deleteReply().catch(() => {}), 3000); return; }
        pending.set(pendingKey, value);
        return interaction.update({ content: "Which task?", components: [sel] });
      }

      if (id === "task_for_inprogress") {
        await interaction.deferUpdate();
        const subId = pending.get(`${uid}_inprogress`);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) { await interaction.editReply({ content: "Task not found.", components: [] }); setTimeout(() => interaction.deleteReply().catch(() => {}), 3000); return; }
        task.done = false; task.status = 'inprogress';
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        await postLog(guild, logEmbed(0x3498db, `◑ Task in progress — ${sub.emoji} ${sub.label}`, [`**${task.name}**`, `By <@${uid}>`]));
        await interaction.editReply({ content: `◑ **${task.name}** marked In Progress!`, components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 4000);
        return;
      }
      if (id === "task_for_reopen_lead") {
        await interaction.deferUpdate();
        const subId = pending.get(`${uid}_reopen`);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) { await interaction.editReply({ content: "Task not found.", components: [] }); setTimeout(() => interaction.deleteReply().catch(() => {}), 3000); return; }
        task.done = false; task.status = 'todo'; delete task.doneAt;
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        await postLog(guild, logEmbed(0xe67e22, `↩️ Task reopened — ${sub.emoji} ${sub.label}`, [`**${task.name}**`, `By <@${uid}>`]));
        await interaction.editReply({ content: `↩️ **${task.name}** reopened.`, components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 4000);
        return;
      }
      if (id === "task_for_done") {
        await interaction.deferUpdate();
        const subId = pending.get(`${uid}_done`);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) { await interaction.editReply({ content: "Task not found.", components: [] }); setTimeout(() => interaction.deleteReply().catch(() => {}), 3000); return; }
        task.done = true; task.status = 'done'; task.doneAt = Date.now();
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        await postLog(guild, logEmbed(0x2ecc71, `✅ Task done — ${sub.emoji} ${sub.label}`, [`**${task.name}**`, `By <@${uid}>`]));
        await notifyUnblocked(guild, task.id);
        await interaction.editReply({ content: `✅ **${task.name}** marked done!`, components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 4000);
        return;
      }
      if (id === "task_for_reopen") {
        await interaction.deferUpdate();
        const subId = pending.get(`${uid}_reopen`);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) { await interaction.editReply({ content: "Task not found.", components: [] }); setTimeout(() => interaction.deleteReply().catch(() => {}), 3000); return; }
        task.done = false; task.status = 'todo'; delete task.doneAt;
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        await postLog(guild, logEmbed(0xe67e22, `↩️ Task reopened — ${sub.emoji} ${sub.label}`, [`**${task.name}**`, `By <@${uid}>`]));
        await interaction.editReply({ content: `↩️ **${task.name}** reopened.`, components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 4000);
        return;
      }
      if (id === "task_for_remove") {
        await interaction.deferUpdate();
        const subId = pending.get(`${uid}_remove`);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) { await interaction.editReply({ content: "Task not found.", components: [] }); setTimeout(() => interaction.deleteReply().catch(() => {}), 3000); return; }
        // Remove from other tasks' dependencies
        SUBSYSTEMS.forEach(s => { (store.tasks[s.id]||[]).forEach(t => { t.dependsOn = (t.dependsOn||[]).filter(id => id !== task.id); }); });
        store.tasks[subId] = store.tasks[subId].filter((t) => t.id !== value);
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        await postLog(guild, logEmbed(0xe74c3c, `🗑️ Task removed — ${sub.emoji} ${sub.label}`, [`**${task.name}**`, `By <@${uid}>`]));
        await interaction.editReply({ content: `🗑️ **${task.name}** removed.`, components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 4000);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (interaction.customId === "modal_add_member") {
        const name = interaction.fields.getTextInputValue("member_name").trim();
        const mid  = interaction.fields.getTextInputValue("member_id").trim();
        if (!store.members) store.members = {};
        store.members[mid] = name;
        await saveData();
        return replyAndDelete(interaction, `👥 **${name}** added to member list!`);
      }

      if (interaction.customId.startsWith("modal_add_")) {
        const subId     = interaction.customId.replace("modal_add_", "");
        const name      = interaction.fields.getTextInputValue("task_name").trim();
        const rawPri    = interaction.fields.getTextInputValue("priority").trim().toLowerCase();
        const priority  = ["high","medium","low"].includes(rawPri) ? rawPri : "";
        const startDate = interaction.fields.getTextInputValue("start_date").trim();
        const dueDate   = interaction.fields.getTextInputValue("due_date").trim();
        const notes     = interaction.fields.getTextInputValue("notes").trim();
        if (!store.tasks[subId]) store.tasks[subId] = [];
        store.tasks[subId].push({ id: makeId(), name, status: 'todo', done: false, priority, assignees: [], startDate: startDate||null, dueDate: dueDate||null, notes: notes||null, dependsOn: [], checkIns: [], addedAt: Date.now() });
        await updateAll(client);
        const sub    = SUBSYSTEMS.find((s) => s.id === subId);
        const priStr = priority ? ` ${PRI_EMOJI[priority]} ${priority}` : "";
        await postLog(guild, logEmbed(sub.color, `➕ Task added — ${sub.emoji} ${sub.label}`, [`**${name}**${priStr}`, `By <@${uid}>`, dueDate ? `Due: ${dueDate}` : null, `Tip: Add dependencies via the Kanban board`].filter(Boolean)));
        return replyAndDelete(interaction, `${sub.emoji} **${name}** added!${priority ? ` ${PRI_EMOJI[priority]} ${priority}` : ""}${dueDate ? `\n📅 Due: ${dueDate}` : ""}\n🔗 Add dependencies via the Kanban board.`);
      }

      if (interaction.customId.startsWith("modal_budget_")) {
        const groupId = interaction.customId.replace("modal_budget_", "");
        const amount  = parseFloat(interaction.fields.getTextInputValue("amount").replace(/[^0-9.]/g, ""));
        if (isNaN(amount) || amount < 0) return replyAndDelete(interaction, "❌ Invalid amount.");
        const group = FINANCE_GROUPS.find((g) => g.id === groupId);
        store.budgets[groupId] = amount;
        await updateBudgetDashboard(guild);
        await syncBudgetSheet();
        await saveData();
        await postFinanceLog(guild, logEmbed(group.color, `⚙️ Budget updated — ${group.emoji} ${group.label}`, [`New budget: ${fmtAUD(amount)}`, `Set by <@${uid}>`]));
        return replyAndDelete(interaction, `⚙️ **${group.label}** budget set to **${fmtAUD(amount)}**!`);
      }

      if (interaction.customId.startsWith("modal_payment_")) {
        const receiptId = interaction.customId.replace("modal_payment_", "");
        const newStatus = interaction.fields.getTextInputValue("status").trim();
        const expense   = store.expenses.find((e) => e.receiptId === receiptId);
        if (!expense) return replyAndDelete(interaction, "Receipt not found.");
        expense.status = newStatus;
        await updateSheetRow(receiptId, "L", newStatus);
        await saveData();
        await postFinanceLog(guild, logEmbed(0x38bdf8, `💳 Payment updated — ${receiptId}`, [`New status: **${newStatus}**`, `By <@${uid}>`]));
        return replyAndDelete(interaction, `💳 **${receiptId}** updated to **${newStatus}**!`);
      }

      if (interaction.customId.startsWith("modal_expense1_")) {
        const rest      = interaction.customId.replace("modal_expense1_", "");
        const isRequest = rest.endsWith("_req");
        const groupId   = rest.replace("_req", "");
        const item      = interaction.fields.getTextInputValue("item").trim();
        const qty       = parseFloat(interaction.fields.getTextInputValue("qty")) || 1;
        const estCost   = parseFloat(interaction.fields.getTextInputValue("est_cost").replace(/[^0-9.]/g, "")) || 0;
        const finalRaw  = interaction.fields.getTextInputValue("final_cost").trim();
        const finalCost = finalRaw ? parseFloat(finalRaw.replace(/[^0-9.]/g, "")) : null;
        const tempId    = makeId();
        pending.set(`${uid}_expense_${tempId}`, { groupId, isRequest, item, qty, estCost, finalCost });
        await interaction.editReply({
          content: `✅ Basic info saved! Now add receipt details:`,
          components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`open_expense2_${tempId}`).setLabel("📋 Add Receipt Details").setStyle(ButtonStyle.Primary))],
        });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 300000);
        return;
      }

      if (interaction.customId.startsWith("modal_expense2_")) {
        const parts     = interaction.customId.replace("modal_expense2_", "").split("_");
        const tempId    = parts[parts.length - 1];
        const expData   = pending.get(`${uid}_expense_${tempId}`);
        if (!expData) return replyAndDelete(interaction, "Session expired — please start again.");
        pending.delete(`${uid}_expense_${tempId}`);
        const { groupId, isRequest, item, qty, estCost, finalCost } = expData;
        const group         = FINANCE_GROUPS.find((g) => g.id === groupId);
        const receipt       = interaction.fields.getTextInputValue("receipt").trim();
        const reimbursement = interaction.fields.getTextInputValue("reimbursement").trim() || "Pending";
        const justification = interaction.fields.getTextInputValue("justification").trim();
        const estTotal      = qty * estCost;
        const finalTotal    = finalCost !== null ? qty * finalCost : null;
        const member        = await guild.members.fetch(uid);
        const userName      = member.displayName;

        if (isRequest) {
          const reqId = makeId();
          store.pendingRequests.push({ id: reqId, groupId, item, qty, estCost, receipt, reimbursement, justification, userName, userId: uid });
          await postApprovalRequest(guild,
            new EmbedBuilder().setTitle(`📝 Purchase Request — ${group.emoji} ${group.label}`).setColor(group.color)
              .setDescription(`**${item}** x${qty}\nEst. Unit: ${fmtAUD(estCost)}  |  Est. Total: ${fmtAUD(estTotal)}\n${justification ? `Justification: ${justification}\n` : ""}Receipt: ${receipt || "*none yet*"}\nRequested by: <@${uid}>`)
              .setTimestamp(),
            [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`approve_req_${reqId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`reject_req_${reqId}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger),
            )],
            client.user.id
          );
          await saveData();
          return replyAndDelete(interaction, `📝 Purchase request submitted for **${item}** x${qty} (${fmtAUD(estTotal)}) — awaiting approval in #purchase-approvals!`);
        } else {
          const receiptId  = makeReceiptId();
          const costToLog  = finalTotal !== null ? finalTotal : estTotal;
          store.spent[groupId] = (store.spent[groupId] || 0) + costToLog;
          store.expenses.push({ receiptId, item, groupId, status: reimbursement, date: new Date().toLocaleDateString("en-AU") });
          await appendExpenseRow([receiptId, new Date().toLocaleDateString("en-AU"), userName, group.label, item, qty, fmtAUD(estCost), fmtAUD(estTotal), finalCost !== null ? fmtAUD(finalCost) : "", finalTotal !== null ? fmtAUD(finalTotal) : "", "No", reimbursement, receipt, justification, ""]);
          await updateBudgetDashboard(guild);
          await syncBudgetSheet();
          await postFinanceLog(guild, logEmbed(group.color, `💸 Expense logged — ${group.emoji} ${group.label}`,
            [`**${item}** x${qty}`, `Est: ${fmtAUD(estTotal)}${finalTotal !== null ? `  |  Final: ${fmtAUD(finalTotal)}` : ""}`, `By <@${uid}>`, `Receipt ID: ${receiptId}`, `Reimbursement: ${reimbursement}`, justification ? `Justification: ${justification}` : null].filter(Boolean)));
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
