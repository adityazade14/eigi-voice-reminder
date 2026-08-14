# Recall AI — eigi.ai Voice Reminder Hackathon Starter

## Architecture
1. Caller phones the inbound "Setter" eigi.ai agent.
2. Setter calls POST /tools/create-reminder.
3. This Node server stores the reminder locally in data/reminders.json.
4. Every 5 seconds the scheduler checks for due reminders.
5. At the due time, the server calls the eigi.ai outbound-call API.
6. The outbound "Reminder" agent receives reminder_id and reminder_text in metadata.
7. During the call, the user can say "complete it" or "remind me again in five minutes".
8. The agent calls /tools/complete-reminder or /tools/reschedule-reminder.
9. The dashboard updates live.

## Requirements
- Node.js 18+
- eigi.ai account + API key
- Two eigi.ai agents (one inbound, one outbound)
- A configured Plivo or Twilio number/provider
- ngrok (or another HTTPS tunnel) so eigi.ai can reach your local REST tools

## Run
```bash
npm install
cp .env.example .env
# edit .env
npm start
```

Open:
http://localhost:3000

Expose it:
```bash
ngrok http 3000
```

Use the resulting HTTPS base URL in eigi.ai Dynamic API Tools.

## Tool configuration

### create_reminder
POST https://YOUR-NGROK-DOMAIN/tools/create-reminder

LLM parameters:
- phone: string
- reminder_text: string
- remind_at: string, optional ISO 8601
- delay_minutes: number, optional

Assign to the Setter agent.

### complete_reminder
POST https://YOUR-NGROK-DOMAIN/tools/complete-reminder

LLM parameters:
- reminder_id: string

Assign to the Reminder agent.

### reschedule_reminder
POST https://YOUR-NGROK-DOMAIN/tools/reschedule-reminder

LLM parameters:
- reminder_id: string
- new_time: string, optional ISO 8601
- delay_minutes: number, optional

Assign to the Reminder agent.

## .env
EIGI_API_KEY: your vk_... API key
EIGI_REMINDER_AGENT_ID: outbound Reminder agent ID
EIGI_TELEPHONY_PROVIDER: PLIVO or TWILIO

## Quick backend test

Create a reminder 2 minutes from now:
```bash
curl -X POST http://localhost:3000/tools/create-reminder   -H "Content-Type: application/json"   -d '{"phone":"+919876543210","reminder_text":"Hackathon demo","delay_minutes":2}'
```

## Demo
Set a reminder for 1–2 minutes later. Keep the live dashboard visible. When the call arrives, answer it and say:
"Remind me again in two minutes."
The dashboard should immediately move the due time forward.
On the second call say:
"I've done it. Mark it complete."
The dashboard should change to completed.
