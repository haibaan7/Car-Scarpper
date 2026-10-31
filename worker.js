
const TELEGRAM_API = "https://api.telegram.org";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("TIC Vehicle Bot is running.");
    }

    if (url.pathname === "/setup" && request.method === "POST") {
      if (request.headers.get("X-Setup-Secret") !== env.SETUP_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const result = await telegram(env, "setWebhook", {
        url: `${url.origin}/telegram-webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message"]
      });

      return Response.json(result);
    }

    if (url.pathname === "/telegram-webhook" && request.method === "POST") {
      if (
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
        env.WEBHOOK_SECRET
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      const update = await request.json();

      if (update.message) {
        await handleMessage(update.message, env);
      }

      return new Response("OK");
    }

    return new Response("TIC Vehicle Bot");
  }
};

async function telegram(env, method, body) {
  const response = await fetch(
    `${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(data.description || "Telegram API error");
  }

  return data;
}

async function sendMessage(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  });
}

async function handleMessage(message, env) {
  const userId = String(message.from?.id || "");

  if (env.ALLOWED_USER_ID && userId !== env.ALLOWED_USER_ID) {
    return;
  }

  const chatId = String(message.chat.id);
  const text = message.text || "";
  const caption = message.caption || "";

  if (text === "/start") {
    await sendMessage(env, chatId,
      "TIC Vehicle Auction Bot is ready.\n\nSend an auction link, then send its vehicle photo."
    );
    return;
  }

  const captionUrl = extractUrl(caption);

  if (message.photo?.length) {
    const pending = await env.DB.prepare(
      "SELECT url FROM pending_links WHERE user_id = ?"
    ).bind(userId).first();

    const listingUrl = captionUrl || pending?.url;

    if (!listingUrl) {
      await sendMessage(env, chatId, "Send the auction link first.");
      return;
    }

    try {
      const duplicate = await env.DB.prepare(
        "SELECT url FROM posted_listings WHERE url = ?"
      ).bind(listingUrl).first();

      if (duplicate) {
        await sendMessage(env, chatId, "This listing has already been posted.");
        return;
      }

      const details = await scrapeListing(listingUrl, env);
      const photoId = message.photo[message.photo.length - 1].file_id;

      const payload = {
        chat_id: env.TARGET_CHAT_ID,
        photo: photoId,
        caption: formatListing(details),
        parse_mode: "HTML"
      };

      if (env.TARGET_TOPIC_ID && Number(env.TARGET_TOPIC_ID) > 0) {
        payload.message_thread_id = Number(env.TARGET_TOPIC_ID);
      }

      await telegram(env, "sendPhoto", payload);

      await env.DB.prepare(
        "INSERT OR IGNORE INTO posted_listings (url) VALUES (?)"
      ).bind(listingUrl).run();

      await env.DB.prepare(
        "DELETE FROM pending_links WHERE user_id = ?"
      ).bind(userId).run();

      await sendMessage(env, chatId, "Vehicle listing posted successfully.");

    } catch (error) {
      await sendMessage(env, chatId,
        `Error: ${escapeHtml(error.message)}`
      );
    }

    return;
  }

  const link = extractUrl(text);

  if (link) {
    try {
      await validateAuctionUrl(link, env);

      await env.DB.prepare(`
        INSERT INTO pending_links (user_id, chat_id, url)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          chat_id = excluded.chat_id,
          url = excluded.url,
          created_at = CURRENT_TIMESTAMP
      `).bind(userId, chatId, link).run();

      await sendMessage(env, chatId,
        "Auction link saved. Now send the vehicle photo."
      );
    } catch (error) {
      await sendMessage(env, chatId, escapeHtml(error.message));
    }
  }
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[),.]+$/, "") : null;
}

async function validateAuctionUrl(value, env) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid auction link.");
  }

  if (url.protocol !== "https:") {
    throw new Error("Please use an HTTPS link.");
  }

  const hosts = (env.AUCTION_HOSTS || "")
    .split(",")
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);

  const hostname = url.hostname.toLowerCase();

  if (!hosts.length || !hosts.some(domain =>
    hostname === domain || hostname.endsWith("." + domain)
  )) {
    throw new Error("This auction website is not approved.");
  }

  return url;
}

async function scrapeListing(pageUrl, env) {
  const url = await validateAuctionUrl(pageUrl, env);

  const response = await fetch(url.toString(), {
    redirect: "manual",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; TICVehicleBot/1.0)"
    }
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error("Auction page redirected. Website-specific scraper required.");
  }

  if (!response.ok) {
    throw new Error(`Auction page error: ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("text/html")) {
    throw new Error("Auction page did not return HTML.");
  }

  const html = (await response.text()).slice(0, 1500000);

  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ");

  function get(label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      escaped + "\\s*[:：]?\\s*([^|]{1,100}?)(?=\\s+(?:Year|Color|Chassis|Grade|Engine|Gearbox|Mileage|Equipment|Lot|Auction|Auction Date|Rate|Start Price|Average Price)\\s*[:：]|$)",
      "i"
    );

    return clean.match(regex)?.[1]?.trim() || "---";
  }

  return {
    year: get("Year"),
    color: get("Color"),
    chassis: get("Chassis"),
    grade: get("Grade"),
    engine: get("Engine"),
    gearbox: get("Gearbox"),
    mileage: get("Mileage"),
    equipment: get("Equipment"),
    lot: get("Lot"),
    auction: get("Auction"),
    auctionDate: get("Auction Date"),
    rate: get("Rate"),
    startPrice: get("Start Price"),
    averagePrice: get("Average Price")
  };
}

function formatListing(d) {
  const rows = [
    ["Year", d.year],
    ["Color", d.color],
    ["Chassis", d.chassis],
    ["Grade", d.grade],
    ["Engine", d.engine],
    ["Gearbox", d.gearbox],
    ["Mileage", d.mileage],
    ["Equipment", d.equipment],
    ["Lot", d.lot],
    ["Auction", d.auction],
    ["Auction date", d.auctionDate],
    ["Rate", d.rate],
    ["Start Price", d.startPrice],
    ["Average Price", d.averagePrice]
  ];

  return rows.map(([label, value]) =>
    `<b>${label}:</b> ${escapeHtml(value)}`
  ).join("\n");
}

function escapeHtml(value) {
  return String(value ?? "---")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
