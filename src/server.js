const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { defaultComplaint, orchestrateOpenRouter, orchestrate } = require("./minwon-harness");

const port = Number(process.env.PORT || 3100);
const root = path.resolve(__dirname, "..");

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error("Request body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      const html = fs.readFileSync(path.join(root, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "POST" && req.url === "/api/run") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const input = {
        ...defaultComplaint,
        id: body.id || `MW-${new Date().toISOString().slice(0, 10)}`,
        category: body.category || "custom",
        citizenMessage: body.citizenMessage || defaultComplaint.citizenMessage,
        history: Array.isArray(body.history) && body.history.length ? body.history : [],
      };
      const useOpenRouter = body.mode !== "local";
      const result = useOpenRouter ? await orchestrateOpenRouter(input) : orchestrate(input);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Minwon harness server running: http://localhost:${port}`);
});

