import { createServer } from "vite";

const PORT = 46399;

process.on("uncaughtException", (e) => {
  console.error("[vite-stable] swallowed uncaughtException:", e && e.message);
});
process.on("unhandledRejection", (e) => {
  console.error("[vite-stable] unhandledRejection:", e && e.message);
});

const server = await createServer({
  server: { port: PORT, strictPort: true, host: true },
});

await server.listen();
console.log(`[vite-stable] ready on http://127.0.0.1:${PORT}`);