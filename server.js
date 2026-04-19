import express from "express";
import Stripe from "stripe";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const duffelApiKey = process.env.DUFFEL_API_KEY;

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY env var");
}

if (!duffelApiKey) {
  throw new Error("Missing DUFFEL_API_KEY env var");
}

const stripe = new Stripe(stripeSecretKey);

function isValidIata(code) {
  return typeof code === "string" && /^[A-Z]{3}$/.test(code.trim().toUpperCase());
}

function isValidDate(dateStr) {
  if (typeof dateStr !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value >= 0;
}

app.get("/", (req, res) => {
  res.send("PackPath Backend running on Railway 🚀");
});

// ENDPOINT: Crear Intento de Pago
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency = "usd", receiptEmail } = req.body || {};

    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    if (typeof currency !== "string" || currency.trim().length !== 3) {
      return res.status(400).json({ error: "Invalid currency" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: currency.toLowerCase(),
      receipt_email: receiptEmail || undefined,
      automatic_payment_methods: { enabled: true },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error("Stripe Error:", error);
    res.status(500).json({
      error: "Failed to create payment intent",
      details: error.message,
    });
  }
});

// ENDPOINT: Búsqueda de Vuelos
app.post("/search-flights", async (req, res) => {
  try {
    let {
      origin,
      destination,
      departureDate,
      returnDate,
      adults = 1,
      children = 0,
      cabinClass = "economy",
    } = req.body || {};

    origin = origin?.trim().toUpperCase();
    destination = destination?.trim().toUpperCase();

    adults = Number(adults);
    children = Number(children);

    if (!isValidIata(origin)) {
      return res.status(400).json({ error: "Invalid origin IATA" });
    }

    if (!isValidIata(destination)) {
      return res.status(400).json({ error: "Invalid destination IATA" });
    }

    if (!isValidDate(departureDate)) {
      return res.status(400).json({ error: "Invalid departureDate. Use YYYY-MM-DD" });
    }

    if (returnDate && !isValidDate(returnDate)) {
      return res.status(400).json({ error: "Invalid returnDate. Use YYYY-MM-DD" });
    }

    if (!isPositiveInt(adults) || adults < 1) {
      return res.status(400).json({ error: "Adults must be at least 1" });
    }

    if (!isPositiveInt(children)) {
      return res.status(400).json({ error: "Children must be 0 or more" });
    }

    const allowedCabinClasses = ["economy", "premium_economy", "business", "first"];
    if (!allowedCabinClasses.includes(cabinClass)) {
      return res.status(400).json({ error: "Invalid cabinClass" });
    }

    const slices = [
      {
        origin,
        destination,
        departure_date: departureDate,
      },
    ];

    if (returnDate) {
      slices.push({
        origin: destination,
        destination: origin,
        departure_date: returnDate,
      });
    }

    const passengers = [
      ...Array(adults).fill({ type: "adult" }),
      ...Array(children).fill({ type: "child" }),
    ];

    const offerRequestResponse = await fetch("https://api.duffel.com/air/offer_requests", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${duffelApiKey}`,
        "Content-Type": "application/json",
        "Duffel-Version": "v2",
      },
      body: JSON.stringify({
        data: {
          slices,
          passengers,
          cabin_class: cabinClass,
        },
      }),
    });

    const offerRequestJson = await offerRequestResponse.json();

    if (!offerRequestResponse.ok) {
      console.error("Duffel offer request error:", offerRequestJson);
      return res.status(offerRequestResponse.status).json({
        error: "Duffel offer request failed",
        details: offerRequestJson,
      });
    }

    const offerRequestId = offerRequestJson?.data?.id;
    if (!offerRequestId) {
      return res.status(500).json({ error: "Duffel did not return an offer request ID" });
    }

    const offersResponse = await fetch(
      `https://api.duffel.com/air/offers?offer_request_id=${offerRequestId}&limit=20`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${duffelApiKey}`,
          "Duffel-Version": "v2",
        },
      }
    );

    const offersJson = await offersResponse.json();

    if (!offersResponse.ok) {
      console.error("Duffel offers fetch error:", offersJson);
      return res.status(offersResponse.status).json({
        error: "Duffel offers fetch failed",
        details: offersJson,
      });
    }

    return res.json(offersJson);
  } catch (error) {
    console.error("Search Flights Error:", error);
    return res.status(500).json({
      error: "Internal server error while searching flights",
      details: error.message,
    });
  }
});

// ENDPOINT: Crear Orden (Reserva Final)
// Requiere que el pago en Stripe ya esté confirmado
app.post("/duffel/orders", async (req, res) => {
  try {
    const { paymentIntentId, orderPayload } = req.body || {};

    if (!paymentIntentId || typeof paymentIntentId !== "string") {
      return res.status(400).json({ error: "Missing paymentIntentId" });
    }

    if (!orderPayload || !orderPayload.data) {
      return res.status(400).json({ error: "Missing orderPayload.data" });
    }

    if (
      !Array.isArray(orderPayload.data.selected_offers) ||
      orderPayload.data.selected_offers.length === 0
    ) {
      return res.status(400).json({ error: "Missing selected_offers" });
    }

    if (
      !Array.isArray(orderPayload.data.passengers) ||
      orderPayload.data.passengers.length === 0
    ) {
      return res.status(400).json({ error: "Missing passengers" });
    }

    // 1. Verificar que el pago sí se completó
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (!paymentIntent) {
      return res.status(400).json({ error: "PaymentIntent not found" });
    }

    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({
        error: "Payment not completed",
        paymentStatus: paymentIntent.status,
      });
    }

    // 2. Crear orden real en Duffel
    const response = await fetch("https://api.duffel.com/air/orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${duffelApiKey}`,
        "Content-Type": "application/json",
        "Duffel-Version": "v2",
      },
      body: JSON.stringify(orderPayload),
    });

    const json = await response.json();

    if (!response.ok) {
      console.error("Duffel order creation error:", json);
      return res.status(response.status).json({
        error: "Duffel order creation failed",
        details: json,
      });
    }

    return res.status(200).json(json);
  } catch (error) {
    console.error("Duffel Order Error:", error);
    return res.status(500).json({
      error: "Internal server error while creating Duffel order",
      details: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
