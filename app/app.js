const crypto = require("crypto");
const express = require("express");

const PORT = Number(process.env.PORT) || 3000;
const APP_NAME = process.env.APP_NAME || "app";
const IMAGE_BYTES = 2 * 1024 * 1024;
const QUERY_DELAY_MS = 2000;

function makeDeterministicPayload(size) {
  const buffer = Buffer.allocUnsafe(size);
  let state = 0x6d2b79f5;
  for (let i = 0; i < size; i += 1) {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    buffer[i] = state & 0xff;
  }
  return buffer;
}

const imagePayload = makeDeterministicPayload(IMAGE_BYTES);
const imageEtag = `"${crypto.createHash("sha256").update(imagePayload).digest("hex")}"`;
const imageLastModified = "Tue, 01 Jan 2026 00:00:00 GMT";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use((req, res, next) => {
  res.set("X-Served-By", APP_NAME);
  next();
});

app.get("/", (req, res) => {
  res.set("Cache-Control", "no-cache");
  res.type("html").send(renderPage());
});

app.get("/assets/image.jpg", (req, res) => {
  if (req.headers["if-none-match"] === imageEtag) {
    res.status(304);
    res.set("ETag", imageEtag);
    res.set("Cache-Control", "public, max-age=86400");
    res.end();
    return;
  }

  res.set("Content-Type", "image/jpeg");
  res.set("Content-Length", String(imagePayload.length));
  res.set("Cache-Control", "public, max-age=86400");
  res.set("ETag", imageEtag);
  res.set("Last-Modified", imageLastModified);
  res.send(imagePayload);
});

app.get("/api/data", async (req, res) => {
  const started = process.hrtime.bigint();
  await delay(QUERY_DELAY_MS);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  res.set("Cache-Control", "private, no-store");
  res.set("CDN-Cache-Control", "no-store");
  res.set("Surrogate-Control", "no-store");
  res.set("Server-Timing", `db;dur=${elapsedMs.toFixed(1)};desc="simulated-query"`);

  res.json({
    ok: true,
    instance: APP_NAME,
    simulatedQueryMs: QUERY_DELAY_MS,
    elapsedMs: Math.round(elapsedMs),
    generatedAt: new Date().toISOString(),
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`${APP_NAME} listening on ${PORT}`);
});

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function renderPage() {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CDN benchmark</title>
  <style>
    body { font-family: sans-serif; margin: 2rem; line-height: 1.5; }
    code { direction: ltr; unicode-bidi: isolate; }
    table { border-collapse: collapse; width: 100%; max-width: 46rem; }
    th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: right; }
    td.num, th.num { direction: ltr; text-align: left; }
    button { margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>CDN benchmark</h1>
  <p>میزبان: <code id="host"></code> — instance: <code>${APP_NAME}</code></p>
  <p>این صفحه <code>/assets/image.jpg</code> (حدود ۲ مگابایت، قابل cache) و <code>/api/data</code> (تأخیر مصنوعی ۲ ثانیه، <code>no-store</code>) را صدا می‌زند. اگر <code>transfer</code> برابر <code>0 (cache)</code> باشد، پاسخ از cache مرورگر آمده است. cache خود CDN هنوز byte می‌فرستد و اثرش را در TTFB می‌بینید.</p>
  <table>
    <thead>
      <tr>
        <th>route</th>
        <th class="num">status</th>
        <th class="num">TTFB (ms)</th>
        <th class="num">total (ms)</th>
        <th class="num">transfer (bytes)</th>
        <th>note</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <pre id="api"></pre>
  <button type="button" id="again">Run again</button>
  <script>
    const host = document.getElementById("host");
    const rows = document.getElementById("rows");
    const apiOut = document.getElementById("api");
    host.textContent = location.host;

    document.getElementById("again").addEventListener("click", run);

    function row(route, status, ttfb, total, transfer, note) {
      const tr = document.createElement("tr");
      [route, status, ttfb, total, transfer, note].forEach((value, index) => {
        const cell = document.createElement("td");
        if (index > 0 && index < 5) cell.className = "num";
        cell.textContent = value;
        tr.appendChild(cell);
      });
      rows.appendChild(tr);
    }

    function timingFor(url) {
      const entries = performance.getEntriesByName(url).filter((entry) => entry.entryType === "resource");
      const entry = entries[entries.length - 1];
      if (!entry) return { ttfb: "-", total: "-", transfer: "-" };
      const ttfb = Math.round(entry.responseStart - entry.startTime);
      const total = Math.round(entry.responseEnd - entry.startTime);
      const transfer = entry.transferSize === 0 ? "0 (cache)" : String(entry.transferSize);
      return { ttfb, total, transfer };
    }

    async function hit(path) {
      const url = new URL(path, location.origin).href;
      performance.clearResourceTimings();
      const started = performance.now();
      const response = await fetch(url);
      const totalFallback = Math.round(performance.now() - started);
      const body = path.endsWith(".jpg") ? await response.arrayBuffer() : await response.json();
      const measured = timingFor(url);
      return {
        status: response.status,
        servedBy: response.headers.get("x-served-by") || "",
        cacheControl: response.headers.get("cache-control") || "",
        ttfb: measured.ttfb,
        total: measured.total === "-" ? totalFallback : measured.total,
        transfer: measured.transfer === "-" ? (body.byteLength || "-") : measured.transfer,
        body
      };
    }

    async function run() {
      rows.replaceChildren();
      apiOut.textContent = "running...";
      try {
        const image = await hit("/assets/image.jpg");
        row(
          "/assets/image.jpg",
          image.status,
          image.ttfb,
          image.total,
          image.transfer,
          image.servedBy + " | " + image.cacheControl
        );
        const data = await hit("/api/data");
        row(
          "/api/data",
          data.status,
          data.ttfb,
          data.total,
          data.transfer,
          data.servedBy + " | " + data.cacheControl
        );
        apiOut.textContent = JSON.stringify(data.body, null, 2);
      } catch (error) {
        apiOut.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    run();
  </script>
</body>
</html>`;
}
