require('dotenv').config();

const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  PermissionsBitField, ChannelType, MessageFlags,
} = require("discord.js");
const Bottleneck = require("bottleneck");
const https = require("https");

const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const JSONBIN_BIN_ID    = process.env.JSONBIN_BIN_ID;
const JSONBIN_API_KEY   = process.env.JSONBIN_API_KEY;
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID;

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

// ─────────────────────────────────────────
//  JSONBIN
// ─────────────────────────────────────────
const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 300 });

function jsonbinRequest(method, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.jsonbin.io",
      path: `/v3/b/${JSONBIN_BIN_ID}`,
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Master-Key": JSONBIN_API_KEY,
        "X-Bin-Versioning": "false",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
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
  const record = res.record || {};
  store = {
    tasks: record.tasks || Object.fromEntries(SUBSYSTEMS.map((s) => [s.id, []])),
    messageId: record.messageId || null,
    leadMessageIds: record.leadMessageIds || {},
    leadChannelIds: record.leadChannelIds || {},
    logChannelId: record.logChannelId || null,
  };
  for (const sub of SUBSYSTEMS) {
    if (!store.tasks[sub.id]) store.tasks[sub.id] = [];
  }
  return store;
}

const saveData = limiter.wrap(async () => {
  await jsonbinRequest("PUT", store);
});

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

// ─────────────────────────────────────────
//  LOGS CHANNEL
// ─────────────────────────────────────────
async function getLogChannel(guild) {
  if (store.logChannelId) {
    try { return await guild.channels.fetch(store.logChannelId); } catch {}
  }
  // Create it if it doesn't exist
  const ch = await guild.channels.create({
    name: "rover-logs",
    type: ChannelType.GuildText,
    topic: "📋 URT Rover Bot — automatic task log",
  });
  store.logChannelId = ch.id;
  await saveData();
  return ch;
}

async function postLog(guild, embed) {
  try {
    const ch = await getLogChannel(guild);
    await ch.send({ embeds: [embed] });
  } catch (e) { console.error("Log post failed:", e.message); }
}

function logEmbed(color, title, lines) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(lines.join("\n"))
    .setTimestamp();
}

// Post full task snapshot — used on startup and for manual restore
async function postSnapshot(guild) {
  const ch = await getLogChannel(guild);
  const lines = SUBSYSTEMS.map((sub) => {
    const list = store.tasks[sub.id] || [];
    if (!list.length) return `${sub.emoji} **${sub.label}** — no tasks`;
    const taskLines = list.map((t) => {
      const who = t.assignees?.length ? t.assignees.map((id) => `<@${id}>`).join(", ") : "*unassigned*";
      return `  ${t.done ? "✅" : "⬜"} ${t.name} — ${who}`;
    });
    return `${sub.emoji} **${sub.label}**\n${taskLines.join("\n")}`;
  });

  const total = Object.values(store.tasks).flat().length;
  const done  = Object.values(store.tasks).flat().filter((t) => t.done).length;

  await ch.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x38bdf8)
        .setTitle("📋 URT Rover — Full Task Snapshot")
        .setDescription(lines.join("\n\n"))
        .setFooter({ text: `${done}/${total} tasks complete — posted on bot startup` })
        .setTimestamp(),
    ],
  });
}

