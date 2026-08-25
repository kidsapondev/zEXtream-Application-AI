// Must run before `./config` is imported below — this process runs standalone on the
// host (not through NestJS's ConfigModule), so nothing else loads a .env file into
// process.env.
import 'dotenv/config';
import express from 'express';
import { config } from './config';
import { requireBridgeToken } from './auth-middleware';
import { claudeChat, claudeStatus } from './claude';
import { codexChat, codexStatus } from './codex';
import { registerWorkspaceRoutes } from './workspace-routes';

const app = express();
// 1mb was plenty while every body was a chat prompt; `/workspace/write` now puts whole
// file contents through this same parser, so the limit has to clear `maxFileBytes`
// (default 256_000 bytes) plus room for JSON-string escaping overhead and the request's
// other fields. 4mb keeps a wide margin above the current default cap without opening
// the door to unbounded bodies.
app.use(express.json({ limit: '4mb' }));
app.use(requireBridgeToken(config.bridgeToken));

app.get('/claude/status', (req, res) => {
  claudeStatus(req, res).catch((err) => {
    res.status(500).json({ available: false, error: (err as Error).message });
  });
});
app.post('/claude/chat', (req, res) => {
  claudeChat(req, res).catch((err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
});

app.get('/codex/status', (req, res) => {
  codexStatus(req, res).catch((err) => {
    res.status(500).json({ available: false, error: (err as Error).message });
  });
});
app.post('/codex/chat', (req, res) => {
  codexChat(req, res).catch((err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
});

// Registered after `requireBridgeToken` above, like every other route in this file — the
// workspace filesystem/exec API is at least as sensitive as claude/codex chat (arguably
// more, since it can read/write/execute arbitrary things inside the workspace root), so
// it must never be reachable without the shared bridge token.
registerWorkspaceRoutes(app);

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`host-bridge listening on :${config.port}`);
});
