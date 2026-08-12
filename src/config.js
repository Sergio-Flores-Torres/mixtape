import fs from 'node:fs';
import { URL } from 'node:url';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

export default config;
