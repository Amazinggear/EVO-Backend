const fs = require('fs');
const { execSync } = require('child_process');

const envFile = fs.readFileSync('.env', 'utf8');
const lines = envFile.split('\n');

for (const line of lines) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const [key, ...valueParts] = trimmed.split('=');
    const value = valueParts.join('=').replace(/^"/, '').replace(/"$/, '');
    if (key && value) {
      console.log(`Adding ${key}...`);
      try {
        // vercel env add requires interactive input usually, but we can bypass by piping or passing directly?
        // Actually `echo "value" | vercel env add KEY production`
        execSync(`vercel env add ${key} production`, { input: value });
      } catch (e) {
        console.error(`Failed to add ${key}: ${e.message}`);
      }
    }
  }
}
console.log("Done adding env vars.");
