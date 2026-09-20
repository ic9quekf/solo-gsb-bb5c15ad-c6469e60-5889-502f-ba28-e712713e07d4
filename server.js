import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateInput } from './src/engine/validate.js';
import { analyze } from './src/engine/validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/validate', (req, res) => {
  const { data, errors } = validateInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ ok: false, errors });
  }
  try {
    const result = analyze(data);
    return res.json({ ok: true, result });
  } catch (error) {
    return res.status(422).json({ ok: false, errors: [error.message] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`桌游回合规则验证器已启动: http://localhost:${PORT}`);
});
