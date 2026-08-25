const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

const now = () => new Date().toISOString();
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extra }
});

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function makeId(prefix) {
  return `${prefix}${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 90 + 10)}`;
}

async function telegram(env, text, chatId = env.ADMIN_CHAT_ID) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  } catch (_) {}
}

async function currentUser(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)smm_session=([^;]+)/);
  if (!match) return null;
  const tokenHash = await sha256(match[1]);
  return env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?"
  ).bind(tokenHash, now()).first();
}

const PRICES = {
  "Instagram Followers":20, "Instagram Likes":15, "Instagram Views":10, "Instagram Comments":25,
  "Instagram Story Views":8, "Instagram Reels Views":12, "YouTube Subscribers":30, "YouTube Views":20,
  "YouTube Likes":15, "YouTube Comments":25, "YouTube Watch Hours":40, "Facebook Followers":18,
  "Facebook Likes":12, "Facebook Post Likes":10, "Facebook Comments":20, "Facebook Shares":25,
  "Twitter Followers":25, "Twitter Likes":15, "Twitter Retweets":20, "Twitter Views":10,
  "TikTok Followers":35, "TikTok Likes":18, "TikTok Views":15, "TikTok Comments":28,
  "Telegram Members":22, "Telegram Views":12
};

async function dashboardData(env, user) {
  const [orders, funds] = await Promise.all([
    env.DB.prepare("SELECT order_id AS id,service,link,quantity,amount,status,tracking_id,created_at FROM orders WHERE user_id=? ORDER BY id DESC").bind(user.id).all(),
    env.DB.prepare("SELECT txn_id,amount,utr,status,created_at FROM deposits WHERE user_id=? ORDER BY id DESC").bind(user.id).all()
  ]);
  return {
    user: { userId: user.user_id, username: user.username, mobile: user.mobile, email: user.email, balance: user.balance },
    orders: orders.results || [], funds: funds.results || []
  };
}

async function adminCommand(text, chatId, env) {
  if (String(chatId) !== String(env.ADMIN_CHAT_ID)) return "Unauthorized";
  const [command, arg1, arg2] = String(text).trim().split(/\s+/);
  switch (command?.toLowerCase()) {
    case "/users": {
      const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first();
      return `Users: ${row?.count || 0}`;
    }
    case "/approve": {
      if (!arg1) return "Usage: /approve TXNID";
      const d = await env.DB.prepare("SELECT d.*,u.username FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.txn_id=?").bind(arg1).first();
      if (!d) return "Deposit not found.";
      if (d.status !== "pending") return `Already ${d.status}.`;
      await env.DB.batch([
        env.DB.prepare("UPDATE deposits SET status='approved' WHERE txn_id=? AND status='pending'").bind(arg1),
        env.DB.prepare("UPDATE users SET balance=balance+? WHERE id=?").bind(d.amount, d.user_id)
      ]);
      return `Approved ${arg1}. ₹${Number(d.amount).toFixed(2)} added to @${d.username}.`;
    }
    case "/reject": {
      if (!arg1) return "Usage: /reject TXNID";
      await env.DB.prepare("UPDATE deposits SET status='rejected' WHERE txn_id=? AND status='pending'").bind(arg1).run();
      return `Rejected ${arg1}.`;
    }
    case "/complete": {
      if (!arg1) return "Usage: /complete ORDERID [TRACKING]";
      await env.DB.prepare("UPDATE orders SET status='completed',tracking_id=? WHERE order_id=?").bind(arg2 || "", arg1).run();
      return `Order ${arg1} marked completed.`;
    }
    case "/cancel": {
      if (!arg1) return "Usage: /cancel ORDERID";
      const order = await env.DB.prepare("SELECT * FROM orders WHERE order_id=?").bind(arg1).first();
      if (!order) return "Order not found.";
      if (order.status === "cancelled") return "Already cancelled.";
      await env.DB.batch([
        env.DB.prepare("UPDATE orders SET status='cancelled' WHERE order_id=?").bind(arg1),
        env.DB.prepare("UPDATE users SET balance=balance+? WHERE id=?").bind(order.amount, order.user_id)
      ]);
      return `Order ${arg1} cancelled and ₹${Number(order.amount).toFixed(2)} refunded.`;
    }
    default:
      return "Commands: /users, /approve TXNID, /reject TXNID, /complete ORDERID TRACKING, /cancel ORDERID";
  }
}