// ─────────────────────────────────────────
//  EMBEDS
// ─────────────────────────────────────────
function buildOverviewEmbed(tasks) {
  let totalDone = 0, totalAll = 0;
  const sections = SUBSYSTEMS.map((sub) => {
    const list  = tasks[sub.id] || [];
    const done  = list.filter((t) => t.done).length;
    const total = list.length;
    totalDone += done; totalAll += total;
    const pct  = total === 0 ? 0 : Math.round((done / total) * 100);
    const bar  = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
    const tick = pct === 100 && total > 0 ? "  ✅" : "";
    return `${sub.emoji} **${sub.label}**\n\`${bar}\` ${String(pct).padStart(3)}%  (${done}/${total})${tick}`;
  });
  const op = totalAll === 0 ? 0 : Math.round((totalDone / totalAll) * 100);
  const ob = "█".repeat(Math.round(op / 10)) + "░".repeat(10 - Math.round(op / 10));
  return new EmbedBuilder()
    .setTitle("🛸  URT ROVER — BUILD STATUS")
    .setColor(0x38bdf8)
    .setDescription(
      `**Overall**\n\`${ob}\` ${op}%  (${totalDone}/${totalAll} tasks)\n\n━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      sections.join("\n\n")
    )
    .setTimestamp()
    .setFooter({ text: "See your subsystem channel for details" });
}

function buildLeadEmbed(sub, tasks) {
  const list      = tasks[sub.id] || [];
  const todo      = list.filter((t) => !t.done);
  const done      = list.filter((t) =>  t.done);
  const total     = list.length;
  const doneCount = done.length;
  const pct       = total === 0 ? 0 : Math.round((doneCount / total) * 100);
  const bar       = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));

  const formatTask = (t) => {
    const who = t.assignees?.length ? t.assignees.map((id) => `<@${id}>`).join(", ") : "*Unassigned*";
    return `> ${t.done ? "✅" : "⬜"} **${t.name}**\n> 👤 ${who}`;
  };

  const todoText = todo.length > 0 ? todo.map(formatTask).join("\n\n") : "*No remaining tasks*";
  const doneText = done.length > 0 ? done.map(formatTask).join("\n\n") : "*None completed yet*";

  return new EmbedBuilder()
    .setTitle(`${sub.emoji}  ${sub.label} — Task Board`)
    .setColor(sub.color)
    .setDescription(`\`${bar}\` ${pct}%  (${doneCount}/${total} tasks complete)`)
    .addFields(
      { name: `📋 Remaining (${todo.length})`, value: todoText.slice(0, 1024) },
      { name: `✅ Completed (${doneCount})`,   value: doneText.slice(0, 1024) },
    )
    .setTimestamp()
    .setFooter({ text: "Use the buttons below to manage tasks" });
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
      .addOptions(SUBSYSTEMS.map((s) =>
        new StringSelectMenuOptionBuilder().setLabel(s.label).setValue(s.id).setEmoji(s.emoji)
      ))
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
        new StringSelectMenuOptionBuilder()
          .setLabel((t.done ? "✅ " : "⬜ ") + t.name.slice(0, 97))
          .setValue(t.id)
      ))
  );
}

function addTaskModal(subId) {
  const sub = SUBSYSTEMS.find((s) => s.id === subId);
  return new ModalBuilder()
    .setCustomId(`modal_add_${subId}`)
    .setTitle(`Add task — ${sub.label}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("task_name").setLabel("Task name")
          .setStyle(TextInputStyle.Short).setPlaceholder("e.g. Assemble wheel mounts")
          .setMaxLength(100).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("assignees").setLabel("Assign to — User IDs (optional)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("Right-click user → Copy User ID, separate with commas")
          .setRequired(false)
      )
    );
}

// ─────────────────────────────────────────
//  UPDATE ALL EMBEDS
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
  try {
    const overviewCh = await client.channels.fetch(STATUS_CHANNEL_ID);
    await updateOverview(overviewCh);
  } catch (e) { console.error("Overview update failed:", e.message); }

  for (const sub of SUBSYSTEMS) {
    const chId = store.leadChannelIds[sub.id];
    if (!chId) continue;
    try {
      const ch = await client.channels.fetch(chId);
      await updateLeadChannel(ch, sub);
    } catch (e) { console.error(`Lead update failed for ${sub.id}:`, e.message); }
  }

  await saveData();
}

// ─────────────────────────────────────────
//  SETUP LEAD CHANNELS
// ─────────────────────────────────────────
async function setupLeadChannels(guild, botUserId) {
  const BOT_PERMS = {
    ViewChannel: true, SendMessages: true,
    ReadMessageHistory: true, EmbedLinks: true,
  };

  let category = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toUpperCase() === "SUBSYSTEM LEADS"
  );
  if (!category) {
    category = await guild.channels.create({ name: "SUBSYSTEM LEADS", type: ChannelType.GuildCategory });
  }

  for (const sub of SUBSYSTEMS) {
    const channelName = sub.id.replace(/_/g, "-") + "-lead";

    if (store.leadChannelIds[sub.id]) {
      try {
        const ch = await guild.channels.fetch(store.leadChannelIds[sub.id]);
        await ch.permissionOverwrites.edit(botUserId, BOT_PERMS);
        console.log(`✅ Fixed permissions: #${ch.name}`);
        continue;
      } catch {
        delete store.leadChannelIds[sub.id];
      }
    }

    const existing = guild.channels.cache.find(
      (c) => c.name === channelName && c.parentId === category.id
    );
    if (existing) {
      await existing.permissionOverwrites.edit(botUserId, BOT_PERMS);
      store.leadChannelIds[sub.id] = existing.id;
      console.log(`✅ Found and fixed: #${channelName}`);
      continue;
    }

    const ch = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `${sub.emoji} ${sub.label} team lead channel`,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        {
          id: botUserId,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.EmbedLinks,
          ],
        },
      ],
    });
    store.leadChannelIds[sub.id] = ch.id;
    console.log(`✅ Created: #${channelName}`);
  }
}

