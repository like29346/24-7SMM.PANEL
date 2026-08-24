# Pro SMM — नया साफ सेटअप

यह version **एक ही Cloudflare Worker** में frontend + API रखता है। इसलिए अलग `pro-smm-api` Worker की जरूरत नहीं है और `/api/me` का 404 वाला पुराना रास्ता हट जाता है।

## 1. GitHub
पूरे folder को नई repository में upload करें:

- `frontend/index.html`
- `worker/src/index.js`
- `worker/wrangler.toml`
- `migrations/0001_init.sql`
- `schema.sql`
- यह README

## 2. Cloudflare D1
Cloudflare Dashboard → Workers & Pages → D1 SQL Databases → Create database.

Database name:
`pro-smm-db`

नई database की ID copy करें और `worker/wrangler.toml` में:
`PUT_YOUR_D1_DATABASE_ID_HERE`
को अपनी असली ID से replace करें।

## 3. Database tables
अगर Wrangler CLI उपलब्ध है:

`npx wrangler d1 execute pro-smm-db --remote --file=migrations/0001_init.sql`

इसके बाद check:

`npx wrangler d1 execute pro-smm-db --remote --command="SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name;"`

`users`, `sessions`, `deposits`, `orders`, `tickets` दिखने चाहिए।

## 4. Deploy
Project root में:

`npx wrangler login`
`npx wrangler deploy -c worker/wrangler.toml`

इससे एक ही Worker बनेगा:
`pro-smm`

उसका `https://pro-smm.<account-subdomain>.workers.dev` URL खोलें।

## 5. Telegram (optional)
अगर Telegram admin notifications चाहिए:

`npx wrangler secret put TELEGRAM_BOT_TOKEN`

Bot token paste करें। Token को GitHub में कभी upload न करें।

## 6. Test
सबसे पहले:

`https://YOUR-WORKER-URL/api/health`

Expected:
`{"ok":true,"database":true}`

फिर website खोलकर नया registration करें और login करें।

## Important
पुराने database में plain password डालकर login test न करें। इस version में registration password का SHA-256 hash `password_hash` में रखा जाता है। इसलिए नया account website के Register form से बनाएं।

## Existing D1 को delete करना जरूरी नहीं
अगर आप नई database चाहते हैं तो नई D1 बनाकर उसकी ID config में डालें। पुरानी database को बाद में ही delete करें, जब नया setup पूरी तरह test हो जाए।
