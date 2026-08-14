require("dotenv").config();

const express = require("express");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, "data", "reminders.json");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function ensureDb() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]");
}

function readReminders() {
  ensureDb();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8") || "[]");
  } catch {
    return [];
  }
}

function writeReminders(items) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[()\s-]/g, "");
}

function isE164(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

function resolveTime({ remind_at, new_time, delay_minutes }) {
  if (delay_minutes !== undefined && delay_minutes !== null && delay_minutes !== "") {
    const minutes = Number(delay_minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error("delay_minutes must be a positive number");
    }
    return new Date(Date.now() + minutes * 60_000);
  }

  const raw = remind_at || new_time;
  if (!raw) throw new Error("Provide remind_at/new_time or delay_minutes");

  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) {
    throw new Error("Time must be a valid ISO-8601 datetime, e.g. 2026-08-14T13:20:00+05:30");
  }
  return dt;
}

function toolResponse(ok, message, extra = {}) {
  return { ok, message, ...extra };
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "eigi-voice-reminder",
    now: new Date().toISOString()
  });
});

app.get("/api/reminders", (req, res) => {
  const items = readReminders().sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );
  res.json(items);
});

app.post("/tools/create-reminder", (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const reminderText = String(req.body.reminder_text || "").trim();

    if (!reminderText) {
      return res.status(400).json(toolResponse(false, "Reminder text is required."));
    }
    if (!isE164(phone)) {
      return res.status(400).json(
        toolResponse(false, "Phone must be E.164 format, for example +919876543210.")
      );
    }

    const when = resolveTime(req.body);
    if (when.getTime() <= Date.now()) {
      return res.status(400).json(toolResponse(false, "Reminder time must be in the future."));
    }

    const items = readReminders();
    const reminder = {
      id: crypto.randomUUID(),
      phone,
      reminder_text: reminderText,
      remind_at: when.toISOString(),
      status: "scheduled",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_call_at: null,
      last_error: null
    };

    items.push(reminder);
    writeReminders(items);

    return res.json(
      toolResponse(
        true,
        `Reminder created for ${when.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}.`,
        { reminder }
      )
    );
  } catch (err) {
    return res.status(400).json(toolResponse(false, err.message));
  }
});

app.post("/tools/complete-reminder", (req, res) => {
  const id = String(req.body.reminder_id || "");
  const items = readReminders();
  const reminder = items.find((r) => r.id === id);

  if (!reminder) {
    return res.status(404).json(toolResponse(false, "Reminder not found."));
  }

  reminder.status = "completed";
  reminder.completed_at = new Date().toISOString();
  reminder.updated_at = new Date().toISOString();
  writeReminders(items);

  res.json(
    toolResponse(true, "Reminder marked complete.", {
      reminder_id: reminder.id,
      status: reminder.status
    })
  );
});

app.post("/tools/reschedule-reminder", (req, res) => {
  try {
    const id = String(req.body.reminder_id || "");
    const items = readReminders();
    const reminder = items.find((r) => r.id === id);

    if (!reminder) {
      return res.status(404).json(toolResponse(false, "Reminder not found."));
    }

    const when = resolveTime(req.body);
    if (when.getTime() <= Date.now()) {
      return res.status(400).json(toolResponse(false, "New reminder time must be in the future."));
    }

    reminder.remind_at = when.toISOString();
    reminder.status = "scheduled";
    reminder.reschedule_count = Number(reminder.reschedule_count || 0) + 1;
    reminder.updated_at = new Date().toISOString();
    reminder.last_error = null;

    writeReminders(items);

    res.json(
      toolResponse(
        true,
        `Reminder rescheduled for ${when.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}.`,
        { reminder }
      )
    );
  } catch (err) {
    return res.status(400).json(toolResponse(false, err.message));
  }
});

app.post("/api/reminders/:id/complete", (req, res) => {
  req.body.reminder_id = req.params.id;
  const items = readReminders();
  const reminder = items.find((r) => r.id === req.params.id);
  if (!reminder) return res.status(404).json({ ok: false });
  reminder.status = "completed";
  reminder.completed_at = new Date().toISOString();
  reminder.updated_at = new Date().toISOString();
  writeReminders(items);
  res.json({ ok: true, reminder });
});

app.post("/api/reminders/:id/snooze", (req, res) => {
  const items = readReminders();
  const reminder = items.find((r) => r.id === req.params.id);
  if (!reminder) return res.status(404).json({ ok: false });
  const minutes = Number(req.body.minutes || 5);
  reminder.remind_at = new Date(Date.now() + minutes * 60_000).toISOString();
  reminder.status = "scheduled";
  reminder.reschedule_count = Number(reminder.reschedule_count || 0) + 1;
  reminder.updated_at = new Date().toISOString();
  writeReminders(items);
  res.json({ ok: true, reminder });
});

async function triggerEigiCall(reminder) {
  const apiKey = process.env.EIGI_API_KEY;
  const agentId = process.env.EIGI_REMINDER_AGENT_ID;
  const provider = process.env.EIGI_TELEPHONY_PROVIDER || "PLIVO";

  if (!apiKey || !agentId) {
    throw new Error("Missing EIGI_API_KEY or EIGI_REMINDER_AGENT_ID in .env");
  }

  const response = await fetch("https://api.eigi.ai/v1/public/calls/outbound", {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      agent_id: agentId,
      params: [
        {
          mobile_number: reminder.phone,
          metadata: {
            reminder_id: reminder.id,
            reminder_text: reminder.reminder_text,
            scheduled_time: reminder.remind_at
          }
        }
      ],
      telephony_provider: provider
    })
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`eigi.ai ${response.status}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

let schedulerBusy = false;

cron.schedule("*/5 * * * * *", async () => {
  if (schedulerBusy) return;
  schedulerBusy = true;

  try {
    const items = readReminders();
    const now = Date.now();

    for (const reminder of items) {
      if (
        reminder.status === "scheduled" &&
        new Date(reminder.remind_at).getTime() <= now
      ) {
        reminder.status = "calling";
        reminder.updated_at = new Date().toISOString();
        writeReminders(items);

        try {
          const eigiResult = await triggerEigiCall(reminder);
          reminder.status = "notified";
          reminder.last_call_at = new Date().toISOString();
          reminder.eigi_result = eigiResult;
          reminder.last_error = null;
        } catch (err) {
          reminder.status = "scheduled";
          reminder.last_error = err.message;
        }

        reminder.updated_at = new Date().toISOString();
        writeReminders(items);
      }
    }
  } finally {
    schedulerBusy = false;
  }
});

ensureDb();

app.listen(PORT, () => {
  console.log(`Voice Reminder backend running at http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
});