// ─────────────────────────────────────────
//  CLIENT
// ─────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
});

const pending = new Map();

client.once("clientReady", async () => {
  console.log(`✅ URT Bot online as ${client.user.tag}`);
  try {
    const guild = client.guilds.cache.first();
    await loadData();
    await setupLeadChannels(guild, client.user.id);

    // Clear old overview messages
    const overviewCh = await client.channels.fetch(STATUS_CHANNEL_ID);
    const fetched    = await overviewCh.messages.fetch({ limit: 20 });
    for (const msg of fetched.filter((m) => m.author.id === client.user.id).values()) {
      try { await msg.delete(); } catch {}
    }
    store.messageId      = null;
    store.leadMessageIds = {};

    await updateAll(client);

    // Post snapshot to logs channel on every startup
    await postSnapshot(guild);

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

      // Modals MUST come before any defer
      if (id.startsWith("lead_add_")) {
        return interaction.showModal(addTaskModal(id.replace("lead_add_", "")));
      }

      if (id === "refresh") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await updateAll(client);
        return interaction.editReply({ content: "🔄 All channels refreshed!" });
      }

      if (id === "add_task")    return interaction.reply({ content: "Which subsystem?", components: [buildSubSel("sub_for_add")],    flags: MessageFlags.Ephemeral });
      if (id === "mark_done")   return interaction.reply({ content: "Which subsystem?", components: [buildSubSel("sub_for_done")],   flags: MessageFlags.Ephemeral });
      if (id === "reopen_task") return interaction.reply({ content: "Which subsystem?", components: [buildSubSel("sub_for_reopen")], flags: MessageFlags.Ephemeral });
      if (id === "remove_task") return interaction.reply({ content: "Which subsystem?", components: [buildSubSel("sub_for_remove")], flags: MessageFlags.Ephemeral });

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
        const subId = id.replace("lead_remind_", "");
        const sub   = SUBSYSTEMS.find((s) => s.id === subId);
        const todos = (store.tasks[subId] || []).filter((t) => !t.done);
        if (!todos.length) return interaction.reply({ content: "✅ No incomplete tasks — nothing to remind about!", flags: MessageFlags.Ephemeral });

        const assigneeIds = [...new Set(todos.flatMap((t) => t.assignees || []))];
        if (!assigneeIds.length) return interaction.reply({ content: "⚠️ No one is assigned to any incomplete tasks. Use 👤 Assign first!", flags: MessageFlags.Ephemeral });

        const taskList = todos.map((t) => {
          const who = t.assignees?.length ? t.assignees.map((id) => `<@${id}>`).join(", ") : "*unassigned*";
          return `• **${t.name}** — ${who}`;
        }).join("\n");

        // DM each assignee
        let dmCount = 0;
        for (const assigneeId of assigneeIds) {
          try {
            const member = await guild.members.fetch(assigneeId);
            await member.send(
              `📣 **Progress update request — ${sub.emoji} ${sub.label}**\n\n` +
              `Hey ${member.displayName}! Your team lead is asking for a progress update on your assigned tasks:\n\n` +
              `${taskList}\n\n` +
              `Please update the bot in your subsystem lead channel when tasks are done. Thanks!`
            );
            dmCount++;
          } catch { /* user has DMs closed */ }
        }

        // Log it
        await postLog(guild, logEmbed(sub.color,
          `📣 Reminder sent — ${sub.emoji} ${sub.label}`,
          [`Sent by <@${uid}>`, `DMed ${dmCount} member(s)`, "", taskList]
        ));

        return interaction.reply({
          content: `📣 Reminder sent to **${dmCount}** member${dmCount !== 1 ? "s" : ""} via DM!`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    // ── SELECT MENUS ──────────────────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
      const id    = interaction.customId;
      const value = interaction.values[0];

      // Modals must come before any defer
      if (id === "sub_for_add") return interaction.showModal(addTaskModal(value));

      if (id === "task_for_assign") {
        const subId = pending.get(`${uid}_assign`);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) return interaction.update({ content: "Task not found.", components: [] });
        pending.set(`${uid}_assigntask`, value);
        return interaction.showModal(
          new ModalBuilder().setCustomId(`modal_assign_${subId}`).setTitle(`Assign — ${task.name.slice(0, 40)}`)
            .addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("assignees").setLabel("Discord User IDs (comma separated)")
                .setStyle(TextInputStyle.Short).setPlaceholder("Right-click user → Copy User ID")
                .setRequired(true)
            ))
        );
      }

      if (id === "sub_for_done") {
        const sel = buildTaskSel("task_for_done", store.tasks, value, "todo");
        if (!sel) return interaction.update({ content: "No incomplete tasks in that subsystem!", components: [] });
        pending.set(`${uid}_done`, value);
        return interaction.update({ content: "Which task is done?", components: [sel] });
      }

      if (id === "sub_for_reopen") {
        const sel = buildTaskSel("task_for_reopen", store.tasks, value, "done");
        if (!sel) return interaction.update({ content: "No completed tasks in that subsystem!", components: [] });
        pending.set(`${uid}_reopen`, value);
        return interaction.update({ content: "Which task to reopen?", components: [sel] });
      }

      if (id === "sub_for_remove") {
        const sel = buildTaskSel("task_for_remove", store.tasks, value, "all");
        if (!sel) return interaction.update({ content: "No tasks in that subsystem.", components: [] });
        pending.set(`${uid}_remove`, value);
        return interaction.update({ content: "Which task to remove?", components: [sel] });
      }

      if (id === "task_for_done") {
        await interaction.deferUpdate();
        const subId = pending.get(`${uid}_done`);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) return interaction.editReply({ content: "Task not found.", components: [] });
        task.done = true; task.doneAt = Date.now();
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        await postLog(guild, logEmbed(0x2ecc71, `✅ Task completed — ${sub.emoji} ${sub.label}`,
          [`**${task.name}**`, `Marked done by <@${uid}>`]));
        return interaction.editReply({ content: `✅ **${task.name}** marked done in ${sub.emoji} ${sub.label}!`, components: [] });
      }

      if (id === "task_for_reopen") {
        await interaction.deferUpdate();
        const subId = pending.get(`${uid}_reopen`);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) return interaction.editReply({ content: "Task not found.", components: [] });
        task.done = false; delete task.doneAt;
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        await postLog(guild, logEmbed(0xe67e22, `↩️ Task reopened — ${sub.emoji} ${sub.label}`,
          [`**${task.name}**`, `Reopened by <@${uid}>`]));
        return interaction.editReply({ content: `↩️ **${task.name}** reopened in ${sub.emoji} ${sub.label}.`, components: [] });
      }

      if (id === "task_for_remove") {
        await interaction.deferUpdate();
        const subId = pending.get(`${uid}_remove`);
        const task  = store.tasks[subId]?.find((t) => t.id === value);
        if (!task) return interaction.editReply({ content: "Task not found.", components: [] });
        store.tasks[subId] = store.tasks[subId].filter((t) => t.id !== value);
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        await postLog(guild, logEmbed(0xe74c3c, `🗑️ Task removed — ${sub.emoji} ${sub.label}`,
          [`**${task.name}**`, `Removed by <@${uid}>`]));
        return interaction.editReply({ content: `🗑️ **${task.name}** removed from ${sub.emoji} ${sub.label}.`, components: [] });
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
        await postLog(guild, logEmbed(sub.color, `➕ Task added — ${sub.emoji} ${sub.label}`,
          [`**${name}**`, `Added by <@${uid}>`, `Assigned to: ${who}`]));
        return interaction.editReply({ content: `${sub.emoji} **${name}** added to **${sub.label}**!\n👤 ${who}` });
      }

      if (interaction.customId.startsWith("modal_assign_")) {
        const subId     = interaction.customId.replace("modal_assign_", "");
        const taskId    = pending.get(`${uid}_assigntask`);
        const rawIds    = interaction.fields.getTextInputValue("assignees").trim();
        const assignees = rawIds.split(",").map((s) => s.trim()).filter(Boolean);
        const task      = store.tasks[subId]?.find((t) => t.id === taskId);
        if (!task) return interaction.editReply({ content: "Task not found." });
        task.assignees = assignees;
        await updateAll(client);
        const sub = SUBSYSTEMS.find((s) => s.id === subId);
        const who = assignees.map((id) => `<@${id}>`).join(", ");
        await postLog(guild, logEmbed(sub.color, `👤 Task assigned — ${sub.emoji} ${sub.label}`,
          [`**${task.name}**`, `Assigned to: ${who}`, `By <@${uid}>`]));
        return interaction.editReply({ content: `👤 **${task.name}** assigned to ${who} in ${sub.emoji} ${sub.label}!` });
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