async function api(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  if (url.pathname === "/api/health" && request.method === "GET") {
    const db = await env.DB.prepare("SELECT 1 AS ok").first();
    return json({ ok: true, database: db?.ok === 1 });
  }

  if (url.pathname === "/telegram/webhook" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (body.message?.text) {
      const reply = await adminCommand(body.message.text, body.message.chat.id, env);
      await telegram(env, reply, body.message.chat.id);
    }
    return json({ ok: true });
  }

  if (url.pathname === "/api/register" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const mobile = String(body.mobile || "").trim();
    const email = String(body.email || "").trim();
    if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username) || password.length < 6 || !/^\d{10,15}$/.test(mobile) || !/^\S+@\S+\.\S+$/.test(email)) {
      return json({ error: "Invalid registration details" }, 400);
    }
    const exists = await env.DB.prepare("SELECT id FROM users WHERE username=?").bind(username).first();
    if (exists) return json({ error: "Username already exists" }, 409);
    const userId = `USR${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const passwordHash = await sha256(password);
    await env.DB.prepare("INSERT INTO users (id, user_id, username, password_hash, mobile, email, balance, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)")
.bind(userId, userId, username, passwordHash, mobile, email, now()).run();


    await telegram(env, `NEW USER REGISTERED\nUser ID: ${userId}\nUsername: @${username}\nMobile: ${mobile}\nEmail: ${email}`);
    return json({ ok: true, userId }, 201);
  }

  if (url.pathname === "/api/login" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const user = await env.DB.prepare("SELECT * FROM users WHERE username=?").bind(username).first();
    if (!user || user.password_hash !== await sha256(password)) return json({ error: "Invalid username or password" }, 401);
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
      .bind(await sha256(token), user.id, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()).run();
    await telegram(env, `USER LOGGED IN\n@${user.username}\n${user.mobile}\n${user.email}\n${user.user_id}`);
    return json({ ok: true, user: { userId: user.user_id, username: user.username, mobile: user.mobile, email: user.email, balance: user.balance } }, 200, {
      "Set-Cookie": `smm_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
    });
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    const cookie = request.headers.get("Cookie") || "";
    const match = cookie.match(/(?:^|;\s*)smm_session=([^;]+)/);
    if (match) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(match[1])).run();
    return json({ ok: true }, 200, { "Set-Cookie": "smm_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
  }

  const user = await currentUser(request, env);
  if (url.pathname === "/api/me" && request.method === "GET") {
    return user ? json(await dashboardData(env, user)) : json({ error: "Not logged in" }, 401);
  }

  if (!user) return json({ error: "Not logged in" }, 401);

  if (url.pathname === "/api/orders" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const service = String(body.service || "");
    const link = String(body.link || "").trim();
    const quantity = Number(body.quantity);
    const rate = PRICES[service];
    if (!rate || !link || !Number.isInteger(quantity) || quantity < 100) return json({ error: "Invalid order" }, 400);
    const amount = quantity / 1000 * rate;
    if (Number(user.balance) < amount) return json({ error: `Insufficient balance. Need ₹${amount.toFixed(2)}` }, 400);
    const orderId = makeId("ORD");
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET balance=balance-? WHERE id=? AND balance>=?").bind(amount, user.id, amount),
      env.DB.prepare("INSERT INTO orders(order_id,user_id,service,link,quantity,amount,status,tracking_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(orderId, user.id, service, link, quantity, amount, "processing", "", now())
    ]);
    await telegram(env, `NEW ORDER\n${orderId}\n@${user.username}\n${service}\n${link}\nQty: ${quantity}\nAmount: ₹${amount.toFixed(2)}\n\n/complete ${orderId} TRACKING\n/cancel ${orderId}`);
    return json({ ok: true, orderId }, 201);
  }

  if (url.pathname === "/api/deposits" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const amount = Number(body.amount);
    const utr = String(body.utr || "").trim();
    if (!Number.isFinite(amount) || amount < 10 || !utr) return json({ error: "Invalid deposit" }, 400);
    const txnId = makeId("TXN");
    await env.DB.prepare("INSERT INTO deposits(txn_id,user_id,amount,utr,status,created_at) VALUES(?,?,?,?,?,?)")
      .bind(txnId, user.id, amount, utr, "pending", now()).run();
    await telegram(env, `NEW PAYMENT REQUEST\n${txnId}\n@${user.username}\n₹${amount.toFixed(2)}\nUTR: ${utr}\nUPI: ${env.UPI_ID}\n\n/approve ${txnId}\n/reject ${txnId}`);
    return json({ ok: true, txnId, funds: (await dashboardData(env, user)).funds }, 201);
  }

  if (url.pathname === "/api/support" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const subject = String(body.subject || "").trim();
    const message = String(body.message || "").trim();
    if (!subject || !message) return json({ error: "Subject and message are required" }, 400);
    await env.DB.prepare("INSERT INTO tickets(user_id,subject,message,created_at) VALUES(?,?,?,?)")
      .bind(user.id, subject, message, now()).run();
    await telegram(env, `SUPPORT TICKET\n@${user.username}\n${subject}\n${message}`);
    return json({ ok: true }, 201);
  }

  if (url.pathname === "/api/password" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const password = String(body.password || "");
    if (password.length < 6) return json({ error: "Password must be at least 6 characters" }, 400);
    await env.DB.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(await sha256(password), user.id).run();
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/") || url.pathname === "/telegram/webhook") {
        return await api(request, env);
      }
      // Everything else is the frontend. ASSETS is configured in wrangler.toml.
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: error?.message || "Server error" }, 500);
    }
  }
};
