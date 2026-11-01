// Delays the relay's POST to /native-ack by DELIVERY_ACK_DELAY_MS and logs the reply. Models a daemon busy for that long, or a pump tick
// landing in the window; nothing else changes. The relay's fetch is the global one.
const fs = require("node:fs");
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/native-ack")) {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, Number(process.env.DELIVERY_ACK_DELAY_MS || 0)));
    const res = await real(url, init);
    const text = await res.clone().text();
    fs.appendFileSync(process.env.DELIVERY_ACK_LOG, `${Date.now() - t0}ms abs=${Date.now()} ${res.status} ${text}\n`);
    return res;
  }
  return real(url, init);
};
