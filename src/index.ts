import 'dotenv/config';
import { createServer } from './api/server';

const DEFAULT_PORT = 3000;

function resolvePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new RangeError(`PORT must be an integer between 1 and 65535; received ${value}`);
  }

  return port;
}

const port = resolvePort(process.env.PORT);
const app = createServer();

app.listen(port, () => {
  console.log(`claim-processing-system listening on port ${port}`);
});
