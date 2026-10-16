/**
 * Creates monorepo `.backup-dev/volumes/{meta,his,emr,lis}` for local/dev layout.
 */
const fs = require('node:fs');
const path = require('node:path');

const volumesRoot = path.resolve(__dirname, '../../.backup-dev/volumes');
const names = ['meta', 'his', 'emr', 'lis'];

for (const name of names) {
  const dir = path.join(volumesRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const keep = path.join(dir, '.gitkeep');
  if (!fs.existsSync(keep)) {
    fs.writeFileSync(keep, '');
  }
}

console.log(`Ensured backup volumes under ${volumesRoot}`);
