const ALLOWED_ORIGINS = new Set([
  "https://equinetic.pl",
  "https://www.equinetic.pl",
]);

function jsonResponse(
  data,
  {
    status = 200,
    origin = null,
    additionalHeaders = {},
  } = {},
) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...additionalHeaders,
  });

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }

  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    // Endpoint kontrolny.
    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "equinetic-contact-api",
      });
    }

    // Zapytanie wstępne wykonywane przez przeglądarkę.
    if (request.method === "OPTIONS") {
      if (!origin || !ALLOWED_ORIGINS.has(origin)) {
        return jsonResponse(
          { error: "Origin not allowed" },
          { status: 403 },
        );
      }

      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        },
      });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { error: "Method not allowed" },
        {
          status: 405,
          origin,
          additionalHeaders: {
            Allow: "GET, POST, OPTIONS",
          },
        },
      );
    }

    // CORS nie zatrzyma bota, ale blokuje używanie endpointu
    // przez obce strony w przeglądarce.
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse(
        { error: "Origin not allowed" },
        { status: 403 },
      );
    }

    const contentType =
      request.headers.get("Content-Type") || "";

    const supportedContentType =
      contentType.startsWith(
        "application/x-www-form-urlencoded",
      ) ||
      contentType.startsWith("multipart/form-data");

    if (!supportedContentType) {
      return jsonResponse(
        { error: "Unsupported content type" },
        {
          status: 415,
          origin,
        },
      );
    }

    const contentLength = Number(
      request.headers.get("Content-Length") || "0",
    );

    if (contentLength > 20_000) {
      return jsonResponse(
        { error: "Request too large" },
        {
          status: 413,
          origin,
        },
      );
    }

    let data;

    try {
      data = await request.formData();
    } catch {
      return jsonResponse(
        { error: "Invalid form data" },
        {
          status: 400,
          origin,
        },
      );
    }

    // Pole-pułapka ukryte przed normalnym użytkownikiem.
    const website = String(
      data.get("website") || "",
    ).trim();

    if (website) {
      // Bot otrzymuje pozorną odpowiedź sukcesu.
      return jsonResponse(
        {
          ok: true,
          message: "Zgłoszenie zostało wysłane.",
        },
        { origin },
      );
    }

    const name = String(data.get("name") || "").trim();
    const email = String(data.get("email") || "").trim();
    const phone = String(data.get("phone") || "").trim();
    const message = String(
      data.get("message") || "",
    ).trim();

    const emailIsValid =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    if (
      name.length < 2 ||
      name.length > 100 ||
      !emailIsValid ||
      email.length > 254 ||
      phone.length < 5 ||
      phone.length > 40 ||
      message.length < 10 ||
      message.length > 3000
    ) {
      return jsonResponse(
        { error: "Nieprawidłowe dane formularza." },
        {
          status: 400,
          origin,
        },
      );
    }

    const clientIp =
      request.headers.get("CF-Connecting-IP") ||
      "unknown";

    const rateLimitResult =
      await env.CONTACT_RATE_LIMITER.limit({
        key: `contact:${clientIp}`,
      });

    if (!rateLimitResult.success) {
      return jsonResponse(
        {
          error:
            "Wysłano zbyt wiele zgłoszeń. Spróbuj ponownie za minutę.",
        },
        {
          status: 429,
          origin,
          additionalHeaders: {
            "Retry-After": "60",
          },
        },
      );
    }

    const outgoing = new FormData();

    outgoing.set("name", name);
    outgoing.set("email", email);
    outgoing.set("phone", phone);
    outgoing.set("message", message);
    outgoing.set("source", "equinetic.pl");

    const formspreeResponse = await fetch(
      env.FORMSPREE_ENDPOINT,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
        body: outgoing,
      },
    );

    if (!formspreeResponse.ok) {
      console.error(
        "Formspree error:",
        formspreeResponse.status,
        await formspreeResponse.text(),
      );

      return jsonResponse(
        {
          error:
            "Nie udało się wysłać zgłoszenia. Spróbuj ponownie później.",
        },
        {
          status: 502,
          origin,
        },
      );
    }

    return jsonResponse(
      {
        ok: true,
        message: "Zgłoszenie zostało wysłane.",
      },
      { origin },
    );
  },
};
