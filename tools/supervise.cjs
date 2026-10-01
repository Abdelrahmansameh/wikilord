// Keeps the bot running: if it exits for any reason, start it again after a short pause.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const args = process.argv.slice(2).length ? process.argv.slice(2) : ['--live'];
let stopping = false;

function start() {
  const out = fs.openSync(path.join(root, 'bot.log'), 'a');
  const child = spawn(process.execPath, [path.join('src', 'bot.js'), ...args], { cwd: root, stdio: ['ignore', out, out], env: { ...process.env, WM_SUPERVISED: '1' } });
  child.on('exit', (code) => {
    if (stopping) return;
    fs.appendFileSync(path.join(root, 'bot.log'), new Date().toISOString().slice(11, 23) + ' bot exited (code ' + code + '), restarting in 10s\n');
    setTimeout(start, 10_000);
  });
  process.on('SIGINT', () => { stopping = true; child.kill(); process.exit(0); });
}
start();
