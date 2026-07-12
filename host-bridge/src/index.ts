// Must run before `./config` is imported below — this process runs standalone on the
// host (not through NestJS's ConfigModule), so nothing else loads a .env file into
// process.env.
import 'dotenv/config';
import express from 'express';
import { config } from './config';
import { requireBridgeToken } from './auth-middleware';
import { claudeChat, claudeStatus } from './claude';
import { codexChat, codexStatus } from './codex';

const app = express();
app.use(express.json({ limit: '1mb' }));
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

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`host-bridge listening on :${config.port}`);
});
