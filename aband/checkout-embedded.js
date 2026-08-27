// ══════════════════════════════════════════════════════════════════
// CONFIG — edit these for your setup
// ══════════════════════════════════════════════════════════════════

// Only these plan IDs can ever be charged through this endpoint.
// Add new plan IDs here explicitly whenever you launch a new product —
// never trust plan_id from the client without checking it against this list.
// Currently backs: essential.html, home.html, performance.html, plus.html
const ALLOWED_PLAN_IDS = [
  "wireless-internet-m1",    // essential.html — Nighthawk M1
  "wireless-internet-orbi",  // home.html      — Orbi LBR20
  "wireless-internet-m6",    // performance.html — Nighthawk M6
  "wireless-internet-m5"     // plus.html      — Nighthawk M5
];

// Restrict CORS to your real site(s). Add more origins if needed
// (e.g. a staging domain), but never use "*" on a payment endpoint.
const ALLOWED_ORIGINS = [
  "https://more4lessplans.ca",
  "https://www.more4lessplans.ca"
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const CB_SITE = env.CHARGEBEE_SITE;
    const CB_API_KEY = env.CHARGEBEE_API_KEY;

    if (!CB_SITE || !CB_API_KEY) {
      return new Response(JSON.stringify({ error: "Server environment variables are not configured." }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    const authHeader = "Basic " + btoa(CB_API_KEY + ":");

    // Small helper so a bad/empty body never throws an uncaught exception —
    // it becomes a clean 400 instead of falling into a generic 500.
    async function safeParseJson(req) {
      try {
        return { ok: true, body: await req.json() };
      } catch (e) {
        return { ok: false };
      }
    }

    // Wraps a Chargebee call with a hard timeout so a hung upstream call
    // can never leave this Worker (and the customer) waiting indefinitely.
    async function fetchChargebee(url, options, timeoutMs = 20000) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // Reads the Chargebee response as JSON without throwing on a bad body.
    // Previously `await cbRes.json()` was called directly, and if Chargebee
    // (or an intermediate proxy/edge) ever returned something that wasn't
    // valid JSON — an HTML error page, an empty body, a gateway timeout page —
    // that parse threw, landed in the outer catch, and got replaced with a
    // generic, unhelpful error message with no way to tell what actually
    // happened, including whether the customer was charged.
    async function safeParseChargebee(cbRes) {
      let text;
      try {
        text = await cbRes.text();
      } catch (e) {
        return { ok: false, status: cbRes.status, raw: null };
      }
      try {
        return { ok: true, data: JSON.parse(text), status: cbRes.status };
      } catch (e) {
        return { ok: false, status: cbRes.status, raw: text.slice(0, 500) };
      }
    }

    // ========================================================================
    // ROUTE 1: Validate Coupon
    // ========================================================================
    if (url.pathname === "/api/validate-coupon" && request.method === "POST") {
      const parsed = await safeParseJson(request);
      if (!parsed.ok) {
        return new Response(JSON.stringify({ valid: false, error: "Invalid request body." }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
      const { coupon_id } = parsed.body;

      if (!coupon_id || typeof coupon_id !== "string" || coupon_id.length > 100) {
        return new Response(JSON.stringify({ valid: false, error: "Missing or invalid coupon code" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      try {
        const cbRes = await fetchChargebee(`https://${CB_SITE}.chargebee.com/api/v2/coupons/${encodeURIComponent(coupon_id)}`, {
          method: "GET",
          headers: {
            "Authorization": authHeader,
            "Accept": "application/json"
          }
        });

        const parsedCb = await safeParseChargebee(cbRes);

        if (!parsedCb.ok) {
          console.error("[validate-coupon] non-JSON Chargebee response", parsedCb.status, parsedCb.raw);
        }

        if (!parsedCb.ok || !cbRes.ok || !parsedCb.data.coupon || parsedCb.data.coupon.status !== "active") {
          return new Response(JSON.stringify({ valid: false, error: "Invalid or expired coupon code." }), {
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const coupon = parsedCb.data.coupon;

        return new Response(JSON.stringify({
          valid: true,
          coupon_id: coupon.id,
          discount_type: coupon.discount_type,
          discount_amount: coupon.discount_amount,
          discount_percent: coupon.discount_percentage,
          description: coupon.name || "Promo code applied!"
        }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });

      } catch (err) {
        const timedOut = err && err.name === "AbortError";
        console.error("[validate-coupon] error", err);
        return new Response(JSON.stringify({
          valid: false,
          error: timedOut ? "Coupon check timed out. Please try again." : "Could not validate coupon right now."
        }), {
          status: timedOut ? 504 : 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // ========================================================================
    // ROUTE 2: Process Checkout (Create Subscription & Customer)
    // Backs essential.html, home.html, performance.html, and plus.html —
    // each device-purchase plan is listed in ALLOWED_PLAN_IDS above.
    // ========================================================================
    if (url.pathname === "/api/checkout-embedded" && request.method === "POST") {
      const parsed = await safeParseJson(request);
      if (!parsed.ok) {
        return new Response(JSON.stringify({ error: "Invalid request body." }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
      const payload = parsed.body;

      // ── Required-field validation ────────────────────────────────
      const missing = [];
      if (!payload.token || typeof payload.token !== "string") missing.push("token");
      if (!payload.plan_id || typeof payload.plan_id !== "string") missing.push("plan_id");
      if (!payload.first_name) missing.push("first_name");
      if (!payload.last_name) missing.push("last_name");
      if (!payload.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) missing.push("email");
      // idempotency_key is optional for now — older frontends that haven't
      // been updated with a generated key yet will still work, they just
      // won't get the double-charge protection below until they send one.

      if (missing.length > 0) {
        return new Response(JSON.stringify({ error: "Missing or invalid fields: " + missing.join(", ") }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // ── Plan allow-list — this is the important one. Never trust
      // plan_id from the client without checking it against a fixed
      // list of plans you actually intend to sell through this endpoint.
      if (!ALLOWED_PLAN_IDS.includes(payload.plan_id)) {
        return new Response(JSON.stringify({ error: "Invalid plan selected." }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // Idempotency key must be a reasonable size (Chargebee caps at 100 chars).
      // Only forwarded to Chargebee if the client actually sent one.
      const idempotencyKey = payload.idempotency_key
        ? String(payload.idempotency_key).slice(0, 100)
        : null;

      try {
        const form = new URLSearchParams();

        form.append("plan_id", payload.plan_id);
        form.append("token_id", payload.token);

        form.append("customer[first_name]", payload.first_name || "");
        form.append("customer[last_name]", payload.last_name || "");
        form.append("customer[email]", payload.email || "");
        form.append("customer[phone]", payload.phone || "");

        if (payload.billing_address) {
          form.append("billing_address[first_name]", payload.first_name || "");
          form.append("billing_address[last_name]", payload.last_name || "");
          form.append("billing_address[line1]", payload.billing_address.line1 || "");
          if (payload.billing_address.line2) form.append("billing_address[line2]", payload.billing_address.line2);
          form.append("billing_address[city]", payload.billing_address.city || "");
          form.append("billing_address[state_code]", payload.billing_address.state_code || "");
          form.append("billing_address[zip]", payload.billing_address.zip || "");
          form.append("billing_address[country]", payload.billing_address.country || "CA");
        }

        if (payload.shipping_address) {
          form.append("shipping_address[first_name]", payload.first_name || "");
          form.append("shipping_address[last_name]", payload.last_name || "");
          form.append("shipping_address[line1]", payload.shipping_address.line1 || "");
          if (payload.shipping_address.line2) form.append("shipping_address[line2]", payload.shipping_address.line2);
          form.append("shipping_address[city]", payload.shipping_address.city || "");
          form.append("shipping_address[state_code]", payload.shipping_address.state_code || "");
          form.append("shipping_address[zip]", payload.shipping_address.zip || "");
          form.append("shipping_address[country]", payload.shipping_address.country || "CA");
        }

        if (payload.coupon_id) {
          form.append("coupon_ids[0]", payload.coupon_id);
        }

        const cbHeaders = {
          "Authorization": authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json"
        };
        // If the same idempotency key is sent twice (a client-side retry
        // after a timeout, a double-click, etc.), Chargebee returns the
        // ORIGINAL subscription instead of creating — and charging — a
        // second one. Only sent when the frontend provides one.
        if (idempotencyKey) {
          cbHeaders["chargebee-idempotency-key"] = idempotencyKey;
        }

        const cbRes = await fetchChargebee(`https://${CB_SITE}.chargebee.com/api/v2/subscriptions`, {
          method: "POST",
          headers: cbHeaders,
          body: form.toString()
        });

        const parsedCb = await safeParseChargebee(cbRes);

        if (!parsedCb.ok) {
          // Log the raw upstream response so you can see in `wrangler tail`
          // exactly what Chargebee (or something in front of it) sent back
          // instead of JSON.
          console.error("[checkout-embedded] non-JSON Chargebee response", parsedCb.status, parsedCb.raw);
          return new Response(JSON.stringify({
            error: "Payment gateway returned an unexpected response. If your card was charged, contact support before retrying — otherwise, please try again."
          }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
        const cbData = parsedCb.data;

        if (!cbRes.ok) {
          return new Response(JSON.stringify({ error: cbData.message || "Payment failed. Please check your card." }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        return new Response(JSON.stringify({ success: true, subscription: cbData.subscription }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });

      } catch (err) {
        const timedOut = err && err.name === "AbortError";
        console.error("[checkout-embedded] error", err);
        return new Response(JSON.stringify({
          error: timedOut
            ? "The payment gateway took too long to respond. If your card was charged, retrying with the same session will not double-charge you — otherwise, please try again."
            : "Internal server error connecting to payment gateway."
        }), {
          status: timedOut ? 504 : 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // Fallback for undefined routes
    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
};
